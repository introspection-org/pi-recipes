import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai/compat";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  serveRecipe,
  type RecipeServer,
  type ServeLogEvent,
} from "../src/serve.js";
import type { RecipeSessionHandle } from "../src/session.js";
import { writeFixtureRecipe } from "../src/test-utils.js";

class MockAssistantStream extends EventStream<
  AssistantMessageEvent,
  AssistantMessage
> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event type");
      }
    );
  }
}

function assistantMessage(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop"
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "mock",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function scriptReply(handle: RecipeSessionHandle, text: string): void {
  handle.session.agent.streamFunction = () => {
    const stream = new MockAssistantStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: assistantMessage("") });
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: assistantMessage(""),
      });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: text,
        partial: assistantMessage(text),
      });
      stream.push({
        type: "text_end",
        contentIndex: 0,
        content: text,
        partial: assistantMessage(text),
      });
      stream.push({
        type: "done",
        reason: "stop",
        message: assistantMessage(text),
      });
    });
    return stream;
  };
}

function scriptHangUntilAbort(handle: RecipeSessionHandle): void {
  handle.session.agent.streamFunction = (_model, _context, options) => {
    const stream = new MockAssistantStream();
    const signal = options?.signal;
    queueMicrotask(() => {
      stream.push({ type: "start", partial: assistantMessage("") });
      const checkAbort = () => {
        if (signal?.aborted) {
          stream.push({
            type: "error",
            reason: "aborted",
            error: assistantMessage("Aborted", "aborted"),
          });
        } else {
          setTimeout(checkAbort, 5);
        }
      };
      checkAbort();
    });
    return stream;
  };
}

interface SseEvent {
  id?: string;
  event?: string;
  data?: string;
}

async function readSse(
  response: Response,
  options: { until?: (events: SseEvent[]) => boolean; timeoutMs?: number } = {}
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  for (;;) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("SSE read timeout")),
          Math.max(1, deadline - Date.now())
        )
      ),
    ]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event: SseEvent = {};
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) event.id = line.slice(4);
        else if (line.startsWith("event: ")) event.event = line.slice(7);
        else if (line.startsWith("data: ")) event.data = line.slice(6);
      }
      if (Object.keys(event).length > 0) events.push(event);
      if (options.until?.(events)) {
        await reader.cancel().catch(() => {});
        return events;
      }
    }
  }
  return events;
}

function aguiTypes(events: SseEvent[]): string[] {
  return events
    .filter((event) => event.event === "ag_ui" && event.data)
    .map((event) => (JSON.parse(event.data!) as { type: string }).type);
}

function customNames(events: SseEvent[]): string[] {
  return events
    .filter((event) => event.event === "ag_ui" && event.data)
    .map((event) => JSON.parse(event.data!) as { type: string; name?: string })
    .filter((event) => event.type === "CUSTOM")
    .map((event) => event.name!);
}

const TOKEN = "serve-test-token";

