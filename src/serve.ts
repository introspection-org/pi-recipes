import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { serve as honoServe, type ServerType } from "@hono/node-server";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
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
  flushRecipeTracing,
  initRecipeTracing,
  type RecipeTracing,
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
  /**
   * Session persistence, per task. Return the manager backing that task's
   * transcript; `undefined` keeps the in-memory default. This is the seam,
   * not a store: durability is whatever the host builds on it — a session
   * directory on a mounted volume, or rows projected out of `onEvent` and
   * rehydrated through `SessionManager.open`.
   */
  sessionManager?: (taskId: string) => SessionManager | undefined;
  /**
   * Rebuild the task index at boot from tasks a previous process persisted.
   * Without it a restart loses the server's knowledge of tasks even when
   * `sessionManager` kept their transcripts — the files survive but nothing
   * lists them.
   *
   * Discovery belongs to whoever owns the storage, so this returns metadata
   * plus a thunk; the Pi session itself is opened lazily, on the first run
   * against that task, not for every task at boot.
   */
  restoreTasks?: () => RestorableTask[] | Promise<RestorableTask[]>;
  /**
   * Structured log sink. Default: JSON lines on stderr. Pass a no-op to
   * silence the server; the host owns shipping, sampling, and redaction.
   */
  logger?: ServeLogger;
}

/** A task recovered from a previous process, not yet opened. */
export interface RestorableTask {
  taskId: string;
  /** Opened on first use. */
  open: () => SessionManager | Promise<SessionManager>;
  agentName?: string;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
}

/** A structured server log record. `event` is a stable dotted name. */
export interface ServeLogEvent {
  level: "info" | "warn" | "error";
  event: string;
  request_id?: string;
  [key: string]: unknown;
}

export type ServeLogger = (event: ServeLogEvent) => void;

/**
 * JSON lines on stderr — the lowest-common-denominator sink every log
 * collector already understands, and stdout stays free for the CLI.
 */
export const defaultServeLogger: ServeLogger = (event) => {
  process.stderr.write(`${JSON.stringify({ time: now(), ...event })}\n`);
};

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
  /**
   * The live Pi session, or null for a task restored from storage that has
   * not been used since. Restored tasks hold an index entry and a
   * transcript; they cost a session only when someone runs them.
   */
  handle: RecipeSessionHandle | null;
  /** Reopens the persisted transcript when a restored task is first used. */
  restore: (() => SessionManager | Promise<SessionManager>) | null;
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
 * Liveness and readiness are different questions: the process is alive from
 * the first tick, but it cannot serve a task until the boot preflight has
 * resolved the recipe, checked credentials, and materialized MCP. Reporting
 * ready too early makes an orchestrator route traffic that then blocks on
 * `boot` instead of going to an instance that can answer.
 */
