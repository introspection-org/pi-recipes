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

describe("Recipe extension context", () => {
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

  it("permits the session-generated agent tool only for delegated sessions", () => {
    expect(recipeExtensionToolAllowlist(["read"], true)).toEqual(
      new Set(["read", "agent"])
    );
    expect(recipeExtensionToolAllowlist(["read"], false)).toEqual(
      new Set(["read"])
    );
  });
});
