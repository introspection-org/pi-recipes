import { getEnvApiKey, getModel, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  loadRecipeSystemPrompt,
  resolveRecipeAgentDefinition,
  type RecipeSystemInstructions,
} from "./recipe-agent.js";

export interface CreateRecipeChildAgentRunnerOptions {
  recipeDir: string;
  workspaceDir: string;
  agentName: string;
  env?: NodeJS.ProcessEnv;
  onAssistantMessage?: (text: string, stream: "delta" | "final") => void;
}

export interface RecipeChildAgentRunner {
  start(): Promise<void>;
  prompt(task: string): Promise<string>;
  cancel(): Promise<void>;
  shutdown(): Promise<void>;
}

export type CreateRecipeChildAgentRunner = (
  opts: CreateRecipeChildAgentRunnerOptions
) => RecipeChildAgentRunner;

function modelFromSpec(spec: string): Model<any> {
  const slash = spec.indexOf("/");
  if (slash < 0) {
    throw new Error(
      `Invalid recipe model "${spec}" - expected "<provider>/<model_id>"`
    );
  }
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  const lookupProvider = provider === "gemini" ? "google" : provider;
  return getModel(lookupProvider as never, modelId as never);
}

function applySystemInstructions(
  base: string | undefined,
  instructions: RecipeSystemInstructions | undefined
): string | undefined {
  if (!instructions) return base;
  if (instructions.mode === "replace") return instructions.content;
  return [base, instructions.content].filter(Boolean).join("\n\n");
}

function runtimeContextPrompt(workspaceDir: string, recipeDir: string): string {
  return [
    "## Recipe Runtime Context",
    "- Current workspace: " + workspaceDir,
    "- Recipe directory: " + recipeDir,
  ].join("\n");
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
  private unsubscribe: (() => void) | null = null;
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

    const { agentName, agent } = resolveRecipeAgentDefinition({
      recipeDir: this.opts.recipeDir,
      agentName: this.opts.agentName,
    });
    if (!agent) {
      throw new Error(`Recipe agent not found: ${agentName}`);
    }

    const modelSpec = agent.model?.name ?? "openai/gpt-5.5";
    const model = modelFromSpec(modelSpec);
    const env = this.opts.env ?? process.env;
    const apiKey = getEnvApiKey(model.provider) ?? env[`${model.provider.toUpperCase()}_API_KEY`];
    if (!apiKey) {
      throw new Error(`${model.provider.toUpperCase()}_API_KEY is required`);
    }

    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(model.provider, apiKey);
    const services = await createAgentSessionServices({
      cwd: this.opts.workspaceDir,
      agentDir: this.opts.recipeDir,
      authStorage,
      settingsManager: SettingsManager.create(
        this.opts.workspaceDir,
        this.opts.recipeDir
      ),
      resourceLoaderOptions: {
        systemPromptOverride: (base) =>
          applySystemInstructions(
            loadRecipeSystemPrompt(this.opts.recipeDir) ?? base,
            agent.systemInstructions
          ),
        appendSystemPromptOverride: (base) => [
          ...base,
          runtimeContextPrompt(this.opts.workspaceDir, this.opts.recipeDir),
        ],
      },
    });

    const created = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(this.opts.workspaceDir),
      model,
      thinkingLevel: (agent.model?.thinkingLevel ?? "low") as ThinkingLevel,
      tools: agent.tools.length > 0 ? agent.tools : undefined,
    });
    this.session = created.session;
    await this.session.bindExtensions({});
    this.unsubscribe = this.session.subscribe((event) => {
      this.handleSessionEvent(event);
    });
  }

  async prompt(task: string): Promise<string> {
    await this.start();
    if (!this.session) throw new Error("Recipe child agent did not start");
    await this.session.prompt(task);
    return promptResultText({ messages: [...this.session.messages] });
  }

  async cancel(): Promise<void> {
    await this.session?.abort();
  }

  async shutdown(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session?.dispose();
    this.session = null;
  }
}

export function createRecipeChildAgentRunner(
  opts: CreateRecipeChildAgentRunnerOptions
): RecipeChildAgentRunner {
  return new RecipeChildAgentSessionRunner(opts);
}
