import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { serve as honoServe, type ServerType } from "@hono/node-server";
import { AgUiRunTranslator } from "./agui/translator.js";
import type { AgUiEvent } from "./agui/events.js";
import type { RuntimeEvent } from "./agui/session-events.js";
import { inspectRecipe, type RecipeInspection } from "./inspect.js";
import { clearMcpCatalogPreload } from "./mcp-catalog.js";
import { stopMcpDaemon } from "./mcp.js";
import {
  createRecipeSession,
  materializeRecipeSessionMcp,
  preflightRecipeSession,
  type RecipeSessionHandle,
} from "./session.js";
import type { ResolvedRecipe } from "./recipe/resolve.js";
import {
  flushRecipeTelemetry,
  initRecipeTelemetry,
  type RecipeTelemetry,
} from "./tracing.js";

/**
 * A standalone Tasks API server for a recipe: CRUD over tasks, runs within a
 * task, and AG-UI event streams per run — all state in-process. A task is a
 * conversation; creating one creates a Pi session through the engine rung.
 *
 * Wire contract: the Introspection public Tasks API subset, so a task client
 * built for the platform round-trips against this server unchanged.
 */
export interface ServeRecipeOptions {
  recipeDir: string;
  /** Default agent for created tasks (overridable per task). */
  agentName?: string;
  /**
   * Inbound bearer. Default: env `RECIPES_SERVE_TOKEN`; unset → auth
   * disabled (trusted-network deploys).
   */
  token?: string;
  /** Workspace root; each task gets `<root>/<task_id>/`. Default: a temp dir. */
  workspace?: string;
  /** Live-session cap; excess task creates → 409. Default 8. */
  maxTasks?: number;
  /** Lifecycle tap, called as each task's session is created. */
  onTask?: (taskId: string, handle: RecipeSessionHandle) => void;
}

export interface RecipeServer {
  /** Fetch-native entry, default-exportable on fetch runtimes. */
  fetch(request: Request): Promise<Response>;
  listen(options?: { port?: number; hostname?: string }): Promise<void>;
  /** Drain in-flight runs, dispose sessions, stop. */
  close(): Promise<void>;
}

export const DEFAULT_MAX_TASKS = 8;

const HEARTBEAT_MS = 15_000;
const MAX_RUN_BUFFER_BYTES = 1_048_576;

/** UUIDv7: 48-bit ms timestamp + version/variant bits + random tail. */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type RunStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

interface BufferedFrame {
  index: number;
  data: string;
  bytes: number;
}

interface RunEntry {
  id: string;
  taskId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  /** Sequential event_index source; also the next frame's SSE id. */
  nextIndex: number;
  frames: BufferedFrame[];
  bufferBytes: number;
  /** True once the terminal frame is buffered; streams close at delivery. */
  closed: boolean;
  cancelRequested: boolean;
  error: string | null;
  subscribers: Set<(frame: BufferedFrame | null) => void>;
}

interface TaskEntry {
  id: string;
  agentName: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  isArchived: boolean;
  workspaceDir: string;
  handle: RecipeSessionHandle;
  runs: Map<string, RunEntry>;
  currentRunId: string | null;
  lastRunId: string | null;
  disposed: boolean;
}

function now(): string {
  return new Date().toISOString();
}

function notFound(c: Context): Response {
  return c.json({ detail: "Not Found" }, 404);
}

function taskView(task: TaskEntry, instance: InstanceIdentity) {
  return {
    id: task.id,
    org_id: instance.orgId,
    project_id: instance.projectId,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    title: task.title,
    mode: "agent" as const,
    status: task.currentRunId ? ("running" as const) : ("idle" as const),
    is_archived: task.isArchived,
    metadata: {
      ...(task.metadata ?? {}),
      agent_name: task.agentName,
      ...(task.lastRunId ? { last_response: { run_id: task.lastRunId } } : {}),
    },
  };
}