describe("serveRecipe", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  }, 30_000);

  function makeServer(options?: {
    onTask?: (taskId: string, handle: RecipeSessionHandle) => void;
    maxTasks?: number;
    fixture?: Parameters<typeof writeFixtureRecipe>[0];
    sessionManager?: (taskId: string) => SessionManager | undefined;
    logs?: ServeLogEvent[];
  }): { server: RecipeServer; recipeDir: string } {
    const fixture = writeFixtureRecipe(options?.fixture);
    cleanups.push(fixture.cleanup);
    const logs = options?.logs;
    const server = serveRecipe({
      recipeDir: fixture.recipeDir,
      token: TOKEN,
      workspace: fixture.workspaceDir,
      logger: logs ? (event) => logs.push(event) : () => {},
      ...(options?.maxTasks !== undefined
        ? { maxTasks: options.maxTasks }
        : {}),
      ...(options?.onTask ? { onTask: options.onTask } : {}),
      ...(options?.sessionManager
        ? { sessionManager: options.sessionManager }
        : {}),
    });
    cleanups.push(() => server.close());
    return { server, recipeDir: fixture.recipeDir };
  }

  function request(
    server: RecipeServer,
    method: string,
    path: string,
    options: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {}
  ): Promise<Response> {
    const headers: Record<string, string> = { ...options.headers };
    const token = options.token === undefined ? TOKEN : options.token;
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    return server.fetch(
      new Request(`http://recipes.local${path}`, {
        method,
        headers,
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      })
    );
  }

  // env note: fixtures declare anthropic; the suite relies on the ambient
  // ANTHROPIC_API_KEY if present, else stuffs one for the process.
  if (!process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = "serve-test-key";
  }

  it("serves /health without auth and /config with auth", async () => {
    const { server } = makeServer();
    const health = await request(server, "GET", "/health", { token: null });
    expect(health.status).toBe(200);

    const config = await request(server, "GET", "/config");
    expect(config.status).toBe(200);
    const body = (await config.json()) as {
      name: string;
      agents: string[];
      agent_name: string;
    };
    expect(body.name).toBe("conformance-fixture");
    expect(body.agents).toContain("agent");
    expect(body.agent_name).toBe("agent");
  });

  it("treats a bad bearer exactly like a missing task", async () => {
    const { server } = makeServer();
    const unauthorized = await request(server, "GET", "/v1/tasks/none", {
      token: "wrong",
    });
    const missing = await request(
      server,
      "GET",
      `/v1/tasks/00000000-0000-7000-8000-000000000000`
    );
    expect(unauthorized.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await unauthorized.text()).toBe(await missing.text());
  });

  it("fails boot fast on an unbound required MCP server", async () => {
    const { server } = makeServer({
      fixture: {
        manifestPi: {
          mcp: {
            servers: [
              { id: "linear", required: true, tools: { include: ["*"] } },
            ],
          },
        },
        agentExtras: ["mcp:", "  linear:", '    include: ["*"]'],
      },
    });
    await expect(
      server.fetch(new Request("http://recipes.local/health"))
    ).resolves.toBeDefined();
    // fetch of an authed route surfaces the boot failure.
    await expect(request(server, "GET", "/config")).rejects.toThrow(
      /linear/
    );
  });

  it("creates a task with a prompt, streams AG-UI events, then completes", async () => {
    const { server } = makeServer({
      onTask: (_taskId, handle) => scriptReply(handle, "served hello"),
    });
    const created = await request(server, "POST", "/v1/tasks", {
      body: { prompt: "hi", title: "t1" },
    });
    expect(created.status).toBe(200);
    const { task, run } = (await created.json()) as {
      task: { id: string; status: string };
      run: { id: string; task_id: string };
    };
    expect(run.task_id).toBe(task.id);

    const stream = await request(
      server,
      "GET",
      `/v1/tasks/${task.id}/runs/${run.id}/stream`
    );
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSse(stream, {
      until: (all) => aguiTypes(all).includes("RUN_FINISHED"),
    });
    const types = aguiTypes(events);
    expect(types[1]).toBe("RUN_STARTED");
    expect(types).toContain("TEXT_MESSAGE_START");
    expect(types).toContain("TEXT_MESSAGE_CONTENT");
    expect(types).toContain("TEXT_MESSAGE_END");
    expect(types.at(-1)).toBe("RUN_FINISHED");
    const text = events
      .filter((event) => event.event === "ag_ui" && event.data)
      .map((event) => JSON.parse(event.data!) as { type: string; delta?: string })
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta)
      .join("");
    expect(text).toBe("served hello");

    // Run settles as completed; task returns to idle.
    const runView = await request(
      server,
      "GET",
      `/v1/tasks/${task.id}/runs/${run.id}`
    );
    expect(((await runView.json()) as { status: string }).status).toBe(
      "completed"
    );
    const taskView = await request(server, "GET", `/v1/tasks/${task.id}`);
    expect(((await taskView.json()) as { status: string }).status).toBe("idle");
  });

  it("replays a finished run with original indexes and resume meta", async () => {
    const { server } = makeServer({
      onTask: (_taskId, handle) => scriptReply(handle, "replayed"),
    });
    const created = await request(server, "POST", "/v1/tasks", {
      body: { prompt: "hi" },
    });
    const { task, run } = (await created.json()) as {
      task: { id: string };
      run: { id: string };
    };
    // Wait for completion.
    const first = await request(
      server,
      "GET",
      `/v1/tasks/${task.id}/runs/${run.id}/stream`
    );
    const firstEvents = await readSse(first, {
      until: (all) => aguiTypes(all).includes("RUN_FINISHED"),
    });
    expect(customNames(firstEvents)[0]).toMatch(/^(catch_up|replay)$/);
    const contentIds = firstEvents
      .filter((event) => event.event === "ag_ui" && /^[0-9]+$/.test(event.id ?? ""))
      .map((event) => Number(event.id));
    expect(contentIds).toEqual([...contentIds].sort((a, b) => a - b));

    // Reconnect from a mid-stream cursor: replay meta + only later indexes.
    const cursor = contentIds[1]!;
    const resumed = await request(
      server,
      "GET",
      `/v1/tasks/${task.id}/runs/${run.id}/stream`,
      { headers: { "last-event-id": String(cursor) } }
    );
    const resumedEvents = await readSse(resumed);
    expect(customNames(resumedEvents)[0]).toBe("replay");
    const resumedIds = resumedEvents
      .filter((event) => event.event === "ag_ui" && /^[0-9]+$/.test(event.id ?? ""))
      .map((event) => Number(event.id));
    expect(Math.min(...resumedIds)).toBe(cursor + 1);
  });

  it("rejects a second run while one is in flight, allows steer", async () => {
    const { server } = makeServer({
      onTask: (_taskId, handle) => scriptHangUntilAbort(handle),
    });
    const created = await request(server, "POST", "/v1/tasks", {
      body: { prompt: "long task" },
    });
    const { task } = (await created.json()) as { task: { id: string } };

    const conflict = await request(server, "POST", `/v1/tasks/${task.id}/runs`, {
      body: { prompt: { text: "another" } },
    });
    expect(conflict.status).toBe(409);

    const steer = await request(server, "POST", `/v1/tasks/${task.id}/runs`, {
      body: { message: "adjust course", kind: "steer" },
    });
    expect(steer.status).toBe(200);

    const cancel = await request(server, "POST", `/v1/tasks/${task.id}/cancel`);
    expect(cancel.status).toBe(200);

    // Wait for the cancel to settle before teardown so dispose is clean.
    for (let i = 0; i < 200; i += 1) {
      const view = (await (
        await request(server, "GET", `/v1/tasks/${task.id}`)
      ).json()) as { status: string };
      if (view.status === "idle") break;
      await new Promise((r) => setTimeout(r, 25));
    }
  }, 20_000);

  it("cancel settles: mid-run cancel → cancelled; finished beats cancel", async () => {
    const handles: RecipeSessionHandle[] = [];
    const { server } = makeServer({
      onTask: (_taskId, handle) => {
        handles.push(handle);
        scriptHangUntilAbort(handle);
      },
    });
    const created = await request(server, "POST", "/v1/tasks", {
      body: { prompt: "will cancel" },
    });
    const { task, run } = (await created.json()) as {
      task: { id: string };
      run: { id: string };
    };
    const cancel = await request(
      server,
      "POST",
      `/v1/tasks/${task.id}/runs/${run.id}/cancel`
    );
    expect(cancel.status).toBe(200);
    // The stream terminates and the run settles cancelled.
    const stream = await request(
      server,
      "GET",
      `/v1/tasks/${task.id}/runs/${run.id}/stream`
    );
    await readSse(stream, { timeoutMs: 8000 }).catch(() => []);
    for (let i = 0; i < 100; i += 1) {
      const view = (await (
        await request(server, "GET", `/v1/tasks/${task.id}/runs/${run.id}`)
      ).json()) as { status: string };
      if (view.status !== "running") {
        expect(view.status).toBe("cancelled");
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    // Finished-beats-cancel: cancel a completed run — status stays completed.
    scriptReply(handles[0]!, "quick");
    const second = await request(server, "POST", `/v1/tasks/${task.id}/runs`, {
      body: { prompt: { text: "quick one" } },
    });
    const { run: run2 } = (await second.json()) as { run: { id: string } };
    const stream2 = await request(
      server,
      "GET",
      `/v1/tasks/${task.id}/runs/${run2.id}/stream`
    );
    await readSse(stream2, {
      until: (all) => aguiTypes(all).includes("RUN_FINISHED"),
    });
    await request(
      server,
      "POST",
      `/v1/tasks/${task.id}/runs/${run2.id}/cancel`
    );
    const view = (await (
      await request(server, "GET", `/v1/tasks/${task.id}/runs/${run2.id}`)
    ).json()) as { status: string };
    expect(view.status).toBe("completed");
  });

  it("caps live tasks at maxTasks with 409", async () => {
    const { server } = makeServer({ maxTasks: 1 });
    const first = await request(server, "POST", "/v1/tasks", { body: {} });
    expect(first.status).toBe(200);
    const second = await request(server, "POST", "/v1/tasks", { body: {} });
    expect(second.status).toBe(409);
    // Deleting frees the slot.
    const { task } = (await first.json()) as { task: { id: string } };
    const deleted = await request(server, "DELETE", `/v1/tasks/${task.id}`);
    expect(deleted.status).toBe(204);
    const third = await request(server, "POST", "/v1/tasks", { body: {} });
    expect(third.status).toBe(200);
  });

  it("lists tasks with cursor pagination", async () => {
    const { server } = makeServer({ maxTasks: 3 });
    for (let i = 0; i < 3; i += 1) {
      await request(server, "POST", "/v1/tasks", { body: {} });
    }
    const page1 = (await (
      await request(server, "GET", "/v1/tasks?limit=2")
    ).json()) as { records: Array<{ id: string }>; next: string | null };
    expect(page1.records).toHaveLength(2);
    expect(page1.next).toBeTruthy();
    const page2 = (await (
      await request(server, "GET", `/v1/tasks?limit=2&next=${page1.next}`)
    ).json()) as { records: Array<{ id: string }>; next: string | null };
    expect(page2.records).toHaveLength(1);
    expect(page2.next).toBeNull();
  });

  it("returns 404 for unimplemented resources", async () => {
    const { server } = makeServer();
    const conversations = await request(server, "GET", "/v1/conversations");
    expect(conversations.status).toBe(404);
  });

  it("reports readiness without auth, separately from liveness", async () => {
    const { server } = makeServer();
    // Probe routes never wait on boot — that is the point of readiness, so
    // a still-booting instance answers "booting" instead of hanging.
    const booting = await request(server, "GET", "/ready", { token: null });
    expect(booting.status).toBe(503);
    expect(await booting.json()).toEqual({ status: "booting" });

    // Any authenticated route awaits boot; afterwards readiness flips.
    await request(server, "GET", "/config");
    const ready = await request(server, "GET", "/ready", { token: null });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });
  });

  it("reports a failed boot as unready instead of dying", async () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    const server = serveRecipe({
      recipeDir: join(fixture.recipeDir, "does-not-exist"),
      token: TOKEN,
      workspace: fixture.workspaceDir,
      logger: () => {},
    });
    cleanups.push(() => server.close());

    // Liveness stays 200: the process is up and must not be restart-looped
    // for a misconfiguration a restart cannot fix.
    const health = await request(server, "GET", "/health", { token: null });
    expect(health.status).toBe(200);

    const ready = await request(server, "GET", "/ready", { token: null });
    expect(ready.status).toBe(503);
    const body = (await ready.json()) as { status: string; detail?: string };
    expect(body.status).toBe("failed");
    expect(body.detail).toBeTruthy();
  });

  it("echoes an inbound request id and generates one otherwise", async () => {
    const { server } = makeServer();
    const echoed = await request(server, "GET", "/config", {
      headers: { "x-request-id": "req-from-caller" },
    });
    expect(echoed.headers.get("x-request-id")).toBe("req-from-caller");

    const generated = await request(server, "GET", "/config");
    expect(generated.headers.get("x-request-id")).toMatch(
      /^[0-9a-f-]{36}$/
    );
  });

  it("turns an unhandled error into a logged 500 carrying the request id", async () => {
    const logs: ServeLogEvent[] = [];
    const { server } = makeServer({
      logs,
      onTask: () => {
        throw new Error("tap exploded");
      },
    });

    const response = await request(server, "POST", "/v1/tasks", {
      body: {},
      headers: { "x-request-id": "req-boom" },
    });
    expect(response.status).toBe(500);
    // The cause is logged, never returned.
    expect(await response.json()).toEqual({
      detail: "Internal Server Error",
      request_id: "req-boom",
    });
    const logged = logs.find((event) => event.event === "unhandled_error");
    expect(logged?.request_id).toBe("req-boom");
    expect(logged?.detail).toBe("tap exploded");
  });

  it("persists task transcripts through the session-manager seam", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "recipes-sessions-"));
    const { server } = makeServer({
      sessionManager: (taskId) =>
        SessionManager.create(sessionDir, sessionDir, { id: taskId }),
      onTask: (_taskId, handle) => scriptReply(handle, "persisted hello"),
    });

    const created = await request(server, "POST", "/v1/tasks", {
      body: { prompt: "hello" },
    });
    expect(created.status).toBe(200);
    const { task, run } = (await created.json()) as {
      task: { id: string };
      run: { id: string };
    };

    // Pi flushes a session file only once an assistant message exists, so a
    // task with no completed turn deliberately leaves nothing on disk.
    await readSse(
      await request(server, "GET", `/v1/tasks/${task.id}/runs/${run.id}/stream`),
      { until: (all) => aguiTypes(all).includes("RUN_FINISHED") }
    );

    // The seam's contract: one session file per task, named by task id,
    // in whatever directory the host chose to back it with.
    const files = readdirSync(sessionDir);
    expect(files.some((name) => name.includes(task.id))).toBe(true);
  });

  it("logs task and run lifecycle with correlatable ids", async () => {
    const logs: ServeLogEvent[] = [];
    const { server } = makeServer({ logs });
    const created = await request(server, "POST", "/v1/tasks", {
      body: { prompt: "hello" },
    });
    const { task, run } = (await created.json()) as {
      task: { id: string };
      run: { id: string };
    };

    const taskCreated = logs.find((event) => event.event === "task.created");
    expect(taskCreated?.task_id).toBe(task.id);
    expect(taskCreated?.persisted).toBe(false);

    const started = logs.find((event) => event.event === "run.started");
    expect(started?.run_id).toBe(run.id);
    expect(started?.task_id).toBe(task.id);
  });
});
