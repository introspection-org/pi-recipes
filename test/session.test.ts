import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventStream,
  getModel,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai/compat";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpBindingError } from "../src/mcp.js";
import {
  resolveRecipeAgent,
  resolveRecipe,
} from "../src/recipe/resolve.js";
import { runRecipe } from "../src/run.js";
import { createInProcessRunController } from "../src/run-controller.js";
import {
  createAgentSessionFromRecipe,
  createAgentSession,
  RecipeCredentialError,
  RecipeMcpEnvironmentInUseError,
  RecipeModelError,
  type RecipeSessionHandle,
} from "../src/session.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";

const detachTelemetry = vi.hoisted(() => vi.fn());
const instrumentSession = vi.hoisted(() =>
  vi.fn(() => ({ detach: detachTelemetry }))
);

vi.mock("@introspection-sdk/introspection-pi", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@introspection-sdk/introspection-pi")
  >()),
  instrumentSession,
}));

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
      stream.push({ type: "done", reason: "stop", message: assistantMessage(text) });
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

function scriptError(handle: RecipeSessionHandle): void {
  handle.session.agent.streamFunction = () => {
    const stream = new MockAssistantStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: assistantMessage("") });
      stream.push({
        type: "error",
        reason: "error",
        error: assistantMessage("provider exploded", "error"),
      });
    });
    return stream;
  };
}

