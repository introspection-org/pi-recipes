import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createdSession = {
  bindExtensions: vi.fn(async () => {}),
  subscribe: vi.fn(() => vi.fn()),
  prompt: vi.fn(async () => {}),
  abort: vi.fn(async () => {}),
  dispose: vi.fn(() => {}),
  messages: [{ role: "assistant", content: "done" }],
};

const createAgentSessionServices = vi.fn(async (opts: unknown) => ({
  opts,
}));
const createAgentSessionFromServices = vi.fn(async () => ({
  session: createdSession,
}));
const runtimeApiKeys = new Map<string, string>();

vi.mock("@earendil-works/pi-ai", () => ({
  getEnvApiKey: vi.fn(() => undefined),
  getModel: vi.fn((provider: string, id: string) => ({ provider, id })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    inMemory: vi.fn(() => ({
      setRuntimeApiKey(provider: string, key: string) {
        runtimeApiKeys.set(provider, key);
      },
    })),
  },
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager: {
    inMemory: vi.fn((cwd: string) => ({ cwd })),
  },
  SettingsManager: {
    create: vi.fn((cwd: string, agentDir: string) => ({ cwd, agentDir })),
  },
}));

describe("Pi agent session driver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeApiKeys.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts a Pi AgentSession from a materialized recipe and prompts it", async () => {
    const { PiAgentSessionDriver, launchContextFromPortableEnv } = await import(
      "../src/index.js"
    );
    const root = mkdtempSync(join(tmpdir(), "pi-session-driver-"));
    try {
      const recipeDir = join(root, "recipe");
      const workspaceDir = join(root, "workspace");
      mkdirSync(join(recipeDir, "agents"), { recursive: true });
      mkdirSync(workspaceDir, { recursive: true });
      writeFileSync(
        join(recipeDir, "package.json"),
        JSON.stringify({ name: "local-recipe", version: "1.2.3" })
      );
      writeFileSync(join(recipeDir, "SYSTEM.md"), "Base recipe prompt");
      writeFileSync(
        join(recipeDir, "agents", "agent.yaml"),
        [
          "name: agent",
          "model:",
          "  name: openai/gpt-4.1",
          "  thinking_level: medium",
          "tools:",
          "  - shell",
          "system_instructions:",
          "  mode: append",
          "  content: Agent-specific prompt",
        ].join("\n")
      );

      const driver = new PiAgentSessionDriver({
        context: launchContextFromPortableEnv({
          PI_TASK_ID: "task-1",
          PI_WORKSPACE_DIR: workspaceDir,
        }),
        recipe: {
          source: "local_path",
          agentDir: recipeDir,
          packageName: "local-recipe",
          packageVersion: "1.2.3",
          packagePath: workspaceDir,
        },
        modelCredentials: {
          async resolveCredential() {
            return { apiKey: "sk-test" };
          },
        },
      });

      await driver.start();
      const result = await driver.prompt("hello from node");
      await driver.shutdown();

      expect(runtimeApiKeys.get("openai")).toBe("sk-test");
      expect(createAgentSessionServices).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: workspaceDir,
          agentDir: recipeDir,
        })
      );
      expect(createAgentSessionFromServices).toHaveBeenCalledWith(
        expect.objectContaining({
          model: { provider: "openai", id: "gpt-4.1" },
          thinkingLevel: "medium",
          tools: ["shell"],
        })
      );
      expect(createdSession.bindExtensions).toHaveBeenCalledWith({});
      expect(createdSession.prompt).toHaveBeenCalledWith("hello from node");
      expect(result).toEqual({
        events: [],
        messages: [{ role: "assistant", content: "done" }],
      });
      expect(createdSession.dispose).toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
