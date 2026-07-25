/**
 * Trace export out of a recipe host: the GenAI instrumentation attaches to
 * engine sessions when telemetry is initialized, serve stamps the task id as
 * the conversation id, and everything stays inert when unconfigured.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { context as otelContext, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { serveRecipe } from "../src/serve.js";
import type { RecipeSessionHandle } from "../src/session.js";
import {
  getRecipeTracer,
  initRecipeTracing,
  instrumentRecipeSession,
  flushRecipeTracing,
  shutdownRecipeTracing,
} from "../src/tracing.js";
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

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "mock-model",
    usage: {
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function scriptedStreamFn(): (...args: unknown[]) => MockAssistantStream {
  return () => {
    const stream = new MockAssistantStream();
    queueMicrotask(() => {
      const text = "traced";
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

describe("recipe telemetry", () => {
  afterEach(async () => {
    await shutdownRecipeTracing();
  });

  it("stays inert when no export target is configured", async () => {
    await expect(initRecipeTracing({ env: {} })).resolves.toBeNull();
    expect(getRecipeTracer()).toBeUndefined();

    const streamFunction = scriptedStreamFn();
    const fakeSession = {
      agent: { streamFunction, subscribe: () => () => {} },
      sessionManager: { getEntries: () => [] },
    } as unknown as AgentSession;
    expect(
      instrumentRecipeSession(fakeSession, {
        meta: { conversationId: "c", agentId: "a", agentName: "agent" },
      })
    ).toBeUndefined();
    expect(fakeSession.agent.streamFunction).toBe(streamFunction);
  });

  it("backs off when the host already registered a global provider", async () => {
    const hostExporter = new InMemorySpanExporter();
    const hostProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(hostExporter)],
    });
    expect(trace.setGlobalTracerProvider(hostProvider)).toBe(true);
    try {
      // Even with an export target configured, the host's provider wins and
      // no recipe provider (or tracer) is created.
      await expect(
        initRecipeTracing({
          spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
        })
      ).resolves.toBeNull();
      expect(getRecipeTracer()).toBeUndefined();
      expect(trace.getTracerProvider()).toBeDefined();
    } finally {
      trace.disable();
      await hostProvider.shutdown();
    }
  });

  it("emits chat spans through the wrapped stream function", async () => {
    const exporter = new InMemorySpanExporter();
    await expect(
      initRecipeTracing({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      })
    ).resolves.not.toBeNull();

    const original = scriptedStreamFn();
    const fakeSession = {
      agent: { streamFunction: original, subscribe: () => () => {} },
      sessionManager: { getEntries: () => [] },
    } as unknown as AgentSession;
    const detach = instrumentRecipeSession(fakeSession, {
      meta: {
        conversationId: "conv-1",
        agentId: "fixture/agent",
        agentName: "agent",
      },
    });
    expect(detach).toBeTypeOf("function");
    expect(fakeSession.agent.streamFunction).not.toBe(original);

    const model = {
      id: "mock-model",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://example.invalid",
    };
    const proxy = (
      fakeSession.agent.streamFunction as unknown as (
        model: unknown,
        context: unknown,
        options?: unknown
      ) => AsyncIterable<{ type: string }>
    )(model, { messages: [], tools: [] }, {});
    const seen: string[] = [];
    for await (const event of proxy) seen.push(event.type);
    expect(seen.at(-1)).toBe("done");

    const spans = exporter.getFinishedSpans();
    const chat = spans.find((span) => span.name === "chat mock-model");
    expect(chat).toBeDefined();
    expect(chat!.attributes["gen_ai.conversation.id"]).toBe("conv-1");
    expect(chat!.attributes["gen_ai.agent.name"]).toBe("agent");
    expect(chat!.attributes["gen_ai.provider.name"]).toBe("anthropic");
    expect(chat!.attributes["gen_ai.usage.input_tokens"]).toBe(3);
    expect(chat!.attributes["gen_ai.usage.output_tokens"]).toBe(5);

    detach!();
    expect(fakeSession.agent.streamFunction).toBe(original);
  });

  it("hosts that own their span topology parent chat spans themselves", async () => {
    const exporter = new InMemorySpanExporter();
    await initRecipeTracing({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracer = getRecipeTracer()!;

    const original = scriptedStreamFn();
    const fakeSession = {
      agent: { streamFunction: original, subscribe: () => () => {} },
      sessionManager: { getEntries: () => [] },
    } as unknown as AgentSession;

    // The host's own turn span stands in for runtime-agent's turn context.
    const turnSpan = tracer.startSpan("host_turn");
    const turnContext = trace.setSpan(otelContext.active(), turnSpan);
    instrumentRecipeSession(fakeSession, {
      meta: { conversationId: "conv-3", agentId: "a", agentName: "agent" },
      runSpans: false,
      getParentContext: () => turnContext,
      abortTerminationReason: () => "cancelled",
      extraAttributes: () => ({ "host.tenant": "org-1" }),
    });

    const proxy = (
      fakeSession.agent.streamFunction as unknown as (
        model: unknown,
        context: unknown,
        options?: unknown
      ) => AsyncIterable<{ type: string }>
    )(
      {
        id: "mock-model",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://example.invalid",
      },
      { messages: [], tools: [] },
      {}
    );
    for await (const _event of proxy) {
      // drain
    }
    turnSpan.end();

    const spans = exporter.getFinishedSpans();
    expect(spans.find((s) => s.name.startsWith("invoke_agent"))).toBeUndefined();
    const chat = spans.find((s) => s.name === "chat mock-model");
    expect(chat).toBeDefined();
    expect(chat!.attributes["host.tenant"]).toBe("org-1");
    expect(chat!.parentSpanContext?.spanId).toBe(
      turnSpan.spanContext().spanId
    );
  });

  it("exports to the Introspection ingest with a bearer, from env alone", async () => {
    const requests: { url: string; auth: string | undefined }[] = [];
    const receiver = createServer((req, res) => {
      requests.push({
        url: req.url ?? "",
        auth: req.headers.authorization,
      });
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/x-protobuf" });
        res.end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
    const port = (receiver.address() as AddressInfo).port;

    try {
      const handle = await initRecipeTracing({
        env: {
          INTROSPECTION_TOKEN: "ingest-token",
          INTROSPECTION_BASE_OTEL_URL: `http://127.0.0.1:${port}`,
        },
      });
      expect(handle).not.toBeNull();

      const fakeSession = {
        agent: {
          streamFunction: scriptedStreamFn(),
          subscribe: () => () => {},
        },
        sessionManager: { getEntries: () => [] },
      } as unknown as AgentSession;
      instrumentRecipeSession(fakeSession, {
        meta: { conversationId: "conv-2", agentId: "a", agentName: "agent" },
      });
      const proxy = (
        fakeSession.agent.streamFunction as unknown as (
          model: unknown,
          context: unknown,
          options?: unknown
        ) => AsyncIterable<{ type: string }>
      )(
        {
          id: "mock-model",
          provider: "anthropic",
          api: "anthropic-messages",
          baseUrl: "https://example.invalid",
        },
        { messages: [], tools: [] },
        {}
      );
      for await (const _event of proxy) {
        // drain
      }

      await handle!.shutdown();
      expect(requests.length).toBeGreaterThan(0);
      expect(requests[0]!.url).toBe("/v1/traces");
      expect(requests[0]!.auth).toBe("Bearer ingest-token");
    } finally {
      receiver.close();
    }
  }, 20_000);

  it("serve groups a task's spans under the task id", async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = "telemetry-test-key";
    }
    const exporter = new InMemorySpanExporter();
    await initRecipeTracing({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    const fixture = writeFixtureRecipe();
    const server = serveRecipe({
      recipeDir: fixture.recipeDir,
      workspace: fixture.workspaceDir,
      onTask: (_taskId, handle: RecipeSessionHandle) => {
        // Replacing the stream function post-creation drops the chat-span
        // wrapper for this scripted session; run/tool spans still flow from
        // the agent subscription, which is what this test asserts on.
        (handle.session.agent as { streamFunction: unknown }).streamFunction =
          scriptedStreamFn();
      },
    });
    try {
      const created = (await (
        await server.fetch(
          new Request("http://serve.local/v1/tasks", {
            method: "POST",
            body: JSON.stringify({ prompt: "ping" }),
          })
        )
      ).json()) as { task: { id: string }; run: { id: string } };

      for (let i = 0; i < 200; i += 1) {
        const view = (await (
          await server.fetch(
            new Request(
              `http://serve.local/v1/tasks/${created.task.id}/runs/${created.run.id}`
            )
          )
        ).json()) as { status: string };
        if (view.status !== "running") {
          expect(view.status).toBe("completed");
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      await flushRecipeTracing();
      const spans = exporter.getFinishedSpans();
      const run = spans.find((span) => span.name.startsWith("invoke_agent"));
      expect(run).toBeDefined();
      expect(run!.attributes["gen_ai.conversation.id"]).toBe(created.task.id);
    } finally {
      await server.close();
      fixture.cleanup();
    }
  }, 30_000);
});