async function credentialStore(): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: "test-key",
  }));
  return store;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createAgentSessionFromRecipe", () => {
  const cleanups: Array<() => void> = [];
  const handles: RecipeSessionHandle[] = [];

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      await handle.dispose().catch(() => {});
    }
    for (const cleanup of cleanups.splice(0)) cleanup();
    instrumentSession.mockClear();
    detachTelemetry.mockClear();
  });

  function fixture(options?: Parameters<typeof writeFixtureRecipe>[0]) {
    const created = writeFixtureRecipe(options);
    cleanups.push(created.cleanup);
    return created;
  }

  async function open(
    options: Partial<Parameters<typeof createAgentSessionFromRecipe>[0]> & {
      recipeDir: string;
      cwd: string;
    }
  ): Promise<RecipeSessionHandle> {
    const handle = await createAgentSessionFromRecipe({
      credentials: await credentialStore(),
      env: cleanEnv(),
      ...options,
    });
    handles.push(handle);
    return handle;
  }

  it("creates a live session from a recipe directory", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const handle = await open({ recipeDir, cwd: workspaceDir });

    expect(handle.agent.name).toBe("agent");
    expect(handle.session.model?.id).toBe("claude-sonnet-4-5");
    expect(handle.session.systemPrompt).toContain("conformance fixture");
    expect(handle.session.systemPrompt).toContain("Conformance agent");
  });

  it("creates the exact Recipe definition already inspected by the host", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const recipe = resolveRecipeAgent({ recipeDir });
    const handle = await createAgentSession(recipe, {
      cwd: workspaceDir,
      credentials: await credentialStore(),
      env: cleanEnv(),
    });
    handles.push(handle);

    expect(handle.agent).toBe(recipe);
    expect(handle.agent.name).toBe("agent");
  });

  it("accepts host model wiring and reports construction diagnostics", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const base = getModel("anthropic", "claude-sonnet-4-5");
    expect(base).toBeDefined();
    const modelOverride = {
      ...base!,
      baseUrl: "https://managed-gateway.example/v1",
    };
    const onDiagnostics = vi.fn();

    const handle = await open({
      recipeDir,
      cwd: workspaceDir,
      modelOverride,
      onDiagnostics,
    });

    expect(handle.session.model?.baseUrl).toBe(
      "https://managed-gateway.example/v1"
    );
    expect(onDiagnostics).toHaveBeenCalledOnce();
  });

  it("normalizes Gemini tool schemas for every host", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const base = getModel("anthropic", "claude-sonnet-4-5");
    expect(base).toBeDefined();
    const parameters = Type.Object({
      nested: Type.Object({}, { additionalProperties: false }),
    });
    const symbolMetadata = Symbol("schema-metadata");
    Object.defineProperty(parameters, symbolMetadata, {
      value: "preserved",
      enumerable: false,
    });
    const handle = await open({
      recipeDir,
      cwd: workspaceDir,
      modelOverride: {
        ...base!,
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
      },
      customTools: [
        {
          name: "read",
          description: "Structured tool",
          parameters,
          execute: async () => ({ content: [], details: {} }),
        } as never,
      ],
    });

    const tool = handle.session.agent.state.tools.find(
      (candidate) => candidate.name === "read"
    );
    expect(tool?.parameters).toEqual({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: {},
        },
      },
      required: ["nested"],
    });
    expect(Object.getPrototypeOf(tool?.parameters)).toBe(
      Object.getPrototypeOf(parameters)
    );
    expect(
      (tool?.parameters as Record<PropertyKey, unknown>)[symbolMetadata]
    ).toBe("preserved");
    expect(
      Object.getOwnPropertyDescriptor(tool?.parameters, symbolMetadata)
        ?.enumerable
    ).toBe(false);
  });

  it("resolves credentials from provider env keys when no store is given", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const handle = await createAgentSessionFromRecipe({
      recipeDir,
      cwd: workspaceDir,
      env: { ...cleanEnv(), ANTHROPIC_API_KEY: "env-key" },
    });
    handles.push(handle);
    expect(handle.session.model?.provider).toBe("anthropic");
  });

  it("fails closed when the provider has no credential", async () => {
    const { recipeDir, workspaceDir } = fixture();
    await expect(
      createAgentSessionFromRecipe({ recipeDir, cwd: workspaceDir, env: cleanEnv() })
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RecipeCredentialError);
      expect((err as Error).message).toContain("ANTHROPIC_API_KEY");
      return true;
    });
  });

  it("fails closed on an unknown model spec", async () => {
    const { recipeDir, workspaceDir } = fixture();
    await expect(
      open({ recipeDir, cwd: workspaceDir, model: "anthropic/not-a-model" })
    ).rejects.toBeInstanceOf(RecipeModelError);
  });

  it("fails closed on an unbound required MCP server, naming it", async () => {
    const { recipeDir, workspaceDir } = fixture({
      manifestPi: {
        mcp: {
          servers: [{ id: "linear", required: true, tools: { include: ["*"] } }],
        },
      },
      agentExtras: ["mcp:", "  linear:", '    include: ["*"]'],
    });
    await expect(
      open({ recipeDir, cwd: workspaceDir })
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(McpBindingError);
      expect((err as McpBindingError).servers).toEqual(["linear"]);
      expect((err as Error).message).toContain("LINEAR_MCP_URL");
      return true;
    });
  });

  it("materializes inline MCP bindings", async () => {
    const { recipeDir, workspaceDir } = fixture({
      manifestPi: {
        mcp: {
          servers: [{ id: "linear", required: true, tools: { include: ["*"] } }],
        },
      },
      agentExtras: ["mcp:", "  linear:", '    include: ["*"]'],
    });
    const env = cleanEnv();
    const handle = await open({
      recipeDir,
      cwd: workspaceDir,
      env,
      mcpBindings: {
        servers: [
          {
            id: "linear",
            transport: "streamable_http",
            url: "http://127.0.0.1:9/mcp",
          },
        ],
      },
    });
    expect(env.PI_RECIPES_MCP_SESSION).toBeDefined();
    await handle.dispose();
  });

  it("does not clobber host MCP state when a Recipe selects no MCP servers", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const env = {
      ...cleanEnv(),
      PI_RECIPES_MCP_SESSION: "/host/session.json",
      MCPORTER_CONFIG: "/host/mcporter.json",
    };
    const handle = await open({ recipeDir, cwd: workspaceDir, env });

    expect(env.PI_RECIPES_MCP_SESSION).toBe("/host/session.json");
    expect(env.MCPORTER_CONFIG).toBe("/host/mcporter.json");
    await handle.dispose();
    expect(env.PI_RECIPES_MCP_SESSION).toBe("/host/session.json");
    expect(env.MCPORTER_CONFIG).toBe("/host/mcporter.json");
  });

  it("leases and restores a host environment for materialized MCP", async () => {
    const { recipeDir, workspaceDir } = fixture({
      manifestPi: {
        mcp: {
          servers: [
            { id: "linear", required: true, tools: { include: ["*"] } },
          ],
        },
      },
      agentExtras: ["mcp:", "  linear:", '    include: ["*"]'],
    });
    const hostSession = join(workspaceDir, "host-session.json");
    const hostMcporter = join(workspaceDir, "host-mcporter.json");
    const env = {
      ...cleanEnv(),
      PI_RECIPES_MCP_SESSION: hostSession,
      MCPORTER_CONFIG: hostMcporter,
    };
    const options = {
      recipeDir,
      cwd: workspaceDir,
      env,
      mcpBindings: {
        servers: [
          {
            id: "linear",
            transport: "streamable_http",
            url: "http://127.0.0.1:9/mcp",
          },
        ],
      },
    };
    const first = await open(options);

    await expect(open(options)).rejects.toBeInstanceOf(
      RecipeMcpEnvironmentInUseError
    );
    expect(env.PI_RECIPES_MCP_SESSION).not.toBe(hostSession);

    await first.dispose();
    expect(env.PI_RECIPES_MCP_SESSION).toBe(hostSession);
    expect(env.MCPORTER_CONFIG).toBe(hostMcporter);
  });

  it("rolls back materialized MCP when session construction fails", async () => {
    const { recipeDir, workspaceDir } = fixture({
      manifestPi: {
        mcp: {
          servers: [
            { id: "linear", required: true, tools: { include: ["*"] } },
          ],
        },
      },
      agentExtras: ["mcp:", "  linear:", '    include: ["*"]'],
    });
    const hostSession = join(workspaceDir, "host-session.json");
    const hostMcporter = join(workspaceDir, "host-mcporter.json");
    const env = {
      ...cleanEnv(),
      PI_RECIPES_MCP_SESSION: hostSession,
      MCPORTER_CONFIG: hostMcporter,
    };
    const baseOptions = {
      recipeDir,
      cwd: workspaceDir,
      env,
      credentials: await credentialStore(),
      mcpBindings: {
        servers: [
          {
            id: "linear",
            transport: "streamable_http",
            url: "http://127.0.0.1:9/mcp",
          },
        ],
      },
    };

    await expect(
      createAgentSessionFromRecipe({
        ...baseOptions,
        systemPrompt: () => {
          throw new Error("prompt construction failed");
        },
      })
    ).rejects.toThrow("prompt construction failed");
    expect(env.PI_RECIPES_MCP_SESSION).toBe(hostSession);
    expect(env.MCPORTER_CONFIG).toBe(hostMcporter);

    const recovered = await createAgentSessionFromRecipe(baseOptions);
    handles.push(recovered);
    await recovered.dispose();
  });

  it("prompts through a scripted model and surfaces the reply", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const handle = await open({ recipeDir, cwd: workspaceDir });
    scriptReply(handle, "scripted hello");

    await handle.session.prompt("hi");
    const last = handle.session.messages.at(-1) as { content?: unknown };
    expect(JSON.stringify(last?.content)).toContain("scripted hello");
  });

  it("taps session events through onEvent and detaches on dispose", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const events: string[] = [];
    const handle = await open({
      recipeDir,
      cwd: workspaceDir,
      onEvent: (event) => events.push(event.type),
    });
    scriptReply(handle, "ok");
    await handle.session.prompt("hi");
    expect(events).toContain("agent_start");
    expect(events).toContain("agent_end");
  });

  it("closes completed child sessions when the parent disposes", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const child = {
      agent_run_id: "child-1",
      invocation_name: "helper",
      agent_name: "helper",
      label: "helper",
      prompt: "help",
      status: "completed" as const,
      started_at: 1,
      last_activity_at: 2,
    };
    const close = vi.fn(async (_id: string) => ({
      ...child,
      status: "closed" as const,
    }));
    const runController = {
      list: () => [child],
      get: () => null,
      start: vi.fn(),
      wait: vi.fn(),
      message: vi.fn(),
      interrupt: vi.fn(),
      close,
      shutdown: vi.fn(async () => {
        await close("child-1");
      }),
    };
    const handle = await open({
      recipeDir,
      cwd: workspaceDir,
      runController,
    });

    await handle.dispose();
    expect(runController.shutdown).toHaveBeenCalledOnce();
  });

  it("attaches a host-owned OTel tracer and detaches it on dispose", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const tracer = {} as never;
    const handle = await open({
      recipeDir,
      cwd: workspaceDir,
      otel: {
        tracer,
        runSpans: false,
        meta: { conversationId: "conversation-1" },
      },
    });

    expect(instrumentSession).toHaveBeenCalledOnce();
    expect(instrumentSession).toHaveBeenCalledWith(
      handle.session,
      expect.objectContaining({
        tracer,
        runSpans: false,
        meta: {
          conversationId: "conversation-1",
          agentId: "conformance-fixture/agent",
          agentName: "agent",
        },
      })
    );

    await handle.dispose();
    expect(detachTelemetry).toHaveBeenCalledOnce();
  });
});

