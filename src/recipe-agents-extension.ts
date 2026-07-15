import {
  defineTool,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { RecipeAgentDefinition } from "./recipe-agent.js";
import type { ResolvedRecipeSession } from "./recipe-session.js";

export const RECIPE_AGENT_UPDATE_EVENT = "introspection:agent-update";

export type RecipeAgentRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "closed";

export interface RecipeAgentNestedToolSummary {
  toolName: string;
  verb: string;
  detail: string;
  toolInput?: Record<string, unknown>;
}

export interface RecipeAgentRunSummary {
  agent_run_id: string;
  invocation_name: string;
  agent_name: string;
  label: string;
  task: string;
  status: RecipeAgentRunStatus;
  started_at: number;
  completed_at?: number;
  last_activity_at: number;
  current_tool?: string;
  output_path?: string;
  artifact_dir?: string;
  status_path?: string;
  events_path?: string;
  output_artifact_path?: string;
  nested_tools?: RecipeAgentNestedToolSummary[];
  output_preview?: string;
  output?: string;
  error?: string;
}

export interface RecipeAgentRunController {
  list(): RecipeAgentRunSummary[];
  get(id: string): RecipeAgentRunSummary | null;
  start(input: {
    name: string;
    task: string;
    label?: string;
    output_path?: string;
    onUpdate?: (summary: RecipeAgentRunSummary) => void | Promise<void>;
  }): Promise<RecipeAgentRunSummary>;
  wait(id: string, signal?: AbortSignal): Promise<RecipeAgentRunSummary>;
  waitFor(
    ids: readonly string[],
    opts: {
      mode: "all" | "first";
      timeoutMs: number;
      signal?: AbortSignal;
    }
  ): Promise<{
    runs: RecipeAgentRunSummary[];
    reason: "settled" | "timeout" | "aborted";
  }>;
  message(id: string, message: string): Promise<RecipeAgentRunSummary>;
  interrupt(id: string): Promise<RecipeAgentRunSummary>;
  close(id: string): Promise<RecipeAgentRunSummary>;
  closeAll(): Promise<void>;
  rehydrate?(): Promise<number>;
}

export interface CreateRecipeAgentRunControllerContext {
  agents: ReadonlyMap<string, RecipeAgentDefinition>;
  emit(summary: RecipeAgentRunSummary): void;
}

export interface CreateRecipeAgentsExtensionOptions {
  recipe: ResolvedRecipeSession;
  createRunController(
    context: CreateRecipeAgentRunControllerContext
  ): RecipeAgentRunController | Promise<RecipeAgentRunController>;
  acknowledgeCompletions?(ids: readonly string[]): void;
  onRehydrated?(count: number): void;
  onError?(operation: "rehydrate" | "shutdown", error: unknown): void;
}

const AgentAction = Type.Union(
  [
    Type.Literal("start"),
    Type.Literal("status"),
    Type.Literal("wait"),
    Type.Literal("message"),
    Type.Literal("interrupt"),
    Type.Literal("close"),
  ],
  {
    description:
      'Control an existing run. Omit action (or use "start") to start a child.',
  }
);

const RecipeAgentToolParams = Type.Object({
  action: Type.Optional(AgentAction),
  name: Type.Optional(
    Type.String({
      description: "Start only. Name of the recipe agent to invoke.",
    })
  ),
  task: Type.Optional(
    Type.String({
      description: "Start only. Concrete, self-contained child instructions.",
    })
  ),
  label: Type.Optional(Type.String()),
  output_path: Type.Optional(Type.String()),
  wait: Type.Optional(Type.Boolean()),
  id: Type.Optional(Type.String()),
  ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Wait only. Run ids to join; omit ids to wait for the first running child.',
    })
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description:
        "Wait only. Maximum milliseconds to block (default 60000, max 600000).",
    })
  ),
  message: Type.Optional(Type.String()),
});

type RecipeAgentToolInput = Static<typeof RecipeAgentToolParams>;

const WAIT_DEFAULT_TIMEOUT_MS = 60_000;
const WAIT_MIN_TIMEOUT_MS = 1_000;
const WAIT_MAX_TIMEOUT_MS = 600_000;

function isTerminal(run: RecipeAgentRunSummary): boolean {
  return run.status !== "running";
}

function runLine(run: RecipeAgentRunSummary): string {
  const label = run.label?.trim() || run.agent_name;
  return `${run.invocation_name} (${run.agent_run_id}) — ${label} [${run.status}]`;
}

