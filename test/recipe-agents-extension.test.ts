import { describe, expect, it, vi } from "vitest";
import {
  AGENT_UPDATE_EVENT,
  createAgentTool,
  createAgentsExtension,
  createRecipeAgentTool,
  type AgentRunController,
} from "../src/pi/index.js";
import type { ResolvedRecipeSession } from "../src/recipe-session.js";
import type { RecipeAgentDefinition } from "../src/recipe-agent.js";

function recipe(): ResolvedRecipeSession {
  const root: RecipeAgentDefinition = {
    name: "root",
    description: "Root agent",
    tools: [],
    skills: [],
    subagents: ["explorer"],
    subagentsDeclared: true,
  };
  const explorer: RecipeAgentDefinition = {
    name: "explorer",
    description: "Explore files",
    tools: ["read"],
    skills: [],
    subagents: [],
  };
  return {
    recipeDir: "/recipe",
    manifest: {
      name: "test",
      version: "1.0.0",
      path: "/recipe",
      resources: { agents: [], extensions: [], skills: [], prompts: [] },
      mcp: { manifests: [], servers: [] },
      evals: { suites: [] },
    },
    agentName: "root",
    agent: root,
    agents: new Map([
      ["root", root],
      ["explorer", explorer],
    ]),
    subagents: new Map([["explorer", explorer]]),
    modelSpec: "openai/gpt-5",
    thinkingLevel: "low",
    tools: [],
    mcp: undefined,
    skillPaths: [],
    promptPaths: [],
    extensionPaths: [],
    systemPromptOverride: (base) => base,
  };
}

function controller(): AgentRunController {
  return {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    start: vi.fn(),
    wait: vi.fn(),
    waitFor: vi.fn(),
    message: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
    closeAll: vi.fn(async () => {}),
    rehydrate: vi.fn(async () => 2),
  };
}

describe("createAgentsExtension", () => {
  it("exports the shared agent tool from the public Pi entrypoint", () => {
    expect(createAgentTool).toBeTypeOf("function");
    expect(createRecipeAgentTool).toBe(createAgentTool);
  });

  it("registers the shared agent tool and delegates managed lifecycle", async () => {
    const runs = controller();
    const registerTool = vi.fn();
    const events = { emit: vi.fn() };
    let shutdown: (() => Promise<void>) | undefined;
    const extension = createAgentsExtension({
      recipe: recipe(),
      createRunController({ emit }) {
        emit({
          agent_run_id: "run-1",
          invocation_name: "explorer:1",
          agent_name: "explorer",
          label: "Explore",
          prompt: "Inspect",
          status: "running",
          started_at: 1,
          last_activity_at: 1,
          artifact_dir: ".pi/agents/run-1",
          status_path: ".pi/agents/run-1/status.json",
          events_path: ".pi/agents/run-1/events.jsonl",
          output_artifact_path: ".pi/agents/run-1/output.md",
        });
        return runs;
      },
      onRehydrated: vi.fn(),
    });

    await extension({
      events,
      registerTool,
      on(type: string, handler: () => Promise<void>) {
        if (type === "session_shutdown") shutdown = handler;
      },
    } as never);

    expect(events.emit).toHaveBeenCalledWith(
      AGENT_UPDATE_EVENT,
      expect.objectContaining({ agent_run_id: "run-1" })
    );
    expect(registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "agent" })
    );
    expect(runs.rehydrate).toHaveBeenCalledOnce();
    await shutdown?.();
    expect(runs.closeAll).toHaveBeenCalledOnce();
  });
});

describe("agent completion acknowledgement", () => {
  it("acknowledges notifications for closed runs", async () => {
    const runs = controller();
    vi.mocked(runs.close).mockResolvedValue({
      agent_run_id: "run-1",
      invocation_name: "explorer:1",
      agent_name: "explorer",
      label: "Explore",
      prompt: "Inspect",
      status: "closed",
      started_at: 1,
      last_activity_at: 1,
    });
    const acknowledgeCompletions = vi.fn();
    const tool = createAgentTool(runs, recipe().subagents, {
      acknowledgeCompletions,
    });

    await tool.execute(
      "call-1",
      { action: "close", id: "run-1" },
      undefined,
      undefined,
      undefined as never
    );

    expect(acknowledgeCompletions).toHaveBeenCalledWith(["run-1"]);
  });

  it("acknowledges notifications for every run when closing all", async () => {
    const runs = controller();
    vi.mocked(runs.list).mockReturnValue([
      {
        agent_run_id: "run-1",
        invocation_name: "explorer:1",
        agent_name: "explorer",
        label: "Explore",
        prompt: "Inspect",
        status: "completed",
        started_at: 1,
        last_activity_at: 1,
      },
    ]);
    const acknowledgeCompletions = vi.fn();
    const tool = createAgentTool(runs, recipe().subagents, {
      acknowledgeCompletions,
    });

    await tool.execute(
      "call-1",
      { action: "close" },
      undefined,
      undefined,
      undefined as never
    );

    expect(acknowledgeCompletions).toHaveBeenCalledWith(["run-1"]);
  });
});
