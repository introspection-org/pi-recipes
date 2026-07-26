import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRecipe } from "../src/recipe/resolve.js";

const mocks = vi.hoisted(() => ({
  createAgentSessionFromServices: vi.fn(),
  createAgentSessionServices: vi.fn(),
  modelRuntimeCreate: vi.fn(async (_options: unknown) => ({
    kind: "mock-model-runtime",
  })),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  getEnvApiKey: vi.fn(() => "test-key"),
  getModel: vi.fn(() => ({ provider: "openai", id: "test-model" })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: {
    create: mocks.modelRuntimeCreate,
  },
  createAgentSessionFromServices: mocks.createAgentSessionFromServices,
  createAgentSessionServices: mocks.createAgentSessionServices,
  SessionManager: {
    inMemory: vi.fn(() => ({})),
  },
  SettingsManager: {
    create: vi.fn(() => ({})),
  },
}));

import { createRecipeChildAgentRunner } from "../src/child-agent.js";

describe("recipe child agent tools", () => {
  const roots: string[] = [];

  afterEach(() => {
    mocks.createAgentSessionFromServices.mockReset();
    mocks.createAgentSessionServices.mockReset();
    mocks.modelRuntimeCreate.mockClear();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes an explicit empty tool allowlist to Pi", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-child-tools-"));
    roots.push(root);
    const recipeDir = join(root, "recipe");
    const workspaceDir = join(root, "workspace");
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "child-tools-test",
        version: "0.1.0",
        pi: { agents: ["agents/*.yaml"] },
      })
    );
    writeFileSync(
      join(recipeDir, "agents", "worker.yaml"),
      [
        "name: worker",
        "model:",
        "  name: openai/test-model",
        "  thinking_level: low",
        "tools: []",
        "subagents:",
        "  - nested-worker",
        "system_instructions:",
        "  mode: append",
        "  content: Test worker",
        "",
      ].join("\n")
    );

    const session = {
      agent: {},
      bindExtensions: vi.fn(async () => undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
    mocks.createAgentSessionServices.mockResolvedValue({});
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    const runner = createRecipeChildAgentRunner({
      recipeDir,
      workspaceDir,
      agentName: "worker",
      env: {},
    });
    await runner.start();

    expect(mocks.createAgentSessionServices).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceLoaderOptions: expect.objectContaining({
          noSkills: true,
          additionalSkillPaths: [],
        }),
      })
    );
    expect(mocks.createAgentSessionFromServices).toHaveBeenCalledWith(
      expect.objectContaining({ tools: [] })
    );
    await runner.shutdown();
  });

  it("constructs a resolved child from its immutable plan", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-child-resolved-"));
    roots.push(root);
    const recipeDir = join(root, "recipe");
    const workspaceDir = join(root, "workspace");
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "child-resolved-test",
        version: "0.1.0",
        pi: { agents: ["agents/*.yaml"] },
      })
    );
    const agentPath = join(recipeDir, "agents", "worker.yaml");
    writeFileSync(
      agentPath,
      [
        "name: worker",
        "model:",
        "  name: openai/test-model",
        "tools: []",
        "skills: []",
        "subagents: []",
        "system_instructions:",
        "  mode: append",
        "  content: Resolved instructions",
        "",
      ].join("\n")
    );
    const resolved = resolveRecipe({ recipeDir }).selectAgent("worker");
    rmSync(agentPath);
    rmSync(join(recipeDir, "package.json"));

    const session = {
      agent: {},
      bindExtensions: vi.fn(async () => undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
    mocks.createAgentSessionServices.mockResolvedValue({});
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    const runner = createRecipeChildAgentRunner({
      recipeDir,
      workspaceDir,
      agentName: "worker",
      agent: resolved,
      env: {},
    });
    await runner.start();

    const options = mocks.createAgentSessionServices.mock.calls[0]![0] as {
      resourceLoaderOptions: {
        systemPromptOverride(base: string): string;
      };
    };
    expect(
      options.resourceLoaderOptions.systemPromptOverride("Base instructions")
    ).toBe("Base instructions\n\nResolved instructions");
    await runner.shutdown();
  });

  it("removes the agent tool from delegated agents", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-child-no-nesting-"));
    roots.push(root);
    const recipeDir = join(root, "recipe");
    const workspaceDir = join(root, "workspace");
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "child-no-nesting-test",
        version: "0.1.0",
        pi: { agents: ["agents/*.yaml"] },
      })
    );
    writeFileSync(
      join(recipeDir, "agents", "worker.yaml"),
      [
        "name: worker",
        "model:",
        "  name: openai/test-model",
        "  thinking_level: low",
        "tools:",
        "  - read",
        "  - agent",
        "subagents:",
        "  - nested-worker",
        "system_instructions:",
        "  mode: append",
        "  content: Test worker",
        "",
      ].join("\n")
    );

    const session = {
      agent: {},
      bindExtensions: vi.fn(async () => undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
    mocks.createAgentSessionServices.mockResolvedValue({});
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    const runner = createRecipeChildAgentRunner({
      recipeDir,
      workspaceDir,
      agentName: "worker",
      env: {},
    });
    await runner.start();

    expect(mocks.createAgentSessionFromServices).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ["read"] })
    );
    await runner.shutdown();
  });

  it("allows a custom shell wrapper to execute MCP commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-child-mcp-shell-"));
    roots.push(root);
    const recipeDir = join(root, "recipe");
    const workspaceDir = join(root, "workspace");
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "child-mcp-shell-test",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
          mcp: {
            servers: [
              { id: "nextplay", tools: { include: ["search"] } },
            ],
          },
        },
      })
    );
    writeFileSync(
      join(recipeDir, "agents", "worker.yaml"),
      [
        "name: worker",
        "model:",
        "  name: openai/test-model",
        "  thinking_level: low",
        "tools:",
        "  - shell",
        "mcp:",
        "  nextplay:",
        "    include:",
        "      - search",
        "skills: []",
        "subagents: []",
        "system_instructions:",
        "  mode: append",
        "  content: Test worker",
        "",
      ].join("\n")
    );

    const session = {
      agent: {},
      bindExtensions: vi.fn(async () => undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
    mocks.createAgentSessionServices.mockResolvedValue({});
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    const runner = createRecipeChildAgentRunner({
      recipeDir,
      workspaceDir,
      agentName: "worker",
      env: {},
    });
    await runner.start();

    expect(mocks.createAgentSessionFromServices).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ["shell"] })
    );
    await runner.shutdown();
  });

  it("preserves registry-resolved headers and provider environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-child-auth-"));
    roots.push(root);
    const recipeDir = join(root, "recipe");
    const workspaceDir = join(root, "workspace");
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "child-auth-test",
        version: "0.1.0",
        pi: { agents: ["agents/*.yaml"] },
      })
    );
    writeFileSync(
      join(recipeDir, "agents", "worker.yaml"),
      [
        "name: worker",
        "model:",
        "  name: openai/test-model",
        "tools: []",
        "subagents: []",
        "system_instructions:",
        "  mode: append",
        "  content: Test worker",
        "",
      ].join("\n")
    );

    const model = {
      provider: "openai",
      id: "test-model",
      headers: { "x-base": "base" },
    };
    const modelRegistry = {
      find: vi.fn(() => model),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true as const,
        apiKey: "resolved-access-token",
        headers: {
          Authorization: "Bearer resolved-access-token",
          "x-organization": "org-1",
        },
        env: { OPENAI_ACCOUNT_ID: "account-1" },
      })),
    };
    const session = {
      agent: {},
      bindExtensions: vi.fn(async () => undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
    mocks.createAgentSessionServices.mockResolvedValue({});
    mocks.createAgentSessionFromServices.mockResolvedValue({ session });

    const runner = createRecipeChildAgentRunner({
      recipeDir,
      workspaceDir,
      agentName: "worker",
      env: {},
      modelRegistry: modelRegistry as never,
    });
    await runner.start();

    expect(model.headers).toEqual({
      "x-base": "base",
      Authorization: "Bearer resolved-access-token",
      "x-organization": "org-1",
    });
    const runtimeOptions = mocks.modelRuntimeCreate.mock.calls[0]![0] as {
      credentials: { read(provider: string): Promise<unknown> };
    };
    const credentials = runtimeOptions.credentials;
    await expect(credentials.read("openai")).resolves.toEqual({
      type: "api_key",
      key: "resolved-access-token",
      env: { OPENAI_ACCOUNT_ID: "account-1" },
    });
    await runner.shutdown();
  });
});
