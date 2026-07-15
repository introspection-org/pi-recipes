import { getEnvApiKey, getModel, type Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { suppressInterruptResume } from "./interactions.js";
import {
  type RecipeAgentDefinition,
  type RecipeSystemInstructions,
} from "./recipe-agent.js";
import {
  compileRecipe,
  compiledRecipeAgent,
  type CompiledRecipeArtifact,
} from "./recipe-compile.js";
import {
  applyRecipeAgentModelConfigToModel,
  applyRecipeAgentModelConfigToSession,
} from "./recipe-model.js";
export interface CreateRecipeChildAgentRunnerOptions {
  recipeDir: string;
  workspaceDir: string;
  agentName: string;
  compiledRecipe?: CompiledRecipeArtifact;
  hostAdapter?: RecipeHostAdapter;
  env?: NodeJS.ProcessEnv;
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  onAssistantMessage?: (text: string, stream: "delta" | "final") => void;
  onToolEvent?: (event: RecipeChildToolEvent) => void;
}

export interface RecipeAgentSessionPlan {
  artifact: CompiledRecipeArtifact;
  agentName: string;
  agent: RecipeAgentDefinition;
  recipeDir: string;
  workspaceDir: string;
  resources: {
    agents: string[];
    extensions: string[];
    skills: string[];
    prompts: string[];
    mcpManifests: string[];
  };
  modelSpec: string;
  thinkingLevel: ThinkingLevel;
  executableTools: string[];
  recipeSystemPrompt?: string;
  systemInstructions?: RecipeSystemInstructions;
}

/** Host-owned session materialization behind portable recipe semantics. */
export interface RecipeHostAdapter {
  createSession(plan: RecipeAgentSessionPlan): Promise<AgentSession>;
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

function parseModelSpec(spec: string): { provider: string; modelId: string; lookupProvider: string } {
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

function authStorageForChildAgent(
  model: Model<any>,
  opts: CreateRecipeChildAgentRunnerOptions
): AuthStorage {
  if (opts.authStorage) return opts.authStorage;
  if (opts.modelRegistry) return opts.modelRegistry.authStorage;

  const env = opts.env ?? process.env;
  const apiKey = getEnvApiKey(model.provider) ?? env[`${model.provider.toUpperCase()}_API_KEY`];
  if (!apiKey) {
    throw new Error(
      `${model.provider.toUpperCase()}_API_KEY is required when the recipe child agent is not running inside Pi`
    );
  }

  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, apiKey);
  return authStorage;
}

function applySystemInstructions(
  base: string | undefined,
  instructions: RecipeSystemInstructions | undefined
): string | undefined {
  if (!instructions) return base;
  if (instructions.mode === "replace") return instructions.content;
  return [base, instructions.content].filter(Boolean).join("\n\n");
}

function materializedResources(
  recipeDir: string,
  artifact: CompiledRecipeArtifact,
  extensionPaths: string[]
): RecipeAgentSessionPlan["resources"] {
  return {
    agents: artifact.resources.agents.map((path) => resolve(recipeDir, path)),
    extensions: extensionPaths.map((path) => resolve(recipeDir, path)),
    skills: artifact.resources.skills.map((path) => resolve(recipeDir, path)),
    prompts: artifact.resources.prompts.map((path) => resolve(recipeDir, path)),
    mcpManifests: artifact.resources.mcpManifests.map((path) => resolve(recipeDir, path)),
  };
}

export function createRecipeAgentSessionPlan(opts: {
  recipeDir: string;
  workspaceDir: string;
  artifact: CompiledRecipeArtifact;
  agentName?: string;
}): RecipeAgentSessionPlan {
  const compiledAgent = compiledRecipeAgent(opts.artifact, opts.agentName);
  const modelSpec = compiledAgent.definition.model?.name;
  if (!modelSpec) {
    throw new Error(`Recipe agent "${compiledAgent.name}" must declare model.name`);
  }
  return {
    artifact: opts.artifact,
    agentName: compiledAgent.name,
    agent: compiledAgent.definition,
    recipeDir: resolve(opts.recipeDir),
    workspaceDir: resolve(opts.workspaceDir),
    resources: materializedResources(
      opts.recipeDir,
      opts.artifact,
      compiledAgent.extensionPaths
    ),
    modelSpec,
    thinkingLevel: (compiledAgent.definition.model?.thinkingLevel ?? "low") as ThinkingLevel,
    executableTools: [...compiledAgent.executableTools],
    ...(opts.artifact.systemPrompt
      ? { recipeSystemPrompt: opts.artifact.systemPrompt }
      : {}),
    ...(compiledAgent.definition.systemInstructions
      ? { systemInstructions: compiledAgent.definition.systemInstructions }
      : {}),
  };
}

export function createDefaultRecipeHostAdapter(
  opts: Pick<
    CreateRecipeChildAgentRunnerOptions,
    "env" | "authStorage" | "modelRegistry"
  >
): RecipeHostAdapter {
  return {
    async createSession(plan) {
      const model = applyRecipeAgentModelConfigToModel(
        modelFromSpec(plan.modelSpec, opts.modelRegistry),
        plan.agent.modelConfig
      );
      const authStorage = authStorageForChildAgent(model, {
        recipeDir: plan.recipeDir,
        workspaceDir: plan.workspaceDir,
        agentName: plan.agentName,
        ...opts,
      });
      const services = await createAgentSessionServices({
        cwd: plan.workspaceDir,
        agentDir: plan.recipeDir,
        authStorage,
        modelRegistry: opts.modelRegistry,
        settingsManager: SettingsManager.create(plan.workspaceDir, plan.recipeDir),
        resourceLoaderOptions: {
          systemPromptOverride: (base) =>
            applySystemInstructions(
              plan.recipeSystemPrompt ?? base,
              plan.systemInstructions
            ),
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(plan.workspaceDir),
        model,
        thinkingLevel: plan.thinkingLevel,
        tools: plan.executableTools,
      });
      applyRecipeAgentModelConfigToSession(
        created.session,
        plan.agent.modelConfig
      );
      await created.session.bindExtensions({});
      return created.session;
    },
  };
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
    const artifact =
      this.opts.compiledRecipe ?? compileRecipe({ recipeDir: this.opts.recipeDir });
    const plan = createRecipeAgentSessionPlan({
      recipeDir: this.opts.recipeDir,
      workspaceDir: this.opts.workspaceDir,
      artifact,
      agentName: this.opts.agentName,
    });
    const host =
      this.opts.hostAdapter ?? createDefaultRecipeHostAdapter(this.opts);
    this.session = await host.createSession(plan);
    this.unsubscribe = this.session.subscribe((event) => {
      this.handleSessionEvent(event);
    });
  }

  async prompt(task: string): Promise<string> {
    await this.start();
    if (!this.session) throw new Error("Recipe child agent did not start");
    // Interrupt-capable hosts only watch the root session's tool results, so
    // an `askUser()` interrupt emitted inside this child run would pause
    // nothing and strand the child on "Awaiting user response.". Suppress the
    // interrupt branch for the whole run; askUser degrades to plain chat.
    await suppressInterruptResume(() => this.session!.prompt(task));
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
