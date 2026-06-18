import { getEnvApiKey, getModel, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ModelCredentialProvider,
  RunnerSessionDriver,
} from "./adapter.js";
import {
  loadRecipeSystemPrompt,
  resolveRecipeAgentDefinition,
  type RecipeSystemInstructions,
} from "./recipe-agent.js";
import type { MaterializedRecipe, RunnerLaunchContext } from "./types.js";

export type PiAgentSessionTool = ToolDefinition<any, any, any>;

export interface PiAgentSessionDriverOptions {
  context: RunnerLaunchContext;
  recipe: MaterializedRecipe;
  profileName?: string;
  agentName?: string;
  tools?: PiAgentSessionTool[];
  modelCredentials?: ModelCredentialProvider;
  defaultModel?: string;
}

export interface PromptInput {
  text?: string;
  message?: string;
}

export interface PromptResult {
  events: AgentSessionEvent[];
  messages: unknown[];
}

function modelFromSpec(spec: string): Model<any> {
  const slash = spec.indexOf("/");
  if (slash < 0) {
    throw new Error(
      `Invalid model spec "${spec}" — expected "<provider>/<model_id>"`
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

function promptText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const record = input as PromptInput;
    if (typeof record.text === "string") return record.text;
    if (typeof record.message === "string") return record.message;
  }
  throw new Error("Prompt input must be a string or { text } object");
}

export class PiAgentSessionDriver implements RunnerSessionDriver {
  private session: AgentSession | null = null;
  private events: AgentSessionEvent[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly opts: PiAgentSessionDriverOptions) {}

  async start(): Promise<void> {
    if (this.session) return;

    const { agent, profile } = resolveRecipeAgentDefinition({
      recipeDir: this.opts.recipe.agentDir,
      profileName: this.opts.profileName ?? this.opts.context.profileName,
      agentName: this.opts.agentName ?? this.opts.context.agentName,
    });
    const modelSpec =
      profile?.model?.name ??
      agent?.model?.name ??
      this.opts.defaultModel ??
      "openai/gpt-5.5";
    const model = modelFromSpec(modelSpec);
    const credential = await this.opts.modelCredentials?.resolveCredential({
      provider: model.provider,
      model: model.id,
    });
    const apiKey = credential?.apiKey ?? getEnvApiKey(model.provider);
    if (!apiKey) {
      throw new Error(`${model.provider.toUpperCase()}_API_KEY is required`);
    }

    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(model.provider, apiKey);
    const settingsManager = SettingsManager.create(
      this.opts.context.workspace.workspaceDir,
      this.opts.recipe.agentDir
    );
    const services = await createAgentSessionServices({
      cwd: this.opts.context.workspace.workspaceDir,
      agentDir: this.opts.recipe.agentDir,
      authStorage,
      settingsManager,
      resourceLoaderOptions: {
        systemPromptOverride: base =>
          applySystemInstructions(
            loadRecipeSystemPrompt(this.opts.recipe.agentDir) ?? base,
            agent?.systemInstructions
          ),
      },
    });

    const thinkingLevel = (profile?.model?.thinkingLevel ??
      agent?.model?.thinkingLevel ??
      "low") as ThinkingLevel;
    const allowedTools =
      agent?.tools && agent.tools.length > 0
        ? [...new Set(agent.tools)]
        : this.opts.tools && this.opts.tools.length > 0
          ? this.opts.tools.map(tool => tool.name)
          : undefined;
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(
        this.opts.context.workspace.workspaceDir
      ),
      model,
      thinkingLevel,
      tools: allowedTools,
      customTools: this.opts.tools ?? [],
    });
    this.session = created.session;
    await this.session.bindExtensions({});
    this.unsubscribe = this.session.subscribe(event => {
      this.events.push(event);
    });
  }

  async prompt(input: unknown): Promise<PromptResult> {
    await this.start();
    if (!this.session) throw new Error("Pi session did not start");
    const before = this.events.length;
    await this.session.prompt(promptText(input));
    return {
      events: this.events.slice(before),
      messages: [...this.session.messages],
    };
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