function runOutput(run: RecipeAgentRunSummary): string {
  if (run.output?.trim()) return run.output.trim();
  if (run.error) return `Agent failed: ${run.error}`;
  if (run.status === "interrupted") return "Agent interrupted.";
  return `Agent ${run.status}.`;
}

function statusBlock(run: RecipeAgentRunSummary): string {
  return isTerminal(run) ? `${runLine(run)}\n${runOutput(run)}` : runLine(run);
}

function subtask(run: RecipeAgentRunSummary) {
  const nestedTools = [...(run.nested_tools ?? [])];
  if (
    run.current_tool &&
    !nestedTools.some((tool) => tool.toolName === run.current_tool)
  ) {
    nestedTools.push({
      toolName: run.current_tool,
      verb: run.current_tool,
      detail: "",
    });
  }
  return {
    agentName: run.invocation_name,
    label: run.label,
    task: run.task,
    nestedTools,
    transcript: run.output_preview
      ? [{ type: "assistant" as const, text: run.output_preview }]
      : [],
    status: isTerminal(run) ? ("completed" as const) : ("running" as const),
    finishReason: run.status === "completed" ? "stop" : run.error ?? run.status,
    startedAt: run.started_at,
    completedAt: run.completed_at,
  };
}

function errorResult(text: string, controller: RecipeAgentRunController) {
  return {
    content: [{ type: "text" as const, text }],
    details: { agents: controller.list() },
    isError: true,
  };
}

