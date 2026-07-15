import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RecipeSessionResolutionError,
  resolveRecipeSession,
} from "../src/recipe-session.js";

const roots: string[] = [];

function makeRecipe(): string {
  const recipeDir = mkdtempSync(join(tmpdir(), "pi-recipe-session-"));
  roots.push(recipeDir);
  mkdirSync(join(recipeDir, "agents"));
  mkdirSync(join(recipeDir, "extensions", "operator"), { recursive: true });
  mkdirSync(join(recipeDir, "extensions", "unused"), { recursive: true });
  mkdirSync(join(recipeDir, "skills", "research"), { recursive: true });
  mkdirSync(join(recipeDir, "prompts"));
  writeFileSync(
    join(recipeDir, "package.json"),
    JSON.stringify({
      name: "fixture-recipe",
      version: "1.0.0",
      pi: {
        agents: ["agents"],
        extensions: ["extensions/operator/index.ts", "extensions/unused/index.ts"],
        skills: ["skills"],
        prompts: ["prompts"],
      },
    })
  );
  writeFileSync(
    join(recipeDir, "agents", "base.yaml"),
    [
      "name: base",
      "description: Base",
      "model:",
      "  name: openai/gpt-5",
      "  thinking_level: high",
      "tools: [read, mcp__search]",
      "skills: []",
      "subagents: []",
      "system_instructions:",
      "  mode: append",
      "  content: Base instructions",
    ].join("\n")
  );
  writeFileSync(
    join(recipeDir, "agents", "agent.yaml"),
    [
      "name: researcher",
      "from: base",
      "description: Researcher",
      "extensions:",
      "  include: [operator]",
    ].join("\n")
  );
  writeFileSync(join(recipeDir, "extensions", "operator", "index.ts"), "export default () => {};\n");
  writeFileSync(join(recipeDir, "extensions", "unused", "index.ts"), "export default () => {};\n");
  writeFileSync(join(recipeDir, "skills", "research", "SKILL.md"), "---\ndescription: Research\n---\n");
  writeFileSync(join(recipeDir, "prompts", "review.md"), "Review\n");
  writeFileSync(join(recipeDir, "SYSTEM.md"), "Recipe system prompt\n");
  return recipeDir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveRecipeSession", () => {
  it("returns inputs that map directly to a Pi session", () => {
    const recipeDir = makeRecipe();
    const resolved = resolveRecipeSession({ recipeDir });

    expect(resolved.agentName).toBe("researcher");
    expect(resolved.modelSpec).toBe("openai/gpt-5");
    expect(resolved.thinkingLevel).toBe("high");
    expect(resolved.tools).toEqual(["read", "mcp__search"]);
    expect(resolved.extensionPaths).toEqual([
      join(recipeDir, "extensions", "operator", "index.ts"),
    ]);
    expect(resolved.skillPaths).toEqual([join(recipeDir, "skills")]);
    expect(resolved.promptPaths).toEqual([join(recipeDir, "prompts")]);
    expect(resolved.systemPromptOverride("Pi base prompt")).toBe(
      "Recipe system prompt\n\nBase instructions"
    );
  });

  it("selects aliases and returns the canonical agent name", () => {
    const recipeDir = makeRecipe();
    const resolved = resolveRecipeSession({ recipeDir, agentName: "agent" });
    expect(resolved.agentName).toBe("researcher");
  });

  it("fails before returning a partial session configuration", () => {
    const recipeDir = makeRecipe();
    expect(() =>
      resolveRecipeSession({ recipeDir, agentName: "missing" })
    ).toThrow(RecipeSessionResolutionError);
  });
});
