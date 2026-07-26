import { getEnvApiKey, getModel, type Model } from "@earendil-works/pi-ai/compat";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  type CredentialStore,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { autoResolveInteractions } from "./interactions.js";
import { applyRecipeAgentModelConfigToModel } from "./recipe-model.js";
import { resolveRecipeAgent, type ResolvedRecipeAgent } from "./recipe/resolve.js";
import {
  createAgentSession,
  type RecipeSessionHandle,
} from "./session.js";

export interface CreateRecipeChildAgentRunnerOptions {
  recipeDir: string;
  workspaceDir: string;
  agentName: string;
  /** Already-resolved agent. Pi passes this from its immutable Recipe snapshot. */
  agent?: ResolvedRecipeAgent;
  env?: NodeJS.ProcessEnv;
  credentials?: CredentialStore;
  modelRegistry?: ModelRegistry;
  onAssistantMessage?: (text: string, stream: "delta" | "final") => void;
  onToolEvent?: (event: RecipeChildToolEvent) => void;
}

export interface RecipeChildAgentRunner {
  start(): Promise<void>;
  prompt(prompt: string): Promise<string>;
  steer(message: string): Promise<void>;
  cancel(): Promise<void>;
  shutdown(): Promise<void>;
}

export type CreateRecipeChildAgentRunner = (
  opts: CreateRecipeChildAgentRunnerOptions
) => RecipeChildAgentRunner;

export type RecipeChildToolEvent =
  | {
      type: "start";
      id: string;
      name: string;
      args: unknown;
    }
  | {
      type: "update";
      id: string;
      name: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "end";
      id: string;
      name: string;
      args: unknown;
      result: unknown;
      isError: boolean;
    };

function parseModelSpec(spec: string): {
  provider: string;
  modelId: string;
  lookupProvider: string;
} {
  const slash = spec.indexOf("/");
  if (slash < 0) {
    throw new Error(
      `Invalid recipe model "${spec}" - expected "<provider>/<model_id>"`
    );
  }
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  const lookupProvider = provider === "gemini" ? "google" : provider;
  return { provider, modelId, lookupProvider };
}

function modelFromSpec(
  spec: string,
  modelRegistry: ModelRegistry | undefined
): Model<any> {
  const { modelId, lookupProvider } = parseModelSpec(spec);
  return (
    modelRegistry?.find(lookupProvider, modelId) ??
    getModel(lookupProvider as never, modelId as never)
  );
}

async function credentialsForChildAgent(
  model: Model<any>,
  opts: CreateRecipeChildAgentRunnerOptions
): Promise<CredentialStore> {
  const credentials = opts.credentials ?? new InMemoryCredentialStore();
  if (!opts.credentials) {
    // Resolve the child's API key up front: prefer the host registry (so a
    // key configured inside Pi flows to children), then provider env keys.
    let apiKey: string | undefined;
    let credentialEnv: Record<string, string> | undefined;
    if (opts.modelRegistry) {
      const auth = await opts.modelRegistry.getApiKeyAndHeaders(model);
      if (auth.ok) {
        apiKey = auth.apiKey;
        credentialEnv = auth.env;
        if (auth.headers) {
          model.headers = { ...(model.headers ?? {}), ...auth.headers };
        }
      }
    }
    const env = opts.env ?? process.env;
    apiKey ??=
      getEnvApiKey(model.provider, env as Record<string, string>) ??
      env[`${model.provider.toUpperCase()}_API_KEY`];
    if (!apiKey && Object.keys(model.headers ?? {}).length === 0) {
      throw new Error(
        `${model.provider.toUpperCase()}_API_KEY is required when the background agent is not running inside Pi`
      );
    }
    await credentials.modify(model.provider, async () => ({
      type: "api_key",
      ...(apiKey ? { key: apiKey } : {}),
      ...(credentialEnv ? { env: credentialEnv } : {}),
    }));
  }

  return credentials;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      return record?.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function promptResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  if (typeof record.output === "string") return record.output;
  const messages = Array.isArray(record.messages) ? record.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    if (message.role && message.role !== "assistant") continue;
    const text = contentText(message.content).trim();
    if (text) return text;
  }
  return "";
}

function messageFromEvent(event: AgentSessionEvent): Record<string, unknown> | null {
  const record = asRecord(event);
  const direct = asRecord(record?.message);
  if (direct) return direct;
  const assistantEvent = asRecord(record?.assistantMessageEvent);
  return asRecord(assistantEvent?.partial);
}

