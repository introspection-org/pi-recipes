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
import {
  loadRecipeSystemPrompt,
  REQUIRED_RECIPE_AGENT_FIELDS,
  resolveRecipeAgentDefinition,
  validateResolvedRecipeAgentDefinition,
  type RecipeSystemInstructions,
} from "./recipe-agent.js";
import { executableRecipeToolNames, parseAgentMcpToolRef } from "./mcp.js";

export interface CreateRecipeChildAgentRunnerOptions {
  recipeDir: string;
  workspaceDir: string;
  agentName: string;
  env?: NodeJS.ProcessEnv;
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  onAssistantMessage?: (text: string, stream: "delta" | "final") => void;
  onToolEvent?: (event: RecipeChildToolEvent) => void;
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

function runtimeContextPrompt(
  workspaceDir: string,
  recipeDir: string,
  tools: readonly string[]
): string {
  const mcpRefs = tools
    .map((tool) => parseAgentMcpToolRef(tool))
    .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool));
  const mcpLines = mcpRefs.length > 0
    ? [
        "",
        "## Recipe MCP CLI",
        "- MCP tool policy refs are not directly callable tool names.",
        "- Use the session-local `mcp` command through `bash` for MCP endpoint tools.",
        "- The extension puts `mcp` on PATH; if lookup fails, use `$PI_RECIPES_MCP_BIN_DIR/mcp`.",
        "- Inspect configured sources with `mcp tools sources`.",
        "- Search tools with `mcp tools search \"query\"`.",
        "- Describe a tool with `mcp tools describe <server> <tool>`.",
        "- Call a tool with `mcp call <server> <tool> '<json-args>'`.",
        "- Configured MCP policy refs: " + mcpRefs.map((tool) => `${tool.serverId}/${tool.toolName}`).join(", "),
      ]
    : [];
  return [
    "## Recipe Runtime Context",
    "- Current workspace: " + workspaceDir,
    "- Recipe directory: " + recipeDir,
    ...mcpLines,
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

    const { agentName, agent } = resolveRecipeAgentDefinition({
      recipeDir: this.opts.recipeDir,
      agentName: this.opts.agentName,
    });
    if (!agent) {
      throw new Error(`Recipe agent not found: ${agentName}`);
    }

    const validationFindings = validateResolvedRecipeAgentDefinition({
      recipeDir: this.opts.recipeDir,
      agentName,
      requireExplicitName: true,
      requiredFields: REQUIRED_RECIPE_AGENT_FIELDS,
    });
    if (validationFindings.length > 0) {
      throw new Error(
        validationFindings.map((finding) => finding.message).join("\n")
      );
    }

    const modelSpec = agent.model?.name;
    if (!modelSpec) {
      throw new Error(`Recipe agent "${agentName}" must declare model.name`);
    }
    const model = modelFromSpec(modelSpec, this.opts.modelRegistry);
    const authStorage = authStorageForChildAgent(model, this.opts);
    const services = await createAgentSessionServices({
      cwd: this.opts.workspaceDir,
      agentDir: this.opts.recipeDir,
      authStorage,
      modelRegistry: this.opts.modelRegistry,
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
          runtimeContextPrompt(this.opts.workspaceDir, this.opts.recipeDir, agent.tools),
        ],
      },
    });

    const executableTools = executableRecipeToolNames(agent.tools);
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(this.opts.workspaceDir),
      model,
      thinkingLevel: (agent.model?.thinkingLevel ?? "low") as ThinkingLevel,
      tools: executableTools.length > 0 ? executableTools : undefined,
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
