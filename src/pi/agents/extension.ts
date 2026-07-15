import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { RecipeAgentDefinition } from "../../recipe-agent.js";

export type AgentRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "closed";

export interface AgentNestedToolSummary {
  toolName: string;
  verb: string;
  detail: string;
  toolInput?: Record<string, unknown>;
}

export interface AgentRunSummary {
  agent_run_id: string;
  invocation_name: string;
  agent_name: string;
  label: string;
  prompt: string;
  status: AgentRunStatus;
  started_at: number;
  completed_at?: number;
  last_activity_at: number;
  current_tool?: string;
  output_path?: string;
  nested_tools?: AgentNestedToolSummary[];
  output_preview?: string;
  output?: string;
  error?: string;
}

export interface AgentRunController {
  list(): AgentRunSummary[];
  get(id: string): AgentRunSummary | null;
  start(input: {
    name: string;
    prompt: string;
    label?: string;
    output_path?: string;
    onUpdate?: (summary: AgentRunSummary) => void | Promise<void>;
  }): Promise<AgentRunSummary>;
  waitFor(
    ids: readonly string[],
    opts: {
      mode: "all" | "first";
      timeoutMs: number;
      signal?: AbortSignal;
    }
  ): Promise<{
    runs: AgentRunSummary[];
    reason: "settled" | "timeout" | "aborted";
  }>;
  message(id: string, message: string): Promise<AgentRunSummary>;
  interrupt(id: string): Promise<AgentRunSummary>;
  close(id: string): Promise<AgentRunSummary>;
  closeAll(): Promise<void>;
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

const AgentToolParams = Type.Object({
  action: Type.Optional(AgentAction),
  name: Type.Optional(
    Type.String({
      description: "Start only. Name of the agent to invoke.",
    })
  ),
  prompt: Type.Optional(
    Type.String({
      description: "Start only. Concrete, self-contained child instructions.",
    })
  ),
  label: Type.Optional(Type.String()),
  output_path: Type.Optional(Type.String()),
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

type AgentToolInput = Static<typeof AgentToolParams>;

const WAIT_DEFAULT_TIMEOUT_MS = 60_000;
const WAIT_MIN_TIMEOUT_MS = 1_000;
const WAIT_MAX_TIMEOUT_MS = 600_000;

function isTerminal(run: AgentRunSummary): boolean {
  return run.status !== "running";
}

function runLine(run: AgentRunSummary): string {
  const label = run.label?.trim() || run.agent_name;
  return `${run.invocation_name} (${run.agent_run_id}) — ${label} [${run.status}]`;
}

function runOutput(run: AgentRunSummary): string {
  if (run.output?.trim()) return run.output.trim();
  if (run.error) return `Agent failed: ${run.error}`;
  if (run.status === "interrupted") return "Agent interrupted.";
  return `Agent ${run.status}.`;
}

function statusBlock(run: AgentRunSummary): string {
  return isTerminal(run) ? `${runLine(run)}\n${runOutput(run)}` : runLine(run);
}

function subtask(run: AgentRunSummary) {
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
    task: run.prompt,
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

function errorResult(text: string, controller: AgentRunController) {
  return {
    content: [{ type: "text" as const, text }],
    details: { agents: controller.list() },
    isError: true,
  };
}

async function executeControlAction(
  params: AgentToolInput,
  controller: AgentRunController,
  acknowledge: (ids: readonly string[]) => void,
  signal?: AbortSignal
) {
  try {
    if (params.action === "status") {
      const runs = params.id
        ? [controller.get(params.id)].filter(
            (run): run is AgentRunSummary => run !== null
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
      acknowledge([params.id]);
      const run = await controller.message(params.id, params.message);
      return {
        content: [{ type: "text" as const, text: `Sent message to ${runLine(run)}` }],
        details: { agent: run, subtasks: [subtask(run)] },
      };
    }
    if (params.action === "interrupt") {
      if (!params.id) {
        return errorResult("interrupt requires id", controller);
      }
      const run = await controller.interrupt(params.id);
      return {
        content: [{ type: "text" as const, text: `Interrupted ${runLine(run)}` }],
        details: { agent: run, subtasks: [subtask(run)] },
      };
    }
    if (params.action === "close") {
      if (!params.id) {
        const ids = controller.list().map((run) => run.agent_run_id);
        await controller.closeAll();
        acknowledge(ids);
        return {
          content: [{ type: "text" as const, text: "All agent runs closed." }],
          details: { agents: [] },
        };
      }
      const run = await controller.close(params.id);
      acknowledge([params.id]);
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

export function createAgentTool(
  controller: AgentRunController,
  agents: ReadonlyMap<string, RecipeAgentDefinition>,
  opts: {
    acknowledgeCompletions?(ids: readonly string[]): void;
  } = {}
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
      "Omit action to start exactly one child with name and prompt.",
      "Starts always run in the background and return a run id immediately.",
      'Use action "wait" with ids to join all listed runs, or without ids to wait for the first running child.',
      "Other control actions return immediately.",
      "Use a clear label because status and the UI use it as the handle.",
      `Available agents: ${available || "none"}.`,
    ].join(" "),
    parameters: AgentToolParams,
    async execute(_id, rawParams, signal, onUpdate) {
      const params = rawParams as AgentToolInput;
      if (params.action && params.action !== "start") {
        return executeControlAction(params, controller, acknowledge, signal);
      }
      if (!params.name || !params.prompt) {
        return errorResult("Starting an agent requires name and prompt.", controller);
      }
      if (!agents.has(params.name)) {
        return errorResult(
          `Unknown agent "${params.name}". Available: ${[...agents.keys()].join(", ")}`,
          controller
        );
      }
      let started: AgentRunSummary;
      try {
        started = await controller.start({
          name: params.name,
          prompt: params.prompt,
          label: params.label,
          output_path: params.output_path,
          onUpdate(run) {
            return onUpdate?.({
              content: [{ type: "text" as const, text: "" }],
              details: { subtasks: [subtask(run)] },
            });
          },
        });
      } catch (error) {
        return errorResult(
          `Agent start failed: ${error instanceof Error ? error.message : String(error)}`,
          controller
        );
      }
      onUpdate?.({
        content: [{ type: "text" as const, text: "" }],
        details: { subtasks: [subtask(started)] },
      });
      return {
        content: [{ type: "text" as const, text: `Started ${runLine(started)}` }],
        details: { agent: started, subtasks: [subtask(started)] },
      };
    },
  });
}
