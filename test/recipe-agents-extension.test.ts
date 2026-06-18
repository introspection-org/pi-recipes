import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRecipeAgentsExtension } from "../src/recipe-agents-extension.js";
import { createMockExtensionAPI } from "../src/testing.js";

describe("recipe agents extension", () => {
  it("registers a local agent tool from recipe subagents", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-agents-"));
    try {
      const recipeDir = join(root, "recipe");
      mkdirSync(join(recipeDir, "agents"), { recursive: true });
      writeFileSync(
        join(recipeDir, "agents", "agent.yaml"),
        [
          "name: agent",
          "description: Coordinator",
          "subagents:",
          "  - explorer",
        ].join("\n")
      );
      writeFileSync(
        join(recipeDir, "agents", "explorer.yaml"),
        "name: explorer\ndescription: Reads the repository\n"
      );
      const runAgent = vi.fn(async () => ({ output: "explorer says done" }));
      const pi = createMockExtensionAPI();

      createRecipeAgentsExtension({
        recipeDir,
        parentAgentName: "agent",
        runAgent,
      })(pi);

      const tool = pi.tools.get("agent");
      expect(tool).toBeDefined();
      const result = await tool!.execute(
        "run-1",
        {
          name: "explorer",
          task: "summarize the repo",
        } as never,
        undefined,
        undefined,
        undefined as never
      );

      expect(runAgent).toHaveBeenCalledWith({
        action: "start",
        name: "explorer",
        task: "summarize the repo",
        label: undefined,
        wait: undefined,
      });
      const firstContent = result.content[0];
      expect(firstContent?.type).toBe("text");
      expect(firstContent && "text" in firstContent ? firstContent.text : "").toBe("explorer says done");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports retained child-run management actions", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-agents-"));
    try {
      const recipeDir = join(root, "recipe");
      mkdirSync(join(recipeDir, "agents"), { recursive: true });
      writeFileSync(join(recipeDir, "agents", "agent.yaml"), "name: agent\nsubagents:\n  - explorer\n");
      writeFileSync(join(recipeDir, "agents", "explorer.yaml"), "name: explorer\n");
      const runAgent = vi.fn(async (request) => ({
        output: request.action === "status" ? "run-1 explorer: running" : "ok",
        details: { action: request.action },
      }));
      const pi = createMockExtensionAPI();

      createRecipeAgentsExtension({
        recipeDir,
        parentAgentName: "agent",
        runAgent,
      })(pi);

      const tool = pi.tools.get("agent");
      expect(tool).toBeDefined();
      const result = await tool!.execute(
        "run-1",
        { action: "status" } as never,
        undefined,
        undefined,
        undefined as never
      );

      expect(runAgent).toHaveBeenCalledWith({ action: "status", id: undefined });
      const firstContent = result.content[0];
      expect(firstContent && "text" in firstContent ? firstContent.text : "").toBe("run-1 explorer: running");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