function runView(run: RunEntry) {
  return {
    id: run.id,
    task_id: run.taskId,
    status: run.status,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}

interface InstanceIdentity {
  orgId: string;
  projectId: string;
}

/**
 * Map a Pi session event onto the translator's structural event union.
 * Settlement is fed explicitly after the prompt resolves (never from the
 * subscription) so terminal status is computed before RUN_FINISHED/RUN_ERROR.
 */
function adaptSessionEvent(event: unknown): RuntimeEvent | null {
  const record = event as { type?: string };
  switch (record.type) {
    case "agent_start":
    case "turn_start":
    case "message_update":
    case "message_end":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "compaction_start":
    case "compaction_end":
    case "agent_end":
      return event as RuntimeEvent;
    default:
      return null;
  }
}

function lastAssistantError(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | undefined;
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "error") {
      return typeof message.errorMessage === "string"
        ? message.errorMessage
        : "agent error";
    }
    return null;
  }
  return null;
}

export function serveRecipe(options: ServeRecipeOptions): RecipeServer {
  const recipeDir = resolve(options.recipeDir);
  const maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
  const token = options.token ?? process.env.RECIPES_SERVE_TOKEN;
  const instance: InstanceIdentity = { orgId: uuidv7(), projectId: uuidv7() };

  const tasks = new Map<string, TaskEntry>();
  let recipe: ResolvedRecipe | null = null;
  let inspection: RecipeInspection | null = null;
  let workspaceRoot: string | null = null;
  let mcpMaterialized = false;
  let telemetry: RecipeTelemetry | null = null;
  let httpServer: ServerType | null = null;
  let closed = false;

  // Fail-fast boot: resolve, check credentials/model, materialize MCP once
  // at the workspace root. Every task session then inherits that runtime.
  const boot = (async () => {
    recipe = await preflightRecipeSession({
      recipeDir,
      ...(options.agentName ? { agentName: options.agentName } : {}),
    });
    inspection = inspectRecipe(recipeDir);
    // Trace export out of the server, env-gated (OTEL_EXPORTER_OTLP_* or
    // the ingest pair in tracing.ts); null when unconfigured or when the
    // host already owns a provider — the handle is ownership.
    telemetry = await initRecipeTelemetry({ serviceName: inspection.name });
    workspaceRoot =
      options.workspace !== undefined
        ? resolve(options.workspace)
        : mkdtempSync(join(tmpdir(), "recipes-serve-"));
    mkdirSync(workspaceRoot, { recursive: true });
    const result = await materializeRecipeSessionMcp(
      recipe,
      workspaceRoot,
      process.env
    );
    mcpMaterialized = result.materialized;
  })();
  // Surfaced on first fetch()/listen(); never an unhandled rejection.
  boot.catch(() => {});

  function authorized(c: Context): boolean {
    if (token === undefined) return true;
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return false;
    const presented = Buffer.from(match[1]!);
    const expected = Buffer.from(token);
    return (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    );
  }

  function pushFrame(run: RunEntry, event: AgUiEvent): void {
    const data = JSON.stringify(event);
    const frame: BufferedFrame = {
      index: run.nextIndex,
      data,
      bytes: data.length,
    };
    run.nextIndex += 1;
    run.frames.push(frame);
    run.bufferBytes += frame.bytes;
    // Byte-budgeted retention; always keep the newest frame.
    while (run.bufferBytes > MAX_RUN_BUFFER_BYTES && run.frames.length > 1) {
      const evicted = run.frames.shift()!;
      run.bufferBytes -= evicted.bytes;
    }
    run.updatedAt = now();
    for (const deliver of run.subscribers) deliver(frame);
  }

  function closeRunStreams(run: RunEntry): void {
    run.closed = true;
    for (const deliver of run.subscribers) deliver(null);
  }

  async function executeRun(
    task: TaskEntry,
    run: RunEntry,
    prompt: string
  ): Promise<void> {
    const translator = new AgUiRunTranslator(task.id, run.id);
    const sessionLike = {
      get abortRequested() {
        return run.cancelRequested;
      },
      get error() {
        return run.error;
      },
    };
    const emit = (events: AgUiEvent[]) => {
      for (const event of events) pushFrame(run, event);
    };
    emit(translator.runStarted());
    const unsubscribe = task.handle.session.subscribe((event) => {
      const mapped = adaptSessionEvent(event);
      if (mapped) emit(translator.handleSessionEvent(mapped, sessionLike));
    });
    try {
      await task.handle.session.prompt(prompt);
    } catch (err) {
      run.error = err instanceof Error ? err.message : String(err);
    } finally {
      unsubscribe();
    }
    run.error ??= lastAssistantError(task.handle.session.messages);
    emit(translator.handleSessionEvent({ type: "session_settled" }, sessionLike));
    run.status = run.cancelRequested
      ? "cancelled"
      : run.error
        ? "failed"
        : "completed";
    run.updatedAt = now();
    task.currentRunId = null;
    task.updatedAt = now();
    closeRunStreams(run);
    // Settled runs flush eagerly so short-lived deploys don't lose spans.
    void flushRecipeTelemetry().catch(() => {});
  }

  function createRun(task: TaskEntry, status: RunStatus): RunEntry {
    const run: RunEntry = {
      id: uuidv7(),
      taskId: task.id,
      status,
      createdAt: now(),
      updatedAt: now(),
      nextIndex: 0,
      frames: [],
      bufferBytes: 0,
      closed: status !== "running",
      cancelRequested: false,
      error: null,
      subscribers: new Set(),
    };
    task.runs.set(run.id, run);
    task.lastRunId = run.id;
    return run;
  }

  function startRun(task: TaskEntry, prompt: string): RunEntry {
    const run = createRun(task, "running");
    task.currentRunId = run.id;
    task.updatedAt = now();
    void executeRun(task, run, prompt);
    return run;
  }

  /** Settle a cancel against a run: finished beats cancel. */
  function cancelRun(task: TaskEntry, run: RunEntry): void {
    if (run.status !== "running") return;
    run.cancelRequested = true;
    run.updatedAt = now();
    void task.handle.session.abort().catch(() => {});
  }

  async function disposeTask(task: TaskEntry): Promise<void> {
    if (task.disposed) return;
    task.disposed = true;
    const current = task.currentRunId
      ? task.runs.get(task.currentRunId)
      : undefined;
    if (current) cancelRun(task, current);
    await task.handle.dispose().catch(() => {});
    for (const run of task.runs.values()) {
      if (!run.closed) closeRunStreams(run);
    }
    tasks.delete(task.id);
  }

  function streamResponse(run: RunEntry, cursor: number | null): Response {
    const encoder = new TextEncoder();
    let heartbeat: NodeJS.Timeout | undefined;
    let deliver: ((frame: BufferedFrame | null) => void) | undefined;
    let controlSeq = 0;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const writeFrame = (id: string, event: string, data: string) => {
          controller.enqueue(
            encoder.encode(`id: ${id}\nevent: ${event}\ndata: ${data}\n\n`)
          );
        };
        const writeMeta = (name: string, value: Record<string, unknown>) => {
          writeFrame(
            `c-${controlSeq++}`,
            "ag_ui",
            JSON.stringify({ type: "CUSTOM", name, value })
          );
        };
        const finish = () => {
          if (heartbeat) clearInterval(heartbeat);
          if (deliver) run.subscribers.delete(deliver);
          try {
            controller.close();
          } catch {
            // Already closed by cancel().
          }
        };

        const fromIndex = cursor === null ? 0 : cursor + 1;
        const oldestBuffered = run.frames[0]?.index ?? run.nextIndex;
        if (fromIndex < oldestBuffered) {
          // The requested index left the retained window: declare the gap so
          // the client refetches state instead of trusting a partial replay.
          writeMeta("gap", {
            since: cursor,
            buffered_from: run.frames[0]?.index ?? null,
          });
        }
        const replayFrames = run.frames.filter(
          (frame) => frame.index >= fromIndex
        );
        writeMeta(
          run.closed ? "replay" : replayFrames.length > 0 ? "catch_up" : "subscribed",
          { from: replayFrames[0]?.index ?? run.nextIndex }
        );
        for (const frame of replayFrames) {
          writeFrame(String(frame.index), "ag_ui", frame.data);
        }
        if (run.closed) {
          finish();
          return;
        }

        deliver = (frame) => {
          if (frame === null) {
            finish();
            return;
          }
          writeFrame(String(frame.index), "ag_ui", frame.data);
        };
        run.subscribers.add(deliver);
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: keep-alive\n\n`));
          } catch {
            finish();
          }
        }, HEARTBEAT_MS);
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat);
        if (deliver) run.subscribers.delete(deliver);
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        connection: "keep-alive",
      },
    });
  }

  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  // One bearer for the whole server; unauthorized is indistinguishable from
  // nonexistent so the API is not an oracle for probing ids.
  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    if (!authorized(c)) return notFound(c);
    await boot;
    return next();
  });

  app.get("/config", (c) =>
    c.json({
      ...(inspection as RecipeInspection),
      agent_name: recipe!.agentName,
      max_tasks: maxTasks,
      server: "@introspection-ai/pi-recipes/serve",
    })
  );

  app.post("/v1/tasks", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      prompt?: string;
      agent_name?: string;
      metadata?: Record<string, unknown>;
    };
    if (tasks.size >= maxTasks) {
      return c.json(
        { detail: `Task capacity reached (max_tasks=${maxTasks})` },
        409
      );
    }
    const agentName = body.agent_name ?? options.agentName;
    const taskId = uuidv7();
    const workspaceDir = join(workspaceRoot!, taskId);
    mkdirSync(workspaceDir, { recursive: true });

    let handle: RecipeSessionHandle;
    try {
      handle = await createRecipeSession({
        recipeDir,
        ...(agentName ? { agentName } : {}),
        cwd: workspaceDir,
        mcpMode: "inherit",
        telemetry: { conversationId: taskId },
      });
    } catch (err) {
      return c.json(
        { detail: err instanceof Error ? err.message : String(err) },
        422
      );
    }

    const task: TaskEntry = {
      id: taskId,
      agentName: handle.recipe.agentName,
      title: body.title ?? null,
      metadata: body.metadata ?? null,
      createdAt: now(),
      updatedAt: now(),
      isArchived: false,
      workspaceDir,
      handle,
      runs: new Map(),
      currentRunId: null,
      lastRunId: null,
      disposed: false,
    };
    tasks.set(taskId, task);
    options.onTask?.(taskId, handle);

    const run =
      body.prompt !== undefined && body.prompt.trim() !== ""
        ? startRun(task, body.prompt)
        : createRun(task, "idle");
    return c.json({ task: taskView(task, instance), run: runView(run) }, 200);
  });

  app.get("/v1/tasks", (c) => {
    const limit = Math.max(
      1,
      Math.min(100, Number(c.req.query("limit") ?? 50) || 50)
    );
    const cursor = c.req.query("next");
    const ordered = [...tasks.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    const start = cursor
      ? ordered.findIndex((task) => task.id > cursor)
      : 0;
    const windowStart = start < 0 ? ordered.length : start;
    const page = ordered.slice(windowStart, windowStart + limit);
    const next =
      windowStart + limit < ordered.length ? page.at(-1)?.id ?? null : null;
    return c.json({
      records: page.map((task) => taskView(task, instance)),
      count: page.length,
      total_count: ordered.length,
      next,
    });
  });

  app.get("/v1/tasks/:taskId", (c) => {
    const task = tasks.get(c.req.param("taskId"));
    if (!task) return notFound(c);
    return c.json(taskView(task, instance));
  });

  app.patch("/v1/tasks/:taskId", async (c) => {
    const task = tasks.get(c.req.param("taskId"));
    if (!task) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      is_archived?: boolean;
      metadata?: Record<string, unknown>;
    };
    if (body.title !== undefined) task.title = body.title;
    if (body.is_archived !== undefined) task.isArchived = body.is_archived;
    if (body.metadata !== undefined) task.metadata = body.metadata;
    task.updatedAt = now();
    return c.json(taskView(task, instance));
  });

  app.delete("/v1/tasks/:taskId", async (c) => {
    const task = tasks.get(c.req.param("taskId"));
    if (!task) return notFound(c);
    await disposeTask(task);
    return c.body(null, 204);
  });

  app.post("/v1/tasks/:taskId/cancel", (c) => {
    const task = tasks.get(c.req.param("taskId"));
    if (!task) return notFound(c);
    const run = task.currentRunId
      ? task.runs.get(task.currentRunId)
      : undefined;
    if (run) cancelRun(task, run);
    return c.json({ id: task.id });
  });

  app.post("/v1/tasks/:taskId/runs", async (c) => {
    const task = tasks.get(c.req.param("taskId"));
    if (!task) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      prompt?: { text?: string };
      message?: string;
      kind?: "prompt" | "steer" | "clear";
    };
    const kind = body.kind ?? (body.message !== undefined ? "steer" : "prompt");
    const activeRun = task.currentRunId
      ? task.runs.get(task.currentRunId)
      : undefined;

    if (kind === "steer") {
      const message = body.message ?? body.prompt?.text;
      if (!message || !activeRun) {
        return c.json(
          { detail: activeRun ? "steer requires a message" : "No run in flight to steer" },
          activeRun ? 400 : 409
        );
      }
      await task.handle.session.steer(message);
      activeRun.updatedAt = now();
      return c.json({ run: runView(activeRun) });
    }

    const text = body.prompt?.text ?? body.message;
    if (kind !== "prompt" || !text || !text.trim()) {
      return c.json({ detail: "A prompt run requires prompt.text" }, 400);
    }
    if (activeRun) {
      return c.json(
        { detail: "A run is already in flight for this task" },
        409
      );
    }
    const run = startRun(task, text);
    return c.json({ run: runView(run) });
  });

  app.get("/v1/tasks/:taskId/runs/:runId", (c) => {
    const task = tasks.get(c.req.param("taskId"));
    const run = task?.runs.get(c.req.param("runId"));
    if (!task || !run) return notFound(c);
    return c.json(runView(run));
  });

  app.post("/v1/tasks/:taskId/runs/:runId/cancel", (c) => {
    const task = tasks.get(c.req.param("taskId"));
    const run = task?.runs.get(c.req.param("runId"));
    if (!task || !run) return notFound(c);
    // A cancel that loses the race to a finished run settles as completed.
    cancelRun(task, run);
    return c.json({ id: run.id });
  });

  app.get("/v1/tasks/:taskId/runs/:runId/stream", (c) => {
    const task = tasks.get(c.req.param("taskId"));
    const run = task?.runs.get(c.req.param("runId"));
    if (!task || !run) return notFound(c);
    const raw =
      c.req.query("last_event_index") ?? c.req.header("last-event-id");
    const cursor =
      raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : null;
    return streamResponse(run, cursor);
  });

  // Resources this server does not implement return 404 by Hono's default.

  return {
    async fetch(request: Request): Promise<Response> {
      // /health stays live during (and despite) boot; every other route
      // surfaces a boot failure to the host rather than serving 500s.
      if (new URL(request.url).pathname !== "/health") await boot;
      return app.fetch(request);
    },
    async listen(listenOptions?: {
      port?: number;
      hostname?: string;
    }): Promise<void> {
      await boot;
      await new Promise<void>((resolvePromise) => {
        httpServer = honoServe(
          {
            fetch: app.fetch,
            port: listenOptions?.port ?? 8888,
            hostname: listenOptions?.hostname ?? "127.0.0.1",
          },
          () => resolvePromise()
        );
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const task of [...tasks.values()]) {
        await disposeTask(task);
      }
      if (mcpMaterialized) {
        clearMcpCatalogPreload(process.env);
        await stopMcpDaemon(process.env).catch(() => {});
      }
      await telemetry?.shutdown().catch(() => {});
      if (httpServer) {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          httpServer!.close((err) =>
            err ? rejectPromise(err) : resolvePromise()
          );
        });
        httpServer = null;
      }
    },
  };
}
