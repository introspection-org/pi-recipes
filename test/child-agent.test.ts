import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgentSessionFromServices: vi.fn(),
  createAgentSessionServices: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  getEnvApiKey: vi.fn(() => "test-key"),
  getModel: vi.fn(() => ({ provider: "openai", id: "test-model" })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: {
    create: vi.fn(async () => ({ kind: "mock-model-runtime" })),
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
});
