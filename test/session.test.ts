import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let sessionListener: ((event: unknown) => void) | undefined;

const createdSession = {
  bindExtensions: vi.fn(async () => {}),
  subscribe: vi.fn((listener: (event: unknown) => void) => {
    sessionListener = listener;
    return vi.fn();
  }),
  prompt: vi.fn(async () => {}),
  abort: vi.fn(async () => {}),
  dispose: vi.fn(() => {}),
  messages: [{ role: "assistant", content: "done" }],
  skills: [
    {
      name: "repo-index",
      description: "Understand the repository",
      filePath: "/tmp/repo-index/SKILL.md",
      baseDir: "/tmp/repo-index",
      sourceInfo: { source: "test" },
      disableModelInvocation: false,
    },
  ],
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
  defineTool: vi.fn((tool) => tool),
  parseSkillBlock: vi.fn((text: string) => {
    const match = text.match(/<skill\s+name="([^"]+)"\s+location="([^"]+)">([\s\S]*?)<\/skill>/);
    if (!match) return null;
    return { name: match[1], location: match[2], content: match[3], userMessage: undefined };
  }),
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
    sessionListener = undefined;
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
          "subagents:",
          "  - explorer",
          "system_instructions:",
          "  mode: append",
          "  content: Agent-specific prompt",
        ].join("\n")
      );
      writeFileSync(
        join(recipeDir, "agents", "explorer.yaml"),
        "name: explorer\ndescription: Explore repos\n"
      );

      const transcriptEvents: unknown[] = [];
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
        transcriptSink: {
          emit(event) {
            transcriptEvents.push(event);
          },
        },
      });

      await driver.start();
      sessionListener?.({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      sessionListener?.({
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "- one\n- two" }] },
        assistantMessageEvent: {
          type: "text_delta",
          delta: "- one\n",
          partial: { role: "assistant", content: [{ type: "text", text: "- one\n" }] },
        },
      });
      sessionListener?.({
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "- one\n- two" }] },
        assistantMessageEvent: {
          type: "text_delta",
          delta: "- two",
          partial: { role: "assistant", content: [{ type: "text", text: "- one\n- two" }] },
        },
      });
      sessionListener?.({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "- one\n- two" }] },
      });
      sessionListener?.({
        type: "tool_execution_start",
        toolCallId: "call-read",
        toolName: "read",
        args: { path: "package.json" },
      });
      sessionListener?.({
        type: "tool_execution_end",
        toolCallId: "call-read",
        toolName: "read",
        result: { content: [{ type: "text", text: "package contents" }] },
        isError: false,
      });
      const result = await driver.prompt('/skill:repo-index hello from node');
      await driver.shutdown();

      expect(runtimeApiKeys.get("openai")).toBe("sk-test");
      expect(createAgentSessionServices).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: workspaceDir,
          agentDir: recipeDir,
          resourceLoaderOptions: expect.objectContaining({
            extensionFactories: expect.arrayContaining([expect.any(Function)]),
          }),
        })
      );
      const servicesOptions = createAgentSessionServices.mock.calls[0]?.[0] as any;
      const recipeSystemPrompt =
        servicesOptions.resourceLoaderOptions.systemPromptOverride("Default Pi prompt");
      expect(recipeSystemPrompt).toContain("Base recipe prompt");
      expect(recipeSystemPrompt).toContain("Agent-specific prompt");
      expect(recipeSystemPrompt).not.toContain("Recipe Runtime Context");
      const appendedSystemPrompts =
        servicesOptions.resourceLoaderOptions.appendSystemPromptOverride(["Host append"]);
      expect(appendedSystemPrompts[0]).toBe("Host append");
      expect(appendedSystemPrompts[1]).toContain("Recipe Runtime Context");
      expect(appendedSystemPrompts[1]).toContain("Current workspace: " + workspaceDir);
      expect(createAgentSessionFromServices).toHaveBeenCalledWith(
        expect.objectContaining({
          model: { provider: "openai", id: "gpt-4.1" },
          thinkingLevel: "medium",
          tools: ["shell", "agent"],
        })
      );
      expect(createdSession.bindExtensions).toHaveBeenCalledWith({});
      expect(createdSession.prompt).toHaveBeenCalledWith('/skill:repo-index hello from node');
      expect(transcriptEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "skill_loaded",
            data: expect.objectContaining({ name: "repo-index" }),
          }),
          expect.objectContaining({
            type: "skill_used",
            data: expect.objectContaining({ name: "repo-index", source: "prompt" }),
          }),
          expect.objectContaining({
            type: "assistant_message",
            data: expect.objectContaining({ text: "- one\n- two" }),
          }),
          expect.objectContaining({
            type: "tool_call",
            data: expect.objectContaining({
              id: "call-read",
              name: "read",
              arguments: { path: "package.json" },
            }),
          }),
          expect.objectContaining({
            type: "tool_result",
            data: expect.objectContaining({
              id: "call-read",
              name: "read",
              arguments: { path: "package.json" },
              text: "package contents",
            }),
          }),
        ])
      );
      expect(
        transcriptEvents.filter(
          (event) => (event as { type?: string }).type === "assistant_message"
        )
      ).toHaveLength(1);
      expect(result).toEqual({
        events: [],
        messages: [{ role: "assistant", content: "done" }],
      });
      expect(createdSession.dispose).toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts only final assistant text from prompt results", async () => {
    const { promptResultText } = await import("../src/index.js");

    expect(
      promptResultText({
        events: [{ noisy: true }],
        messages: [
          { role: "user", content: "question" },
          {
            role: "assistant",
            content: [
              { type: "thinking", text: "private reasoning" },
              { type: "text", text: "final answer" },
            ],
          },
        ],
      })
    ).toBe("final answer");
  });
});
