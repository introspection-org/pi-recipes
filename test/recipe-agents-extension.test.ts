import { describe, expect, it, vi } from "vitest";
import {
  createAgentTool,
  type AgentRunController,
} from "../src/pi/index.js";
import type { RecipeAgentDefinition } from "../src/recipe-agent.js";

function agents(): ReadonlyMap<string, RecipeAgentDefinition> {
  const explorer: RecipeAgentDefinition = {
    name: "explorer",
    description: "Explore files",
    tools: ["read"],
    skills: [],
    subagents: [],
  };
  return new Map([["explorer", explorer]]);
}

function controller(): AgentRunController {
  return {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    start: vi.fn(),
    waitFor: vi.fn(),
    message: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
    closeAll: vi.fn(async () => {}),
  };
}

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
    const tool = createAgentTool(runs, agents(), {
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
    const tool = createAgentTool(runs, agents(), {
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
