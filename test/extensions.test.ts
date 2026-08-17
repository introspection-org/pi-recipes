import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  bindRecipeExtensionFactory,
  createRecipeExtensionRegistrationRegistry,
  forAgent,
  forRecipeSession,
  getRecipeSessionContext,
  recipeExtensionToolAllowlist,
  type RecipeExtensionSessionContext,
} from "../src/extensions.js";

function context(
  agent = "reviewer",
  role: "root" | "subagent" = "root"
): RecipeExtensionSessionContext {
  return Object.freeze({
    recipe: Object.freeze({ name: "demo" }),
    agent: Object.freeze({ name: agent }),
    session: Object.freeze({ role }),
  });
}

function api(): ExtensionAPI {
  return {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
}

interface HostApi extends ExtensionAPI {
  tools: Map<string, { name: string; execute: (...args: unknown[]) => unknown }>;
  commands: Map<string, { handler: (...args: unknown[]) => unknown }>;
  shortcuts: Map<string, { handler: (...args: unknown[]) => unknown }>;
  renderers: Map<string, (...args: unknown[]) => unknown>;
  listeners: Map<string, Array<(...args: unknown[]) => unknown>>;
  providers: Set<string>;
  emit(event: string, ...args: unknown[]): unknown[];
}

/**
 * A host that keeps registrations for its whole lifetime, the way Pi does:
 * only providers can be removed, so everything else must be neutralized in
 * place when a Recipe extension is unwound.
 */
function hostApi(): HostApi {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const renderers = new Map<string, any>();
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const providers = new Set<string>();
  return {
    tools,
    commands,
    shortcuts,
    renderers,
    listeners,
    providers,
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    registerShortcut(shortcut: string, options: any) {
      shortcuts.set(shortcut, options);
    },
    registerMessageRenderer(customType: string, renderer: any) {
      renderers.set(customType, renderer);
    },
    registerEntryRenderer(customType: string, renderer: any) {
      renderers.set(customType, renderer);
    },
    registerProvider(provider: any) {
      providers.add(provider.id);
    },
    unregisterProvider(id: string) {
      providers.delete(id);
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    setActiveTools: vi.fn(),
    emit(event: string, ...args: unknown[]) {
      return (listeners.get(event) ?? []).map((handler) => handler(...args));
    },
  } as unknown as HostApi;
}

describe("Recipe extension context", () => {
  it("shares context across separate Recipes module instances", async () => {
    const bindingModule = await import("../src/extensions.js");
    vi.resetModules();
    const consumingModule = await import("../src/extensions.js");
    const matched = vi.fn();
    const factory = bindingModule.bindRecipeExtensionFactory(
      (extensionApi) => {
        consumingModule.forAgent(extensionApi, "reviewer", matched);
      },
      context("reviewer", "root")
    );

    expect(bindingModule).not.toBe(consumingModule);
    await factory(api());

    expect(matched).toHaveBeenCalledOnce();
  });

  it("binds immutable agent and session identity before factory execution", async () => {
    const pi = api();
    const seen: RecipeExtensionSessionContext[] = [];
    const factory = bindRecipeExtensionFactory(
      (extensionApi) => {
        seen.push(getRecipeSessionContext(extensionApi));
      },
      context("researcher", "subagent")
    );

    await factory(pi);

    expect(seen).toEqual([
      {
        recipe: { name: "demo" },
        agent: { name: "researcher" },
        session: { role: "subagent" },
      },
    ]);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[0]?.agent)).toBe(true);
  });

  it("registers conditional behavior only for matching sessions", async () => {
    const pi = api();
    const reviewer = vi.fn();
    const researcher = vi.fn();
    const child = vi.fn();
    const factory = bindRecipeExtensionFactory(
      (extensionApi) => {
        forAgent(extensionApi, "reviewer", reviewer);
        forAgent(extensionApi, "researcher", researcher);
        forRecipeSession(
          extensionApi,
          ({ session }) => session.role === "subagent",
          child
        );
      },
      context("reviewer", "root")
    );

    await factory(pi);

    expect(reviewer).toHaveBeenCalledOnce();
    expect(researcher).not.toHaveBeenCalled();
    expect(child).not.toHaveBeenCalled();
  });

  it("rejects conflicting registrations across package entrypoints", async () => {
    const pi = api();
    const registrations = createRecipeExtensionRegistrationRegistry();
    const first = bindRecipeExtensionFactory(
      (extensionApi) =>
        extensionApi.registerCommand("review", {
          description: "First",
          async handler() {},
        }),
      context(),
      registrations,
      "extensions/first.ts"
    );
    const second = bindRecipeExtensionFactory(
      (extensionApi) =>
        extensionApi.registerCommand("review", {
          description: "Second",
          async handler() {},
        }),
      context(),
      registrations,
      "extensions/second.ts"
    );

    await first(pi);
    await expect(second(pi)).rejects.toThrow(
      'command registration "review" conflicts'
    );
  });

  it("prevents Recipe extensions from activating undeclared tools", async () => {
    const pi = api();
    const factory = bindRecipeExtensionFactory(
      (extensionApi) => extensionApi.setActiveTools(["bash"]),
      context(),
      undefined,
      "extensions/policy.ts",
      new Set(["read"])
    );

    await expect(factory(pi)).rejects.toThrow(
      "attempted to activate undeclared tool(s): bash"
    );
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("permits tools authorized after an extension factory is loaded", async () => {
    const pi = api();
    const allowed = new Set(["read"]);
    let extensionApi: ExtensionAPI | undefined;
    const factory = bindRecipeExtensionFactory(
      (boundApi) => {
        extensionApi = boundApi;
      },
      context(),
      undefined,
      "extensions/mcp-policy.ts",
      allowed
    );
    await factory(pi);

    allowed.add("mcp_google_drive_search");
    extensionApi!.setActiveTools(["read", "mcp_google_drive_search"]);

    expect(pi.setActiveTools).toHaveBeenCalledWith([
      "read",
      "mcp_google_drive_search",
    ]);
  });

  it("neutralizes tools and commands an unwound extension left in the host", async () => {
    const pi = hostApi();
    const registrations = createRecipeExtensionRegistrationRegistry();
    const execute = vi.fn(async () => "ran");
    const handler = vi.fn(async () => {});
    await bindRecipeExtensionFactory(
      (extensionApi) => {
        extensionApi.registerTool({
          name: "setup_git",
          description: "Prepare git auth",
          parameters: {},
          execute,
        } as never);
        extensionApi.registerCommand("review", {
          description: "Review",
          handler,
        } as never);
      },
      context(),
      registrations,
      "extensions/setup-git.ts"
    )(pi);

    await expect(pi.tools.get("setup_git")!.execute()).resolves.toBe("ran");

    expect(await registrations.unwind(["extensions/setup-git.ts"])).toEqual([]);

    // Pi keeps both registrations for the life of its runtime; they must
    // refuse to run rather than silently answer for an unloaded extension.
    expect(pi.tools.has("setup_git")).toBe(true);
    expect(() => pi.tools.get("setup_git")!.execute()).toThrow(
      'extensions/setup-git.ts was unloaded; its tool "setup_git" is no longer available'
    );
    expect(() => pi.commands.get("review")!.handler()).toThrow(
      'its command "review" is no longer available'
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it("guards registrations an extension froze or exposed through accessors", async () => {
    const pi = hostApi();
    const registrations = createRecipeExtensionRegistrationRegistry();
    await bindRecipeExtensionFactory(
      (extensionApi) => {
        extensionApi.registerTool(
          Object.freeze({
            name: "setup_git",
            description: "Prepare git auth",
            parameters: {},
            execute: async () => "ran",
          }) as never
        );
        extensionApi.registerCommand("review", {
          description: "Review",
          get handler() {
            return async () => "reviewed";
          },
        } as never);
      },
      context(),
      registrations,
      "extensions/frozen.ts"
    )(pi);

    await expect(pi.tools.get("setup_git")!.execute()).resolves.toBe("ran");
    await expect(pi.commands.get("review")!.handler()).resolves.toBe(
      "reviewed"
    );

    await registrations.unwind(["extensions/frozen.ts"]);

    expect(() => pi.tools.get("setup_git")!.execute()).toThrow("was unloaded");
    expect(() => pi.commands.get("review")!.handler()).toThrow("was unloaded");
  });

  it("neutralizes shortcuts but leaves transcript renderers callable", async () => {
    const pi = hostApi();
    const registrations = createRecipeExtensionRegistrationRegistry();
    await bindRecipeExtensionFactory(
      (extensionApi) => {
        extensionApi.registerShortcut("ctrl+r", {
          description: "Review",
          handler: async () => "shortcut ran",
        } as never);
        extensionApi.registerMessageRenderer(
          "recipe-review",
          (() => "rendered") as never
        );
      },
      context(),
      registrations,
      "extensions/ui.ts"
    )(pi);

    await registrations.unwind(["extensions/ui.ts"]);

    expect(() => pi.shortcuts.get("ctrl+r")!.handler()).toThrow(
      'its shortcut "ctrl+r" is no longer available'
    );
    // Renderers draw history rather than run behavior. Pi resolves them per
    // message with no error boundary, so neutralizing one would break the
    // transcript instead of reporting an unloaded extension.
    expect(pi.renderers.get("recipe-review")!()).toBe("rendered");
  });

  it("keeps a class payload able to read its own private state", async () => {
    const pi = hostApi();
    const registrations = createRecipeExtensionRegistrationRegistry();
    class ReviewTool {
      readonly #label = "Review";
      readonly name = "review_tool";
      readonly parameters = {};
      get description() {
        return `${this.#label} the diff`;
      }
      async execute() {
        return "ran";
      }
    }
    await bindRecipeExtensionFactory(
      (extensionApi) => {
        extensionApi.registerTool(new ReviewTool() as never);
      },
      context(),
      registrations,
      "extensions/class-tool.ts"
    )(pi);

    // A copy would share the prototype without the private slots its accessor
    // reads, so the host would throw the first time it asked for metadata.
    const registered = pi.tools.get("review_tool")! as unknown as ReviewTool;
    expect(registered.description).toBe("Review the diff");
    await expect(registered.execute()).resolves.toBe("ran");

    await registrations.unwind(["extensions/class-tool.ts"]);

    expect(registered.description).toBe("Review the diff");
    expect(() => registered.execute()).toThrow("was unloaded");
  });

  it("silences lifecycle handlers an unwound extension subscribed", async () => {
    const pi = hostApi();
    const registrations = createRecipeExtensionRegistrationRegistry();
    const onToolCall = vi.fn(() => "blocked");
    await bindRecipeExtensionFactory(
      (extensionApi) => {
        extensionApi.on("tool_call", onToolCall as never);
      },
      context(),
      registrations,
      "extensions/policy.ts"
    )(pi);

    expect(pi.emit("tool_call")).toEqual(["blocked"]);

    await registrations.unwind(["extensions/policy.ts"]);

    expect(pi.emit("tool_call")).toEqual([undefined]);
    expect(onToolCall).toHaveBeenCalledOnce();
  });

  it("unregisters providers an unwound extension installed", async () => {
    const pi = hostApi();
    const registrations = createRecipeExtensionRegistrationRegistry();
    await bindRecipeExtensionFactory(
      (extensionApi) => {
        extensionApi.registerProvider({ id: "acme", models: [] } as never);
      },
      context(),
      registrations,
      "extensions/provider.ts"
    )(pi);

    expect(pi.providers.has("acme")).toBe(true);

    await registrations.unwind(["extensions/provider.ts"]);

    expect(pi.providers.has("acme")).toBe(false);
  });

  it("hands registrations to the next load and keeps the previous one disposed", async () => {
    const pi = hostApi();
    const registrations = createRecipeExtensionRegistrationRegistry();
    const load = (result: string) =>
      bindRecipeExtensionFactory(
        (extensionApi) => {
          extensionApi.registerTool({
            name: "setup_git",
            description: "Prepare git auth",
            parameters: {},
            execute: async () => result,
          } as never);
        },
        context(),
        registrations,
        "extensions/setup-git.ts"
      )(pi);

    await load("first");
    const stale = pi.tools.get("setup_git")!;
    await registrations.unwind(["extensions/setup-git.ts"]);
    expect(registrations.vacated("tool", "setup_git")).toBe(true);

    // Re-claiming the released name is what makes reloading possible.
    await expect(load("second")).resolves.toBeUndefined();
    expect(registrations.vacated("tool", "setup_git")).toBe(false);
    await expect(pi.tools.get("setup_git")!.execute()).resolves.toBe("second");
    // The replaced load stays dead even though its path is live again.
    expect(() => stale.execute()).toThrow("was unloaded");
  });

  it("leaves the host alone when it discarded the registrations itself", async () => {
    const pi = hostApi();
    const registrations = createRecipeExtensionRegistrationRegistry();
    await bindRecipeExtensionFactory(
      (extensionApi) => {
        extensionApi.registerProvider({ id: "acme", models: [] } as never);
        extensionApi.registerTool({
          name: "setup_git",
          description: "Prepare git auth",
          parameters: {},
          execute: async () => "ran",
        } as never);
      },
      context(),
      registrations,
      "extensions/provider.ts"
    )(pi);

    // The host rebuilt its runtime; whatever answers to these names now was
    // installed by someone else and must not be torn down by this unwind.
    pi.providers.delete("acme");
    pi.providers.add("acme");
    await registrations.unwind(["extensions/provider.ts"], true);

    expect(pi.providers.has("acme")).toBe(true);
    // A name the host no longer associates with this extension stays claimable,
    // so a host tool that appears under it is not mistaken for a leftover.
    expect(registrations.vacated("tool", "setup_git")).toBe(false);
    expect(() => registrations.claim("tool", "setup_git", "<host>")).not.toThrow();
    // The scope is disposed regardless: the outgoing closure still goes quiet.
    expect(() => pi.tools.get("setup_git")!.execute()).toThrow("was unloaded");
  });

  it("reports a failing disposer instead of abandoning the unwind", async () => {
    const pi = hostApi();
    const registrations = createRecipeExtensionRegistrationRegistry();
    pi.unregisterProvider = (() => {
      throw new Error("provider teardown exploded");
    }) as never;
    const laterEffect = vi.fn();
    await bindRecipeExtensionFactory(
      (extensionApi) => {
        extensionApi.registerProvider({ id: "acme", models: [] } as never);
        extensionApi.on("tool_call", laterEffect as never);
      },
      context(),
      registrations,
      "extensions/provider.ts"
    )(pi);

    const failures = await registrations.unwind(["extensions/provider.ts"]);

    expect(failures).toEqual([
      { owner: "extensions/provider.ts", error: "provider teardown exploded" },
    ]);
    // The scope is still disposed, so the rest of the closure went quiet.
    expect(pi.emit("tool_call")).toEqual([undefined]);
  });

  it("unwinds owners most recently loaded first", async () => {
    const pi = hostApi();
    const registrations = createRecipeExtensionRegistrationRegistry();
    const order: string[] = [];
    for (const owner of ["extensions/first.ts", "extensions/second.ts"]) {
      await bindRecipeExtensionFactory(
        (extensionApi) => {
          extensionApi.registerProvider({ id: owner, models: [] } as never);
        },
        context(),
        registrations,
        owner
      )(pi);
    }
    pi.unregisterProvider = ((id: string) => {
      order.push(id);
    }) as never;

    await registrations.unwind([
      "extensions/first.ts",
      "extensions/second.ts",
    ]);

    expect(order).toEqual(["extensions/second.ts", "extensions/first.ts"]);
  });

  it("permits the session-generated agent tool only for delegated sessions", () => {
    expect(
      recipeExtensionToolAllowlist(
        ["read"],
        true,
        ["mcp_google_drive_search", "mcp_search"]
      )
    ).toEqual(
      new Set([
        "read",
        "agent",
        "mcp_google_drive_search",
        "mcp_search",
      ])
    );
    expect(recipeExtensionToolAllowlist(["read"], false)).toEqual(
      new Set(["read"])
    );
  });
});
