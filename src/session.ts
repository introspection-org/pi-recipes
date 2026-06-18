import { randomUUID } from "node:crypto";
import { getEnvApiKey, getModel, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionServices,
  parseSkillBlock,
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
import {
  createRecipeAgentsExtension,
  type RecipeAgentRunRequest,
  type RecipeAgentRunResult,
} from "./recipe-agents-extension.js";
import type {
  MaterializedRecipe,
  RunnerLaunchContext,
  RunnerTranscriptEvent,
  RunnerTranscriptSink,
} from "./types.js";

export type PiAgentSessionTool = ToolDefinition<any, any, any>;

export interface RecipeAgentRunRecord {
  agent: string;
  label?: string;
  task: string;
  startedAt: string;
  completedAt: string;
  output: string;
  error?: string;
}

export type RecipeAgentRunSink = (
  record: RecipeAgentRunRecord
) => void | Promise<void>;

export type RecipeAgentSessionRole = "main" | "subagent";

type ChildAgentRunStatus = "running" | "completed" | "failed" | "interrupted";

interface ChildAgentRunState {
  id: string;
  agent: string;
  label?: string;
  task: string;
  status: ChildAgentRunStatus;
  startedAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
  driver: PiAgentSessionDriver;
  promise: Promise<RecipeAgentRunRecord>;
}

export interface PiAgentSessionDriverOptions {
  context: RunnerLaunchContext;
  recipe: MaterializedRecipe;
  profileName?: string;
  agentName?: string;
  tools?: PiAgentSessionTool[];
  modelCredentials?: ModelCredentialProvider;
  defaultModel?: string;
  enableRecipeAgents?: boolean;
  recipeAgentRunSink?: RecipeAgentRunSink;
  transcriptSink?: RunnerTranscriptSink;
  transcriptAgentRole?: RecipeAgentSessionRole;
  transcriptAgentRunId?: string;
  transcriptAgentRunLabel?: string;
  maxChildAgentRuns?: number;
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
      `Invalid model spec "${spec}" - expected "<provider>/<model_id>"`
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

function runtimeContextPrompt(
  context: RunnerLaunchContext,
  recipe: MaterializedRecipe
): string {
  return [
    "## Recipe Runtime Context",
    "- Current workspace: " + context.workspace.workspaceDir,
    "- Recipe directory: " + recipe.agentDir,
    "- Outputs directory: " + context.workspace.outputsDir,
    "- Uploads directory: " + context.workspace.uploadsDir,
    "- Memories directory: " + context.workspace.memoriesDir,
  ].join("\n");
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

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string"
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
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const messageRecord = message as Record<string, unknown>;
    if (messageRecord.role && messageRecord.role !== "assistant") continue;
    const text = contentText(messageRecord.content);
    if (text.trim()) return text.trim();
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageFromEvent(event: AgentSessionEvent): Record<string, unknown> | null {
  const record = asRecord(event);
  const direct = asRecord(record?.message);
  if (direct) return direct;
  const assistantEvent = asRecord(record?.assistantMessageEvent);
  return asRecord(assistantEvent?.partial);
}

function toolCallsFromContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is Record<string, unknown> => {
    const record = asRecord(part);
    return Boolean(record && (record.type === "toolCall" || record.type === "tool_call"));
  });
}

function resultContentText(value: unknown): string {
  const result = asRecord(value);
  if (!result) return "";
  return contentText(result.content);
}

function explicitSkillName(text: string): string | undefined {
  const match = text.trim().match(/^\/skill:([^\s]+)/);
  return match?.[1];
}

function sessionSkills(session: AgentSession): Array<Record<string, unknown>> {
  const skills = (session as unknown as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return [];
  return skills.map(asRecord).filter((skill): skill is Record<string, unknown> => Boolean(skill));
}

const ASSISTANT_TRANSCRIPT_CHUNK_CHARS = 1400;

function stableKeyPart(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class PiAgentSessionDriver implements RunnerSessionDriver {
  private session: AgentSession | null = null;
  private events: AgentSessionEvent[] = [];
  private unsubscribe: (() => void) | null = null;
  private agentName: string | undefined;
  private readonly agentRole: RecipeAgentSessionRole;
  private seenToolCallIds = new Set<string>();
  private seenToolResultIds = new Set<string>();
  private seenSkillUseKeys = new Set<string>();
  private toolCalls = new Map<string, { name?: string; arguments?: unknown }>();
  private assistantDeltaBuffer = "";
  private assistantStreamedText = false;
  private childAgentRuns = new Map<string, ChildAgentRunState>();
  private childAgentRunOrder: string[] = [];
  private readonly maxChildAgentRuns: number;

  constructor(private readonly opts: PiAgentSessionDriverOptions) {
    this.agentRole = opts.transcriptAgentRole ?? "main";
    this.maxChildAgentRuns = opts.maxChildAgentRuns ?? 4;
  }

  private emitTranscript(
    type: RunnerTranscriptEvent["type"],
    data: Record<string, unknown> = {},
    agentName = this.agentName
  ): void {
    const sink = this.opts.transcriptSink;
    if (!sink) return;
    const event: RunnerTranscriptEvent = {
      type,
      runId: this.opts.context.runId,
      occurredAt: new Date(),
      ...(agentName ? { agentName } : {}),
      data: {
        agent_role: this.agentRole,
        ...(agentName ? { agent_name: agentName } : {}),
        ...(this.opts.transcriptAgentRunId
          ? { agent_run_id: this.opts.transcriptAgentRunId }
          : {}),
        ...(this.opts.transcriptAgentRunLabel
          ? { agent_run_label: this.opts.transcriptAgentRunLabel }
          : {}),
        ...data,
      },
    };
    void Promise.resolve(sink.emit(event)).catch(() => {});
  }


  private runningChildAgentCount(): number {
    return [...this.childAgentRuns.values()].filter((run) => run.status === "running").length;
  }

  private childAgentRunDetails(run: ChildAgentRunState): Record<string, unknown> {
    return {
      agent_run_id: run.id,
      agent: run.agent,
      label: run.label ?? run.agent,
      task: run.task,
      status: run.status,
      started_at: run.startedAt,
      completed_at: run.completedAt,
      output: run.output,
      error: run.error,
    };
  }

  private childAgentRunLine(run: ChildAgentRunState): string {
    const label = run.label && run.label !== run.agent ? ` (${run.label})` : "";
    return `${run.id} ${run.agent}${label}: ${run.status}`;
  }

  private findChildAgentRun(id: string | undefined): ChildAgentRunState | undefined {
    if (!id) return undefined;
    return this.childAgentRuns.get(id);
  }

  private childAgentRunSummaries(): Record<string, unknown>[] {
    return this.childAgentRunOrder
      .map((id) => this.childAgentRuns.get(id))
      .filter((run): run is ChildAgentRunState => Boolean(run))
      .map((run) => this.childAgentRunDetails(run));
  }

  private async startRecipeAgentRun(
    request: RecipeAgentRunRequest
  ): Promise<RecipeAgentRunResult> {
    if (!request.name || !request.task) {
      return {
        output: "Starting a recipe agent requires both name and task.",
        details: { error: "missing_name_or_task" },
      };
    }
    if (this.runningChildAgentCount() >= this.maxChildAgentRuns) {
      return {
        output: `Cannot start ${request.name}: ${this.maxChildAgentRuns} recipe agents are already running.`,
        details: {
          error: "max_active_recipe_agents",
          max_active: this.maxChildAgentRuns,
          agent_runs: this.childAgentRunSummaries(),
        },
      };
    }

    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const label = request.label ?? request.name;
    const child = new PiAgentSessionDriver({
      ...this.opts,
      context: {
        ...this.opts.context,
        agentName: request.name,
      },
      agentName: request.name,
      enableRecipeAgents: false,
      transcriptSink: this.opts.transcriptSink,
      transcriptAgentRole: "subagent",
      transcriptAgentRunId: id,
      transcriptAgentRunLabel: label,
    });

    let run!: ChildAgentRunState;
    const promise = (async (): Promise<RecipeAgentRunRecord> => {
      try {
        await child.start();
        const result = await child.prompt(request.task ?? "");
        const output = promptResultText(result) || "(no final response)";
        const completedAt = new Date().toISOString();
        run.status = "completed";
        run.output = output;
        run.completedAt = completedAt;
        const record: RecipeAgentRunRecord = {
          agent: request.name ?? "unknown",
          label: request.label,
          task: request.task ?? "",
          startedAt,
          completedAt,
          output,
        };
        await this.opts.recipeAgentRunSink?.(record);
        this.emitTranscript(
          "agent_run_completed",
          {
            agent_role: "subagent",
            agent_name: request.name,
            agent_run_id: id,
            agent_run_label: label,
            agent: request.name,
            label,
            task: request.task,
            output,
            status: run.status,
            started_at: startedAt,
            completed_at: completedAt,
          },
          request.name
        );
        return record;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const output = "Agent " + request.name + " failed: " + error;
        const completedAt = new Date().toISOString();
        run.status = run.status === "interrupted" ? "interrupted" : "failed";
        run.output = output;
        run.error = error;
        run.completedAt = completedAt;
        const record: RecipeAgentRunRecord = {
          agent: request.name ?? "unknown",
          label: request.label,
          task: request.task ?? "",
          startedAt,
          completedAt,
          output,
          error,
        };
        await this.opts.recipeAgentRunSink?.(record);
        this.emitTranscript(
          "agent_run_completed",
          {
            agent_role: "subagent",
            agent_name: request.name,
            agent_run_id: id,
            agent_run_label: label,
            agent: request.name,
            label,
            task: request.task,
            output,
            error,
            status: run.status,
            started_at: startedAt,
            completed_at: completedAt,
          },
          request.name
        );
        return record;
      } finally {
        await child.shutdown();
      }
    })();

    run = {
      id,
      agent: request.name,
      label,
      task: request.task,
      status: "running",
      startedAt,
      driver: child,
      promise,
    };
    this.childAgentRuns.set(id, run);
    this.childAgentRunOrder.push(id);
    this.emitTranscript(
      "agent_run_started",
      {
        agent_role: "subagent",
        agent_name: request.name,
        agent_run_id: id,
        agent_run_label: label,
        agent: request.name,
        label,
        task: request.task,
        status: run.status,
        started_at: startedAt,
      },
      request.name
    );

    if (request.wait) return this.waitForRecipeAgentRun(id);
    return {
      output: [
        `Started recipe agent ${request.name} as ${id}.`,
        "It is running in the background; launch other agents now if useful, then use action=status or action=wait to collect results.",
      ].join("\n"),
      details: {
        agent_run: this.childAgentRunDetails(run),
        agent_runs: this.childAgentRunSummaries(),
      },
    };
  }

  private recipeAgentRunStatus(id?: string): RecipeAgentRunResult {
    const runs = id
      ? [this.findChildAgentRun(id)].filter((run): run is ChildAgentRunState => Boolean(run))
      : this.childAgentRunOrder
          .map((runId) => this.childAgentRuns.get(runId))
          .filter((run): run is ChildAgentRunState => Boolean(run));
    if (id && runs.length === 0) {
      return {
        output: `Unknown recipe agent run: ${id}`,
        details: { error: "unknown_agent_run", id, agent_runs: this.childAgentRunSummaries() },
      };
    }
    if (runs.length === 0) {
      return { output: "No recipe agent runs have been started yet.", details: { agent_runs: [] } };
    }
    return {
      output: runs.map((run) => this.childAgentRunLine(run)).join("\n"),
      details: { agent_runs: runs.map((run) => this.childAgentRunDetails(run)) },
    };
  }

  private async waitForRecipeAgentRun(id?: string): Promise<RecipeAgentRunResult> {
    const runs = id
      ? [this.findChildAgentRun(id)].filter((run): run is ChildAgentRunState => Boolean(run))
      : this.childAgentRunOrder
          .map((runId) => this.childAgentRuns.get(runId))
          .filter((run): run is ChildAgentRunState => Boolean(run));
    if (id && runs.length === 0) {
      return {
        output: `Unknown recipe agent run: ${id}`,
        details: { error: "unknown_agent_run", id, agent_runs: this.childAgentRunSummaries() },
      };
    }
    if (runs.length === 0) {
      return { output: "No recipe agent runs have been started yet.", details: { agent_runs: [] } };
    }
    await Promise.all(runs.map((run) => run.promise));
    return {
      output: runs
        .map((run) => {
          const title = this.childAgentRunLine(run);
          const body = run.error ? run.error : run.output;
          return body ? `${title}\n${body}` : title;
        })
        .join("\n\n"),
      details: { agent_runs: runs.map((run) => this.childAgentRunDetails(run)) },
    };
  }

  private async interruptRecipeAgentRun(id?: string): Promise<RecipeAgentRunResult> {
    const run = this.findChildAgentRun(id);
    if (!run) {
      return {
        output: id ? `Unknown recipe agent run: ${id}` : "Interrupt requires a recipe agent run id.",
        details: { error: "unknown_agent_run", id, agent_runs: this.childAgentRunSummaries() },
      };
    }
    if (run.status === "running") {
      run.status = "interrupted";
      await run.driver.cancel();
    }
    return {
      output: `Interrupted recipe agent run ${run.id} (${run.agent}).`,
      details: { agent_run: this.childAgentRunDetails(run) },
    };
  }

  private async closeRecipeAgentRun(id?: string): Promise<RecipeAgentRunResult> {
    const run = this.findChildAgentRun(id);
    if (!run) {
      return {
        output: id ? `Unknown recipe agent run: ${id}` : "Close requires a recipe agent run id.",
        details: { error: "unknown_agent_run", id, agent_runs: this.childAgentRunSummaries() },
      };
    }
    if (run.status === "running") {
      run.status = "interrupted";
      await run.driver.cancel();
    }
    await run.driver.shutdown();
    return {
      output: `Closed recipe agent run ${run.id} (${run.agent}).`,
      details: { agent_run: this.childAgentRunDetails(run) },
    };
  }

  private async handleRecipeAgentRequest(
    request: RecipeAgentRunRequest
  ): Promise<RecipeAgentRunResult> {
    switch (request.action) {
      case "start":
        return this.startRecipeAgentRun(request);
      case "status":
        return this.recipeAgentRunStatus(request.id);
      case "wait":
        return this.waitForRecipeAgentRun(request.id);
      case "interrupt":
        return this.interruptRecipeAgentRun(request.id);
      case "close":
        return this.closeRecipeAgentRun(request.id);
    }
  }

  private async waitForRunningChildAgents(): Promise<void> {
    const running = [...this.childAgentRuns.values()].filter((run) => run.status === "running");
    if (running.length === 0) return;
    await Promise.all(running.map((run) => run.promise));
  }

  private toolCallKey(id: string | undefined, name: string | undefined, args?: unknown): string {
    return id ?? [name, stableKeyPart(args)].join(":");
  }

  private emitToolCall(data: {
    id?: unknown;
    name?: unknown;
    arguments?: unknown;
  }): void {
    const id = typeof data.id === "string" ? data.id : undefined;
    const name = typeof data.name === "string" ? data.name : undefined;
    const key = this.toolCallKey(id, name, data.arguments);
    this.toolCalls.set(key, { name, arguments: data.arguments });
    if (this.seenToolCallIds.has(key)) return;
    this.seenToolCallIds.add(key);
    this.emitTranscript("tool_call", {
      id,
      name,
      arguments: data.arguments,
    });
  }

  private emitToolResult(data: {
    id?: unknown;
    name?: unknown;
    text?: unknown;
    isError?: unknown;
    details?: unknown;
  }): void {
    const id = typeof data.id === "string" ? data.id : undefined;
    const name = typeof data.name === "string" ? data.name : undefined;
    const callKey = this.toolCallKey(id, name);
    const fallbackKey = id ? callKey : [name, data.text, data.isError].map((part) => String(part ?? "")).join(":");
    const key = this.toolCalls.has(callKey) ? callKey : fallbackKey;
    if (this.seenToolResultIds.has(key)) return;
    this.seenToolResultIds.add(key);
    const call = this.toolCalls.get(callKey);
    this.emitTranscript("tool_result", {
      id,
      name: name ?? call?.name,
      arguments: call?.arguments,
      text: typeof data.text === "string" ? data.text : "",
      is_error: Boolean(data.isError),
      details: data.details,
    });
  }

  private emitAssistantText(text: string, stream: "delta" | "final"): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.emitTranscript("assistant_message", { text: trimmed, stream });
    if (stream === "delta") this.assistantStreamedText = true;
  }

  private flushAssistantDeltaBuffer(): void {
    if (!this.assistantDeltaBuffer.trim()) {
      this.assistantDeltaBuffer = "";
      return;
    }
    this.emitAssistantText(this.assistantDeltaBuffer, "delta");
    this.assistantDeltaBuffer = "";
  }

  private emitAssistantMessageFromRecord(message: Record<string, unknown>): void {
    this.flushAssistantDeltaBuffer();
    if (this.assistantStreamedText) {
      this.assistantStreamedText = false;
      return;
    }
    const text = contentText(message.content).trim();
    if (text) this.emitAssistantText(text, "final");
  }

  private emitAssistantMessageUpdate(record: Record<string, unknown>): void {
    const assistantEvent = asRecord(record.assistantMessageEvent);
    if (!assistantEvent) return;
    if (assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") {
      this.assistantDeltaBuffer += assistantEvent.delta;
      if (this.assistantDeltaBuffer.length >= ASSISTANT_TRANSCRIPT_CHUNK_CHARS) {
        this.flushAssistantDeltaBuffer();
      }
      return;
    }
    if (assistantEvent.type === "text_end") {
      this.flushAssistantDeltaBuffer();
      if (!this.assistantStreamedText && typeof assistantEvent.content === "string") {
        this.emitAssistantText(assistantEvent.content, "final");
      }
    }
  }

  private emitLoadedSkills(): void {
    if (!this.session) return;
    for (const skill of sessionSkills(this.session)) {
      const name = typeof skill.name === "string" ? skill.name : undefined;
      if (!name) continue;
      this.emitTranscript("skill_loaded", {
        name,
        description: skill.description,
        file_path: skill.filePath,
        base_dir: skill.baseDir,
        source_info: skill.sourceInfo,
        disable_model_invocation: skill.disableModelInvocation,
      });
    }
  }

  private emitSkillUsedFromText(text: string, source: string): void {
    const parsed = parseSkillBlock(text);
    const name = parsed?.name ?? explicitSkillName(text);
    if (!name) return;
    const key = [name, parsed?.location ?? "", text.slice(0, 160)].join(":");
    if (this.seenSkillUseKeys.has(key)) return;
    this.seenSkillUseKeys.add(key);
    this.emitTranscript("skill_used", {
      name,
      location: parsed?.location,
      user_message: parsed?.userMessage,
      source,
    });
  }

  private emitTranscriptFromSessionEvent(event: AgentSessionEvent): void {
    const record = asRecord(event);
    if (record?.type === "tool_execution_start") {
      this.emitToolCall({
        id: record.toolCallId,
        name: record.toolName,
        arguments: record.args,
      });
    }
    if (record?.type === "tool_execution_end") {
      this.emitToolResult({
        id: record.toolCallId,
        name: record.toolName,
        text: resultContentText(record.result),
        isError: record.isError,
        details: asRecord(record.result)?.details,
      });
    }
    if (record?.type === "turn_end") {
      const turnMessage = asRecord(record.message);
      if (turnMessage?.role === "assistant") this.emitAssistantMessageFromRecord(turnMessage);
    }

    const message = messageFromEvent(event);
    if (message) {
      const role = typeof message.role === "string" ? message.role : undefined;
      if (record?.type === "message_start" && role === "assistant") {
        this.assistantDeltaBuffer = "";
        this.assistantStreamedText = false;
      }
      for (const toolCall of toolCallsFromContent(message.content)) {
        this.emitToolCall({
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        });
      }
      if (role === "user" && record?.type === "message_end") {
        this.emitSkillUsedFromText(contentText(message.content), "session_message");
      }
      if (role === "assistant") {
        if (record?.type === "message_update") {
          this.emitAssistantMessageUpdate(record);
        }
        if (record?.type === "message_end") {
          this.emitAssistantMessageFromRecord(message);
        }
      }
      if (role === "toolResult" && record?.type === "message_end") {
        this.emitToolResult({
          id: message.toolCallId,
          name: message.toolName,
          text: contentText(message.content).trim(),
          isError: message.isError,
          details: message.details,
        });
      }
    }
  }

  async start(): Promise<void> {
    if (this.session) return;

    const { agentName, agent, profile } = resolveRecipeAgentDefinition({
      recipeDir: this.opts.recipe.agentDir,
      profileName: this.opts.profileName ?? this.opts.context.profileName,
      agentName: this.opts.agentName ?? this.opts.context.agentName,
    });
    this.agentName = agentName;
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

    const enableRecipeAgents = this.opts.enableRecipeAgents !== false;
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(model.provider, apiKey);
    const settingsManager = SettingsManager.create(
      this.opts.context.workspace.workspaceDir,
      this.opts.recipe.agentDir
    );
    const extensionFactories = enableRecipeAgents
      ? [
          createRecipeAgentsExtension({
            recipeDir: this.opts.recipe.agentDir,
            parentAgentName: agentName,
            runAgent: (request) => this.handleRecipeAgentRequest(request),
          }),
        ]
      : [];
    const services = await createAgentSessionServices({
      cwd: this.opts.context.workspace.workspaceDir,
      agentDir: this.opts.recipe.agentDir,
      authStorage,
      settingsManager,
      resourceLoaderOptions: {
        extensionFactories,
        systemPromptOverride: (base) =>
          applySystemInstructions(
            applySystemInstructions(
              loadRecipeSystemPrompt(this.opts.recipe.agentDir) ?? base,
              profile?.systemInstructions
            ),
            agent?.systemInstructions
          ),
        appendSystemPromptOverride: (base) => [
          ...base,
          runtimeContextPrompt(this.opts.context, this.opts.recipe),
        ],
      },
    });

    const thinkingLevel = (profile?.model?.thinkingLevel ??
      agent?.model?.thinkingLevel ??
      "low") as ThinkingLevel;
    const allowedTools =
      agent?.tools && agent.tools.length > 0
        ? [...new Set([...agent.tools, ...(enableRecipeAgents && agent.subagents.length > 0 ? ["agent"] : [])])]
        : this.opts.tools && this.opts.tools.length > 0
          ? this.opts.tools.map((tool) => tool.name)
          : enableRecipeAgents && agent?.subagents.length
            ? ["agent"]
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
    this.emitLoadedSkills();
    this.emitTranscript("session_started", {
      agent_name: agentName,
      profile_name: profile?.name,
      model: modelSpec,
      workspace_dir: this.opts.context.workspace.workspaceDir,
    });
    this.unsubscribe = this.session.subscribe((event) => {
      this.events.push(event);
      this.emitTranscriptFromSessionEvent(event);
    });
  }

  async prompt(input: unknown): Promise<PromptResult> {
    await this.start();
    if (!this.session) throw new Error("Pi session did not start");
    const before = this.events.length;
    const text = promptText(input);
    this.emitTranscript("user_prompt", { text });
    this.emitSkillUsedFromText(text, "prompt");
    await this.session.prompt(text);
    await this.waitForRunningChildAgents();
    return {
      events: this.events.slice(before),
      messages: [...this.session.messages],
    };
  }

  async cancel(): Promise<void> {
    await this.session?.abort();
  }

  async shutdown(): Promise<void> {
    await this.waitForRunningChildAgents();
    const hadSession = Boolean(this.session);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session?.dispose();
    this.session = null;
    if (hadSession) this.emitTranscript("session_completed", {});
  }
}
