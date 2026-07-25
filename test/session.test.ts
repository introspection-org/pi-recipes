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
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpBindingError } from "../src/mcp.js";
import { runRecipe } from "../src/run.js";
import { createInProcessRunController } from "../src/run-controller.js";
import {
  createRecipeSession,
  RecipeCredentialError,
  RecipeModelError,
  type RecipeSessionHandle,
} from "../src/session.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";

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

describe("createRecipeSession", () => {
  const cleanups: Array<() => void> = [];
  const handles: RecipeSessionHandle[] = [];

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      await handle.dispose().catch(() => {});
    }
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function fixture(options?: Parameters<typeof writeFixtureRecipe>[0]) {
    const created = writeFixtureRecipe(options);
    cleanups.push(created.cleanup);
    return created;
  }

  async function open(
    options: Partial<Parameters<typeof createRecipeSession>[0]> & {
      recipeDir: string;
      cwd: string;
    }
  ): Promise<RecipeSessionHandle> {
    const handle = await createRecipeSession({
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

    expect(handle.recipe.agentName).toBe("agent");
    expect(handle.session.model?.id).toBe("claude-sonnet-4-5");
    expect(handle.session.systemPrompt).toContain("conformance fixture");
    expect(handle.session.systemPrompt).toContain("Conformance agent");
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

  it("resolves credentials from provider env keys when no store is given", async () => {
    const { recipeDir, workspaceDir } = fixture();
    const handle = await createRecipeSession({
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
      createRecipeSession({ recipeDir, cwd: workspaceDir, env: cleanEnv() })
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
      options: Parameters<typeof createRecipeSession>[0]
    ): Promise<RecipeSessionHandle> => {
      const handle = await createRecipeSession(options);
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
      recipeDir,
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
    const controller = createInProcessRunController({
      recipeDir,
      cwd: workspaceDir,
      env: cleanEnv(),
      sessionFactory: async (options) => {
        const handle = await createRecipeSession({
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
    await controller.close(run.agent_run_id);
    expect(scripted).not.toBeNull();
  });

  it("bounds concurrency", async () => {
    const { recipeDir, workspaceDir } = fixture();
    let live = 0;
    let peak = 0;
    const controller = createInProcessRunController({
      recipeDir,
      cwd: workspaceDir,
      env: cleanEnv(),
      concurrency: 1,
      sessionFactory: async (options) => {
        const handle = await createRecipeSession({
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
});