async function executeControlAction(
  params: RecipeAgentToolInput,
  controller: RecipeAgentRunController,
  acknowledge: (ids: readonly string[]) => void,
  signal?: AbortSignal
) {
  if (params.wait !== undefined) {
    return errorResult(
      'The wait flag is only valid when starting a new agent; use action "wait" to join existing runs.',
      controller
    );
  }
  try {
    if (params.action === "status") {
      const runs = params.id
        ? [controller.get(params.id)].filter(
            (run): run is RecipeAgentRunSummary => run !== null
          )
        : controller.list();
      acknowledge(runs.filter(isTerminal).map((run) => run.agent_run_id));
      return {
        content: [
          {
            type: "text" as const,
            text: runs.length ? runs.map(statusBlock).join("\n\n") : "No agent runs.",
          },
        ],
        details: { agents: runs, subtasks: runs.map(subtask) },
      };
    }
    if (params.action === "wait") {
      const explicitIds = params.ids?.length
        ? params.ids
        : params.id
          ? [params.id]
          : null;
      const targets =
        explicitIds ??
        controller
          .list()
          .filter((run) => !isTerminal(run))
          .map((run) => run.agent_run_id);
      if (!targets.length) {
        return {
          content: [{ type: "text" as const, text: "No running agent runs to wait for." }],
          details: { agents: controller.list() },
        };
      }
      const timeoutMs = Math.min(
        WAIT_MAX_TIMEOUT_MS,
        Math.max(WAIT_MIN_TIMEOUT_MS, params.timeout_ms ?? WAIT_DEFAULT_TIMEOUT_MS)
      );
      const { runs, reason } = await controller.waitFor(targets, {
        mode: explicitIds ? "all" : "first",
        timeoutMs,
        signal,
      });
      acknowledge(runs.filter(isTerminal).map((run) => run.agent_run_id));
      const header =
        reason === "settled"
          ? explicitIds
            ? "All waited agent runs settled."
            : "An agent run settled."
          : reason === "timeout"
            ? `Wait timed out after ${Math.round(timeoutMs / 1000)}s; runs continue in the background.`
            : "Wait cancelled — runs continue in the background.";
      return {
        content: [
          {
            type: "text" as const,
            text: [header, runs.map(statusBlock).join("\n\n")]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        details: { agents: runs, subtasks: runs.map(subtask) },
      };
    }
    if (params.action === "message") {
      if (!params.id || !params.message) {
        return errorResult("message requires id and message", controller);
      }
      const run = await controller.message(params.id, params.message);
      return {
        content: [{ type: "text" as const, text: `Sent message to ${runLine(run)}` }],
        details: { agent: run, subtasks: [subtask(run)] },
      };
    }
    if (params.action === "interrupt") {
      if (!params.id) return errorResult("interrupt requires id", controller);
      const run = await controller.interrupt(params.id);
      return {
        content: [{ type: "text" as const, text: `Interrupted ${runLine(run)}` }],
        details: { agent: run, subtasks: [subtask(run)] },
      };
    }
    if (params.action === "close") {
      if (!params.id) {
        await controller.closeAll();
        return {
          content: [{ type: "text" as const, text: "All agent runs closed." }],
          details: { agents: [] },
        };
      }
      const run = await controller.close(params.id);
      return {
        content: [{ type: "text" as const, text: `Closed ${runLine(run)}` }],
        details: { agent: run, subtasks: [subtask(run)] },
      };
    }
    return errorResult(`Unsupported action: ${String(params.action)}`, controller);
  } catch (error) {
    return errorResult(
      `Agent ${params.action} failed: ${error instanceof Error ? error.message : String(error)}`,
      controller
    );
  }
}

function createRecipeAgentTool(
  controller: RecipeAgentRunController,
  agents: ReadonlyMap<string, RecipeAgentDefinition>,
  opts: { acknowledgeCompletions?(ids: readonly string[]): void } = {}
): ToolDefinition {
  const available = [...agents.values()]
    .map((agent) => `${agent.name} (${agent.description ?? "no description"})`)
    .join(", ");
  const acknowledge = opts.acknowledgeCompletions ?? (() => {});
  return defineTool({
    name: "agent",
    label: "Agent",
    description: [
      "Start or manage retained child agents for bounded exploration or verification.",
      "Omit action to start exactly one child with name and task.",
      "Starts run in the background by default; set wait=true only when the parent must block for that new result.",
      'Use action "wait" with ids to join all listed runs, or without ids to wait for the first running child.',
      "Other control actions return immediately and must not include the wait flag.",
      "Use a clear label because status and the UI use it as the handle.",
      `Available agents: ${available || "none"}.`,
    ].join(" "),
    parameters: RecipeAgentToolParams,
    async execute(_id, rawParams, signal, onUpdate) {
      const params = rawParams as RecipeAgentToolInput;
      if (params.action && params.action !== "start") {
        return executeControlAction(params, controller, acknowledge, signal);
      }
      if (!params.name || !params.task) {
        return errorResult("Starting an agent requires name and task.", controller);
      }
      if (!agents.has(params.name)) {
        return errorResult(
          `Unknown agent "${params.name}". Available: ${[...agents.keys()].join(", ")}`,
          controller
        );
      }
      const started = await controller.start({
        name: params.name,
        task: params.task,
        label: params.label,
        output_path: params.output_path,
        onUpdate(run) {
          return onUpdate?.({
            content: [{ type: "text" as const, text: "" }],
            details: { subtasks: [subtask(run)] },
          });
        },
      });
      onUpdate?.({
        content: [{ type: "text" as const, text: "" }],
        details: { subtasks: [subtask(started)] },
      });
      if (!params.wait) {
        return {
          content: [{ type: "text" as const, text: `Started ${runLine(started)}` }],
          details: { agent: started, subtasks: [subtask(started)] },
        };
      }
      let completed: RecipeAgentRunSummary;
      try {
        completed = await controller.wait(started.agent_run_id, signal);
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Agent wait failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: { agent: started, subtasks: [subtask(started)] },
          isError: true,
        };
      }
      if (!isTerminal(completed)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Wait cancelled — ${runLine(completed)} is still running in the background. Use action "status" to check on it.`,
            },
          ],
          details: { agent: completed, subtasks: [subtask(completed)] },
        };
      }
      acknowledge([completed.agent_run_id]);
      return {
        content: [
          {
            type: "text" as const,
            text: `[${completed.invocation_name}] ${runOutput(completed)}`,
          },
        ],
        details: { agent: completed, subtasks: [subtask(completed)] },
      };
    },
  });
}

/** Register portable recipe-agent behavior as an ordinary Pi extension. */
export function createRecipeAgentsExtension(
  opts: CreateRecipeAgentsExtensionOptions
): ExtensionFactory {
  return async (pi) => {
    const agents = opts.recipe.subagents;
    if (agents.size === 0) return;
    const controller = await opts.createRunController({
      agents,
      emit(summary) {
        pi.events.emit(RECIPE_AGENT_UPDATE_EVENT, summary);
      },
    });
    try {
      const restored = (await controller.rehydrate?.()) ?? 0;
      if (restored > 0) opts.onRehydrated?.(restored);
    } catch (error) {
      opts.onError?.("rehydrate", error);
    }
    pi.registerTool(
      createRecipeAgentTool(controller, agents, {
        acknowledgeCompletions: opts.acknowledgeCompletions,
      })
    );
    pi.on("session_shutdown", async () => {
      try {
        await controller.closeAll();
      } catch (error) {
        opts.onError?.("shutdown", error);
      }
    });
  };
}