type Readiness =
  | { state: "booting" }
  | { state: "ready" }
  | { state: "failed"; detail: string };

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
  const log = options.logger ?? defaultServeLogger;

  const tasks = new Map<string, TaskEntry>();
  // Idempotency-Key → task id, so a channel's retry (Slack redelivery, a
  // queue's at-least-once delivery) resolves to the task it already made
  // instead of a second one. Dropped with the task.
  const idempotentTasks = new Map<string, string>();
  let readiness: Readiness = { state: "booting" };
  let recipe: ResolvedRecipe | null = null;
  let inspection: RecipeInspection | null = null;
  let workspaceRoot: string | null = null;
  let mcpMaterialized = false;
  let tracing: RecipeTracing | null = null;
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
    tracing = await initRecipeTracing({ serviceName: inspection.name });
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

    // Rebuild the index before serving: a task that existed when the last
    // process died must be listable by the new one.
    if (options.restoreTasks) {
      const restored = await options.restoreTasks();
      for (const entry of restored) {
        if (tasks.has(entry.taskId)) continue;
        const stamp = entry.createdAt ?? now();
        tasks.set(entry.taskId, {
          id: entry.taskId,
          agentName: entry.agentName ?? recipe.agentName,
          title: entry.title ?? null,
          metadata: entry.metadata ?? null,
          createdAt: stamp,
          updatedAt: entry.updatedAt ?? stamp,
          isArchived: false,
          workspaceDir: join(workspaceRoot, entry.taskId),
          handle: null,
          restore: entry.open,
          runs: new Map(),
          currentRunId: null,
          lastRunId: null,
          disposed: false,
        });
      }
      log({
        level: "info",
        event: "tasks.restored",
        count: restored.length,
      });
    }

    readiness = { state: "ready" };
    log({
      level: "info",
      event: "boot.ready",
      recipe: inspection.name,
      agent_name: recipe.agentName,
      max_tasks: maxTasks,
      mcp_materialized: mcpMaterialized,
    });
  })();
  // Surfaced on first fetch()/listen(); never an unhandled rejection.
  boot.catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    readiness = { state: "failed", detail };
    log({ level: "error", event: "boot.failed", detail });
  });

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

  /** Live sessions, which is what `maxTasks` caps — a restored task that
   * nobody has run holds an index entry, not a session. */
  function liveSessionCount(): number {
    let count = 0;
    for (const task of tasks.values()) if (task.handle) count += 1;
    return count;
  }

  /**
   * Open a restored task's session on first use. Reopening the persisted
   * transcript is what makes the conversation continue rather than restart.
   */
  async function ensureHandle(task: TaskEntry): Promise<RecipeSessionHandle> {
    if (task.handle) return task.handle;
    const sessionManager = task.restore
      ? await task.restore()
      : options.sessionManager?.(task.id);
    mkdirSync(task.workspaceDir, { recursive: true });
    const handle = await createRecipeSession({
      recipeDir,
      ...(task.agentName ? { agentName: task.agentName } : {}),
      cwd: task.workspaceDir,
      mcpMode: "inherit",
      tracing: { conversationId: task.id },
      ...(sessionManager ? { sessionManager } : {}),
    });
    task.handle = handle;
    task.restore = null;
    options.onTask?.(task.id, handle);
    log({
      level: "info",
      event: "task.reopened",
      task_id: task.id,
      messages: handle.session.messages.length,
    });
    return handle;
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
    prompt: string,
    handle: RecipeSessionHandle
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
    const unsubscribe = handle.session.subscribe((event) => {
      const mapped = adaptSessionEvent(event);
      if (mapped) emit(translator.handleSessionEvent(mapped, sessionLike));
    });
    try {
      await handle.session.prompt(prompt);
    } catch (err) {
      run.error = err instanceof Error ? err.message : String(err);
    } finally {
      unsubscribe();
    }
    run.error ??= lastAssistantError(handle.session.messages);
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
    log({
      level: run.status === "failed" ? "error" : "info",
      event: "run.settled",
      task_id: task.id,
      run_id: run.id,
      status: run.status,
      duration_ms: Date.parse(run.updatedAt) - Date.parse(run.createdAt),
      ...(run.error ? { detail: run.error } : {}),
    });
    // Settled runs flush eagerly so short-lived deploys don't lose spans.
    void flushRecipeTracing().catch(() => {});
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

  function startRun(
    task: TaskEntry,
    prompt: string,
    handle: RecipeSessionHandle
  ): RunEntry {
    const run = createRun(task, "running");
    task.currentRunId = run.id;
    task.updatedAt = now();
    log({
      level: "info",
      event: "run.started",
      task_id: task.id,
      run_id: run.id,
    });
    void executeRun(task, run, prompt, handle);
    return run;
  }

  /** Settle a cancel against a run: finished beats cancel. */
  function cancelRun(task: TaskEntry, run: RunEntry): void {
    if (run.status !== "running") return;
    run.cancelRequested = true;
    run.updatedAt = now();
    void task.handle?.session.abort().catch(() => {});
  }

  async function disposeTask(task: TaskEntry): Promise<void> {
    if (task.disposed) return;
    task.disposed = true;
    const current = task.currentRunId
      ? task.runs.get(task.currentRunId)
      : undefined;
    if (current) cancelRun(task, current);
    await task.handle?.dispose().catch(() => {});
    for (const run of task.runs.values()) {
      if (!run.closed) closeRunStreams(run);
    }
    tasks.delete(task.id);
    for (const [key, id] of idempotentTasks) {
      if (id === task.id) idempotentTasks.delete(key);
    }
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

  const app = new Hono<{ Variables: { requestId: string } }>();

  // Probe routes answer before auth: an orchestrator has no bearer, and a
  // health check that 404s is indistinguishable from a dead process.
  //
  // Liveness: the process is up. Never gated on boot — a failed boot must
  // still answer so the platform reports "started but not ready" instead of
  // restart-looping a container whose recipe or credentials are misconfigured.
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Readiness: this instance can serve a task.
  app.get("/ready", (c) =>
    readiness.state === "ready"
      ? c.json({ status: "ready" })
      : c.json(
          readiness.state === "failed"
            ? { status: "failed", detail: readiness.detail }
            : { status: "booting" },
          503
        )
  );

  // Correlation id first, so every later log line and the error boundary can
  // carry it. Honor an inbound id when the caller already has one.
  app.use("*", async (c, next) => {
    const inbound = c.req.header("x-request-id");
    const requestId = inbound && inbound.length <= 200 ? inbound : uuidv7();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    const startedAt = Date.now();
    await next();
    log({
      level: c.res.status >= 500 ? "error" : "info",
      event: "request",
      request_id: requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - startedAt,
    });
  });

  // One bearer for the whole server; unauthorized is indistinguishable from
  // nonexistent so the API is not an oracle for probing ids.
  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || c.req.path === "/ready") return next();
    if (!authorized(c)) return notFound(c);
    await boot;
    return next();
  });

  // Without this an unhandled throw becomes a bare 500 with no body and no
  // record. The detail stays generic; the cause goes to the log with the
  // request id that the client also received.
  app.onError((err, c) => {
    const requestId = c.get("requestId") as string | undefined;
    log({
      level: "error",
      event: "unhandled_error",
      ...(requestId ? { request_id: requestId } : {}),
      method: c.req.method,
      path: c.req.path,
      detail: err instanceof Error ? err.message : String(err),
      ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
    });
    return c.json(
      {
        detail: "Internal Server Error",
        ...(requestId ? { request_id: requestId } : {}),
      },
      500
    );
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
    // A retry of a create that already succeeded returns the same task
    // rather than a second one — the property every at-least-once channel
    // (Slack redelivery, a queue, a webhook) needs to be correct.
    const idempotencyKey = c.req.header("idempotency-key");
    if (idempotencyKey) {
      const existingId = idempotentTasks.get(idempotencyKey);
      const existing = existingId ? tasks.get(existingId) : undefined;
      if (existing) {
        const lastRun = existing.lastRunId
          ? existing.runs.get(existing.lastRunId)
          : undefined;
        log({
          level: "info",
          event: "task.create_deduped",
          request_id: c.get("requestId"),
          task_id: existing.id,
        });
        return c.json(
          {
            task: taskView(existing, instance),
            ...(lastRun ? { run: runView(lastRun) } : {}),
          },
          200
        );
      }
    }

    if (liveSessionCount() >= maxTasks) {
      return c.json(
        { detail: `Task capacity reached (max_tasks=${maxTasks})` },
        409
      );
    }
    const agentName = body.agent_name ?? options.agentName;
    const taskId = uuidv7();
    const workspaceDir = join(workspaceRoot!, taskId);
    mkdirSync(workspaceDir, { recursive: true });

    const sessionManager = options.sessionManager?.(taskId);

    let handle: RecipeSessionHandle;
    try {
      handle = await createRecipeSession({
        recipeDir,
        ...(agentName ? { agentName } : {}),
        cwd: workspaceDir,
        mcpMode: "inherit",
        tracing: { conversationId: taskId },
        ...(sessionManager ? { sessionManager } : {}),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log({
        level: "warn",
        event: "task.create_failed",
        request_id: c.get("requestId"),
        task_id: taskId,
        detail,
      });
      return c.json({ detail }, 422);
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
      restore: null,
      runs: new Map(),
      currentRunId: null,
      lastRunId: null,
      disposed: false,
    };
    tasks.set(taskId, task);
    if (idempotencyKey) idempotentTasks.set(idempotencyKey, taskId);
    options.onTask?.(taskId, handle);
    log({
      level: "info",
      event: "task.created",
      request_id: c.get("requestId"),
      task_id: taskId,
      agent_name: task.agentName,
      persisted: sessionManager !== undefined,
      live_tasks: liveSessionCount(),
    });

    const run =
      body.prompt !== undefined && body.prompt.trim() !== ""
        ? startRun(task, body.prompt, handle)
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
      await (await ensureHandle(task)).session.steer(message);
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
    let handle: RecipeSessionHandle;
    try {
      handle = await ensureHandle(task);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log({
        level: "warn",
        event: "task.reopen_failed",
        request_id: c.get("requestId"),
        task_id: task.id,
        detail,
      });
      return c.json({ detail }, 422);
    }
    const run = startRun(task, text, handle);
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
      // Probe routes stay live during (and despite) boot — that is the whole
      // point of readiness. Every other route surfaces a boot failure to the
      // host rather than serving 500s.
      const { pathname } = new URL(request.url);
      if (pathname !== "/health" && pathname !== "/ready") await boot;
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
      await tracing?.shutdown().catch(() => {});
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