class RecipeChildAgentSessionRunner implements RecipeChildAgentRunner {
  private session: AgentSession | null = null;
  private handle: RecipeSessionHandle | null = null;
  private mcpRuntimeDir: string | null = null;
  private assistantStreamedText = false;

  constructor(private readonly opts: CreateRecipeChildAgentRunnerOptions) {}

  private emitAssistantText(text: string, stream: "delta" | "final"): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.opts.onAssistantMessage?.(trimmed, stream);
    if (stream === "delta") this.assistantStreamedText = true;
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    const record = asRecord(event);
    const message = messageFromEvent(event);
    const role = typeof message?.role === "string" ? message.role : undefined;

    if (record?.type === "tool_execution_start") {
      this.opts.onToolEvent?.({
        type: "start",
        id: String(record.toolCallId ?? ""),
        name: String(record.toolName ?? ""),
        args: record.args,
      });
      return;
    }

    if (record?.type === "tool_execution_update") {
      this.opts.onToolEvent?.({
        type: "update",
        id: String(record.toolCallId ?? ""),
        name: String(record.toolName ?? ""),
        args: record.args,
        partialResult: record.partialResult,
      });
      return;
    }

    if (record?.type === "tool_execution_end") {
      this.opts.onToolEvent?.({
        type: "end",
        id: String(record.toolCallId ?? ""),
        name: String(record.toolName ?? ""),
        args: record.args,
        result: record.result,
        isError: record.isError === true,
      });
      return;
    }

    if (record?.type === "message_start" && role === "assistant") {
      this.assistantStreamedText = false;
    }

    const assistantEvent = asRecord(record?.assistantMessageEvent);
    if (
      role === "assistant" &&
      record?.type === "message_update" &&
      assistantEvent?.type === "text_delta" &&
      typeof assistantEvent.delta === "string"
    ) {
      this.emitAssistantText(assistantEvent.delta, "delta");
      return;
    }

    if (
      role === "assistant" &&
      record?.type === "message_end" &&
      !this.assistantStreamedText
    ) {
      this.emitAssistantText(contentText(message?.content), "final");
    }
  }

  async start(): Promise<void> {
    if (this.session) return;

    const resolved =
      this.opts.agent ??
      resolveRecipeAgent({
        recipeDir: this.opts.recipeDir,
        agentName: this.opts.agentName,
      });
    const model = applyRecipeAgentModelConfigToModel(
      modelFromSpec(resolved.modelSpec, this.opts.modelRegistry),
      resolved.modelConfig
    );
    const credentials = await credentialsForChildAgent(model, this.opts);
    this.mcpRuntimeDir = await mkdtemp(join(tmpdir(), "recipes-child-mcp-"));
    try {
      this.handle = await createAgentSession(resolved, {
        cwd: this.opts.workspaceDir,
        env: { ...(this.opts.env ?? process.env) },
        mcpRuntimeDir: this.mcpRuntimeDir,
        credentials,
        modelOverride: model,
        runController: null,
        sessionRole: "subagent",
        onEvent: (event) => this.handleSessionEvent(event),
      });
    } catch (error) {
      await rm(this.mcpRuntimeDir, { recursive: true, force: true });
      this.mcpRuntimeDir = null;
      throw error;
    }
    this.session = this.handle.session;
  }

  async prompt(prompt: string): Promise<string> {
    await this.start();
    if (!this.session) throw new Error("Background agent did not start");
    // Child sessions do not own the root session's interaction lifecycle.
    // Resolve their approval tools internally so they cannot open UI or emit
    // an interrupt that would strand the child waiting for the root user.
    await autoResolveInteractions(() => this.session!.prompt(prompt));
    return promptResultText({ messages: [...this.session.messages] });
  }

  async steer(message: string): Promise<void> {
    await this.start();
    if (!this.session) throw new Error("Background agent did not start");
    await this.session.steer(message);
  }

  async cancel(): Promise<void> {
    await this.session?.abort();
  }

  async shutdown(): Promise<void> {
    await this.handle?.dispose();
    this.handle = null;
    this.session = null;
    if (this.mcpRuntimeDir) {
      await rm(this.mcpRuntimeDir, { recursive: true, force: true });
      this.mcpRuntimeDir = null;
    }
  }
}

export function createRecipeChildAgentRunner(
  opts: CreateRecipeChildAgentRunnerOptions
): RecipeChildAgentRunner {
  return new RecipeChildAgentSessionRunner(opts);
}
