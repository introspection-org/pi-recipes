/**
 * The serve compatibility promise, enforced: an Introspection SDK task
 * client — the real @introspection-sdk/introspection-node TasksApi —
 * round-trips against a served recipe's base URL unchanged
 * (create → run → stream → cancel), over a real listening socket.
 */
import { EventType } from "@ag-ui/core";
import { HttpClient, TasksApi } from "@introspection-sdk/introspection-node";
import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai/compat";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveRecipe, type RecipeServer } from "../src/serve.js";
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

/** Reply with streamed text on the first turn, hang-until-abort after. */
function scriptSession(handle: RecipeSessionHandle): void {
  let turn = 0;
  handle.session.agent.streamFunction = (_model, _context, options) => {
    const stream = new MockAssistantStream();
    const signal = options?.signal;
    const thisTurn = ++turn;
    queueMicrotask(() => {
      stream.push({ type: "start", partial: assistantMessage("") });
      if (thisTurn === 1) {
        const text = "round-trip ok";
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
        return;
      }
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

const TOKEN = "sdk-roundtrip-token";
const PORT = 18000 + Math.floor(Math.random() * 2000);

describe("SDK task client round-trip", () => {
  let server: RecipeServer;
  let cleanup: () => void;
  let tasks: TasksApi;

  beforeAll(async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = "sdk-roundtrip-key";
    }
    const fixture = writeFixtureRecipe();
    cleanup = fixture.cleanup;
    server = serveRecipe({
      recipeDir: fixture.recipeDir,
      token: TOKEN,
      workspace: fixture.workspaceDir,
      onTask: (_taskId, handle) => scriptSession(handle),
    });
    await server.listen({ port: PORT, hostname: "127.0.0.1" });
    tasks = new TasksApi(
      new HttpClient({ apiUrl: `http://127.0.0.1:${PORT}`, token: TOKEN })
    );
  }, 30_000);

  afterAll(async () => {
    await server.close();
    cleanup();
  });

  it("create → run → stream → text, unchanged", async () => {
    const handle = await tasks.start({ prompt: "ping" });
    expect(handle.task?.id).toBeTruthy();
    expect(handle.run.task_id).toBe(handle.task!.id);

    const text = await handle.text();
    expect(text).toBe("round-trip ok");

    const view = await tasks.runs.get(handle.run.task_id, handle.run.id);
    expect(view.status).toBe("completed");
  }, 20_000);

  it("streams typed AG-UI events the SDK can parse", async () => {
    const created = await tasks.create({ prompt: "ping" } as never);
    const types: string[] = [];
    for await (const event of tasks.runs.stream(
      created.task.id,
      created.run.id
    )) {
      types.push(event.type);
    }
    // The stream opens with the resume meta-event (CUSTOM: catch_up /
    // replay / subscribed), then the run's events with their indexes.
    expect(types[0]).toBe(EventType.CUSTOM);
    expect(types[1]).toBe(EventType.RUN_STARTED);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types.at(-1)).toBe(EventType.RUN_FINISHED);
  }, 20_000);

  it("cancel settles a hanging run as cancelled", async () => {
    const first = await tasks.start({ prompt: "warm up" });
    await first.text();

    // Second turn hangs until abort (scripted): submit and cancel it.
    const run = await tasks.runs.create(first.run.task_id, {
      prompt: { text: "hang" },
    });
    const cancelled = await run.cancel();
    expect(cancelled.id).toBe(run.run.id);
    for (let i = 0; i < 200; i += 1) {
      const view = await tasks.runs.get(run.run.task_id, run.run.id);
      if (view.status !== "running") {
        expect(view.status).toBe("cancelled");
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("cancel never settled");
  }, 20_000);

  it("lists and deletes through the paginator", async () => {
    const before: string[] = [];
    for await (const task of tasks.list({ limit: 2 })) {
      before.push(task.id);
    }
    expect(before.length).toBeGreaterThan(0);
    for (const id of before) {
      await tasks.delete(id);
    }
    const after = await tasks.list();
    expect(after.records).toHaveLength(0);
  }, 20_000);
});