describe("runRecipe", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function fixture() {
    const created = writeFixtureRecipe();
    cleanups.push(created.cleanup);
    return created;
  }

  function scriptedFactory(script: (handle: RecipeSessionHandle) => void) {
    return async (
      options: Parameters<typeof createAgentSessionFromRecipe>[0]
    ): Promise<RecipeSessionHandle> => {
      const handle = await createAgentSessionFromRecipe(options);
      script(handle);
      return handle;
    };
  }

  it("returns finished with the assistant text", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const result = await runRecipe({
      recipeDir,
      cwd: workspaceDir,
      credentials: await credentialStore(),
      env: cleanEnv(),
      prompt: "hi",
      sessionFactory: scriptedFactory((handle) =>
        scriptReply(handle, "one-shot reply")
      ),
    });
    expect(result.status).toBe("finished");
    expect(result.text).toBe("one-shot reply");
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("returns failed, never throws, on agent-level error", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const result = await runRecipe({
      recipeDir,
      cwd: workspaceDir,
      credentials: await credentialStore(),
      env: cleanEnv(),
      prompt: "hi",
      sessionFactory: scriptedFactory(scriptError),
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBeTruthy();
  });

  it("returns cancelled on timeout, and always disposes", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const result = await runRecipe({
      recipeDir,
      cwd: workspaceDir,
      credentials: await credentialStore(),
      env: cleanEnv(),
      prompt: "hi",
      timeoutMs: 100,
      sessionFactory: scriptedFactory(scriptHangUntilAbort),
    });
    expect(result.status).toBe("cancelled");
  });

  it("throws on caller mistakes (empty prompt)", async () => {
    const { recipeDir, workspaceDir } = fixture();
    await expect(
      runRecipe({
        recipeDir,
        cwd: workspaceDir,
        credentials: await credentialStore(),
        env: cleanEnv(),
        prompt: "   ",
      })
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("returns cancelled when the signal is already aborted", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const controller = new AbortController();
    controller.abort();
    const result = await runRecipe({
      recipeDir,
      cwd: workspaceDir,
      credentials: await credentialStore(),
      env: cleanEnv(),
      prompt: "hi",
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
  });

  it("returns cancelled when the signal aborts during session construction", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const controller = new AbortController();
    const result = await runRecipe({
      recipeDir,
      cwd: workspaceDir,
      credentials: await credentialStore(),
      env: cleanEnv(),
      prompt: "hi",
      signal: controller.signal,
      sessionFactory: async (options) => {
        const handle = await createAgentSessionFromRecipe(options);
        controller.abort();
        return handle;
      },
    });

    expect(result.status).toBe("cancelled");
    expect(result.messages).toEqual([]);
  });
});

describe("in-process run controller", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function fixture() {
    const created = writeFixtureRecipe({ subagents: ["helper"] });
    cleanups.push(created.cleanup);
    return created;
  }

  it("settles a vanished-profile start as failed without wedging", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
    });
    const run = await controller.start({ name: "ghost", prompt: "hello" });
    const settled = await controller.wait(run.agent_run_id);
    expect(settled.status).toBe("failed");
    expect(settled.error).toBeTruthy();
  });

  it("runs a child through an injected session factory", async () => {
    const { recipeDir, workspaceDir } = fixture();
    let scripted: RecipeSessionHandle | null = null;
    let childOptions:
      | Parameters<typeof createAgentSession>[1]
      | undefined;
    const tracer = {} as never;
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      otel: {
        tracer,
        meta: {
          conversationId: "conversation-tree",
          agentId: "root-id",
          agentName: "root",
        },
      },
      sessionFactory: async (agent, options) => {
        childOptions = options;
        const handle = await createAgentSession(agent, {
          ...options,
          credentials: await credentialStore(),
        });
        scripted = handle;
        scriptReply(handle, "child says hi");
        return handle;
      },
    });
    const run = await controller.start({ name: "helper", prompt: "go" });
    const settled = await controller.wait(run.agent_run_id);
    expect(settled.status).toBe("completed");
    expect(settled.output).toContain("child says hi");
    expect(childOptions?.otel).toMatchObject({
      tracer,
      meta: { conversationId: "conversation-tree" },
    });
    expect(childOptions?.otel?.meta?.agentId).toBeUndefined();
    expect(childOptions?.otel?.meta?.agentName).toBeUndefined();
    expect(childOptions?.runController).toBeNull();
    await controller.close(run.agent_run_id);
    expect(scripted).not.toBeNull();
  });

  it("bounds concurrency", async () => {
    const { recipeDir, workspaceDir } = fixture();
    let live = 0;
    let peak = 0;
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      concurrency: 1,
      sessionFactory: async (agent, options) => {
        const handle = await createAgentSession(agent, {
          ...options,
          credentials: await credentialStore(),
        });
        handle.session.agent.streamFunction = () => {
          const stream = new MockAssistantStream();
          live += 1;
          peak = Math.max(peak, live);
          setTimeout(() => {
            live -= 1;
            stream.push({ type: "start", partial: assistantMessage("") });
            stream.push({ type: "done", reason: "stop", message: assistantMessage("done") });
          }, 50);
          return stream;
        };
        return handle;
      },
    });
    const first = await controller.start({ name: "helper", prompt: "a" });
    const second = await controller.start({ name: "helper", prompt: "b" });
    await controller.wait(first.agent_run_id);
    await controller.wait(second.agent_run_id);
    expect(peak).toBe(1);
    await controller.close(first.agent_run_id);
    await controller.close(second.agent_run_id);
  });

  it("serializes a message sent while the child session is starting", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const factoryGate = deferred();
    let factoryCalls = 0;
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      sessionFactory: async (agent, options) => {
        factoryCalls += 1;
        await factoryGate.promise;
        const handle = await createAgentSession(agent, {
          ...options,
          credentials: await credentialStore(),
        });
        scriptReply(handle, "done");
        return handle;
      },
    });

    const run = await controller.start({ name: "helper", prompt: "first" });
    const followUp = controller.message(run.agent_run_id, "second");
    factoryGate.resolve();
    await followUp;
    await controller.wait(run.agent_run_id);

    expect(factoryCalls).toBe(1);
    await controller.close(run.agent_run_id);
  });

  it("does not prompt a child interrupted while its session is starting", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const factoryGate = deferred();
    const constructed = deferred();
    const prompt = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      sessionFactory: async () => {
        await factoryGate.promise;
        constructed.resolve();
        return {
          session: {
            prompt,
            messages: [],
          },
          dispose,
        } as unknown as RecipeSessionHandle;
      },
    });

    const run = await controller.start({ name: "helper", prompt: "first" });
    await controller.interrupt(run.agent_run_id);
    factoryGate.resolve();
    await constructed.promise;
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());

    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not finish shutdown until a constructing child has quiesced", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const factoryGate = deferred();
    const factoryEntered = deferred();
    const dispose = vi.fn(async () => {});
    const prompt = vi.fn(async () => {});
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      sessionFactory: async () => {
        factoryEntered.resolve();
        await factoryGate.promise;
        return {
          session: { prompt, messages: [] },
          dispose,
        } as unknown as RecipeSessionHandle;
      },
    });

    await controller.start({ name: "helper", prompt: "first" });
    await factoryEntered.promise;
    let shutdownFinished = false;
    const shutdown = controller.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);

    factoryGate.resolve();
    await shutdown;

    expect(prompt).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(controller.list()[0]?.status).toBe("closed");
  });

  it("rejects an already-aborted child wait immediately", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const factoryGate = deferred();
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      sessionFactory: async () => {
        await factoryGate.promise;
        throw new Error("not reached");
      },
    });
    const run = await controller.start({ name: "helper", prompt: "first" });
    const signal = new AbortController();
    signal.abort(new Error("stop waiting"));

    await expect(
      controller.wait(run.agent_run_id, signal.signal)
    ).rejects.toThrow("stop waiting");
    await controller.interrupt(run.agent_run_id);
    factoryGate.resolve();
  });

  it("clears terminal output and tool state before a follow-up", async () => {
    const { recipeDir, workspaceDir } = fixture();
    let onEvent:
      | ((event: {
          type: string;
          toolName?: string;
        }) => void)
      | undefined;
    const controller = createInProcessRunController({
      recipe: resolveRecipe({ recipeDir }),
      cwd: workspaceDir,
      env: cleanEnv(),
      sessionFactory: async (_agent, options) => {
        onEvent = options.onEvent as typeof onEvent;
        return {
          session: {
            messages: [{ role: "assistant", content: "done" }],
            prompt: vi.fn(async () => {
              onEvent?.({ type: "tool_execution_start", toolName: "search" });
              onEvent?.({ type: "tool_execution_end", toolName: "search" });
            }),
            steer: vi.fn(async () => {}),
            abort: vi.fn(async () => {}),
          },
          dispose: vi.fn(async () => {}),
        } as unknown as RecipeSessionHandle;
      },
    });
    const run = await controller.start({ name: "helper", prompt: "first" });
    const completed = await controller.wait(run.agent_run_id);
    expect(completed.output).toBeTruthy();
    expect(completed.current_tool).toBeUndefined();

    const resumed = await controller.message(run.agent_run_id, "second");
    expect(resumed.status).toBe("running");
    expect(resumed.completed_at).toBeUndefined();
    expect(resumed.output).toBeUndefined();
    expect(resumed.error).toBeUndefined();
    await controller.wait(run.agent_run_id);
    await controller.close(run.agent_run_id);
  });
});
