import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCompiledRecipeArtifact,
  compileRecipe,
  compileRecipeToFile,
  createRecipeHarness,
  readCompiledRecipeArtifact,
  type RecipeAgentSessionPlan,
  type RecipeHostAdapter,
} from "../src/index.js";

function writeRecipe(root: string): void {
  mkdirSync(join(root, "agents"), { recursive: true });
  mkdirSync(join(root, "skills", "research"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "compiled-test",
      version: "1.2.3",
      pi: {
        agents: ["agents/*.yaml"],
        skills: ["skills/**/SKILL.md"],
        prompts: ["SYSTEM.md"],
      },
    })
  );
  writeFileSync(join(root, "SYSTEM.md"), "Package instructions\n");
  writeFileSync(
    join(root, "agents", "base.yaml"),
    [
      "name: base",
      "model:",
      "  name: openai/test-model",
      "  thinking_level: medium",
      "tools: [read]",
      "skills: [research]",
      "subagents: []",
      "system_instructions:",
      "  mode: append",
      "  content: Base instructions",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(root, "agents", "agent.yaml"),
    [
      "name: agent",
      "from: base",
      "tools: [read, read]",
      "subagents: [base]",
      "",
    ].join("\n")
  );
  writeFileSync(join(root, "skills", "research", "SKILL.md"), "# Research\n");
}

describe("compiled recipe artifacts", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("resolves inheritance and emits a deterministic path-independent artifact", () => {
    const first = mkdtempSync(join(tmpdir(), "compiled-recipe-a-"));
    const second = mkdtempSync(join(tmpdir(), "compiled-recipe-b-"));
    roots.push(first, second);
    writeRecipe(first);
    writeRecipe(second);

    const left = compileRecipe({ recipeDir: first });
    const right = compileRecipe({ recipeDir: second });

    expect(left).toEqual(right);
    expect(left.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(left.entrypoint).toBe("agent");
    expect(left.resources.skills).toEqual(["skills/research/SKILL.md"]);
    expect(left.files.map((file) => file.path)).toContain("SYSTEM.md");
    expect(left.files.find((file) => file.path === "SYSTEM.md")?.kinds).toEqual([
      "prompts",
      "systemPrompt",
    ]);
    expect(left.agents.find((agent) => agent.name === "agent")).toMatchObject({
      executableTools: ["read", "read"],
      definition: {
        model: { name: "openai/test-model", thinkingLevel: "medium" },
        skills: ["research"],
        subagents: ["base"],
      },
    });
    expect(left.diagnostics.toolCollisions).toEqual([
      {
        agent: "agent",
        kind: "tool",
        normalizedName: "read",
        declarations: ["read", "read"],
      },
    ]);
    expect(() => assertCompiledRecipeArtifact(left)).not.toThrow();
    const transported = JSON.parse(JSON.stringify(left)) as unknown;
    expect(() => assertCompiledRecipeArtifact(transported)).not.toThrow();
  });

  it("rejects a mutated artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-recipe-tamper-"));
    roots.push(root);
    writeRecipe(root);
    const artifact = compileRecipe({ recipeDir: root });
    artifact.package.version = "9.9.9";

    expect(() => assertCompiledRecipeArtifact(artifact)).toThrow(/digest mismatch/);
  });

  it("writes and verifies an artifact atomically", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-recipe-file-"));
    roots.push(root);
    writeRecipe(root);
    const outputPath = join(root, ".introspection", "recipe-compiled.json");

    const artifact = await compileRecipeToFile({ recipeDir: root, outputPath });

    expect(existsSync(outputPath)).toBe(true);
    expect(readCompiledRecipeArtifact(outputPath)).toEqual(artifact);
  });

  it("preserves the agent.yaml filename alias as the default entrypoint", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-recipe-alias-"));
    roots.push(root);
    writeRecipe(root);
    writeFileSync(
      join(root, "agents", "agent.yaml"),
      [
        "name: coordinator",
        "from: base",
        "tools: []",
        "subagents: []",
        "",
      ].join("\n")
    );

    const artifact = compileRecipe({ recipeDir: root });
    expect(artifact.entrypoint).toBe("coordinator");
    expect(
      artifact.agents.find((agent) => agent.name === "coordinator")?.aliases
    ).toEqual(["agent"]);
  });

  it("passes one compiled session plan through the host adapter", async () => {
    const recipeDir = mkdtempSync(join(tmpdir(), "compiled-recipe-host-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "compiled-workspace-"));
    roots.push(recipeDir, workspaceDir);
    writeRecipe(recipeDir);

    const plans: RecipeAgentSessionPlan[] = [];
    const session = {
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } as unknown as AgentSession;
    const hostAdapter: RecipeHostAdapter = {
      async createSession(plan) {
        plans.push(plan);
        return session;
      },
    };
    const harness = createRecipeHarness({ recipeDir, workspaceDir, hostAdapter });
    const runner = harness.createAgentRunner();

    expect(harness.plan()).toMatchObject({
      agentName: "agent",
      modelSpec: "openai/test-model",
      thinkingLevel: "medium",
      executableTools: ["read", "read"],
      recipeSystemPrompt: "Package instructions",
    });
    expect(await runner.prompt("Do work")).toBe("done");
    expect(plans).toHaveLength(1);
    expect(plans[0]!.artifact).toBe(harness.artifact);
    expect(session.prompt).toHaveBeenCalledWith("Do work");
    await runner.shutdown();
  });
});
