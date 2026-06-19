import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createPiRecipesExtension } from "../src/pi-extension.js";
import { createMockExtensionAPI } from "../src/testing.js";

function extensionContext(cwd: string, notify = vi.fn()) {
  return {
    cwd,
    hasUI: true,
    ui: { notify },
    modelRegistry: {
      find: vi.fn((provider: string, id: string) => ({ provider, id })),
    },
  } as any;
}

function writeRecipe(root: string) {
  const recipeDir = join(root, "recipe");
  mkdirSync(join(recipeDir, "defs"), { recursive: true });
  mkdirSync(join(recipeDir, "profiles"), { recursive: true });
  mkdirSync(join(recipeDir, "skills", "repo-index"), { recursive: true });
  mkdirSync(join(recipeDir, "prompts"), { recursive: true });
  mkdirSync(join(recipeDir, "themes"), { recursive: true });
  writeFileSync(
    join(recipeDir, "package.json"),
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      pi: {
        agents: ["defs/*.yaml"],
        profiles: ["profiles/*.yaml"],
        skills: ["skills/**/SKILL.md"],
        prompts: ["prompts"],
        themes: ["themes/*.json"],
      },
    })
  );
  writeFileSync(join(recipeDir, "SYSTEM.md"), "Base recipe prompt");
  writeFileSync(
    join(recipeDir, "defs", "main.yaml"),
    [
      "name: main",
      "model:",
      "  name: openai/gpt-4.1",
      "  thinking_level: low",
      "tools:",
      "  - read",
      "  - bash",
      "subagents:",
      "  - explorer",
      "system_instructions:",
      "  mode: append",
      "  content: Agent-specific prompt",
    ].join("\n")
  );
  writeFileSync(join(recipeDir, "defs", "explorer.yaml"), "name: explorer\n");
  writeFileSync(
    join(recipeDir, "profiles", "deep.yaml"),
    [
      "name: deep",
      "entrypoint: main",
      "model:",
      "  name: anthropic/claude-sonnet-4-5",
      "  thinking_level: high",
      "prompt: Profile prompt",
    ].join("\n")
  );
  writeFileSync(join(recipeDir, "skills", "repo-index", "SKILL.md"), "---\ndescription: Index repo\n---\n");
  writeFileSync(join(recipeDir, "prompts", "review.md"), "Review this\n");
  writeFileSync(join(recipeDir, "themes", "demo.json"), "{}\n");
  return recipeDir;
}

describe("Pi recipes launch extension", () => {
  it("registers recipe launch flags", async () => {
    const pi = createMockExtensionAPI();
    createPiRecipesExtension()(pi);

    expect(pi.commands.has("recipe")).toBe(false);
    expect(pi.flags.has("recipe")).toBe(true);
    expect(pi.flags.has("recipe-profile")).toBe(true);
    expect(pi.flags.has("recipe-agent")).toBe(true);

    const results = await pi.emitExtensionEvent(
      { type: "resources_discover", cwd: process.cwd(), reason: "startup" } as any,
      extensionContext(process.cwd())
    );
    expect(results).toEqual([{}]);
    expect(pi.activeTools).toEqual([]);
  });

  it("configures the launched session from a recipe folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-launch-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      const notify = vi.fn();
      const ctx = extensionContext(projectDir, notify);
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("recipe-profile", "deep");
      pi.flagValues.set("recipe-agent", "explorer");

      createPiRecipesExtension()(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      expect(pi.sessionName).toBe("demo@1.0.0 profile:deep agent:main");
      expect(pi.model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
      expect(pi.thinkingLevel).toBe("high");
      expect(pi.activeTools.sort()).toEqual(["agent", "bash", "read"]);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Recipe: demo@1.0.0"), "info");

      const resourceResults = await pi.emitExtensionEvent(
        { type: "resources_discover", cwd: projectDir, reason: "startup" } as any,
        ctx
      );
      expect(resourceResults).toEqual([
        expect.objectContaining({
          skillPaths: [join(recipeDir, "skills", "repo-index", "SKILL.md")],
          promptPaths: [join(recipeDir, "prompts")],
          themePaths: [join(recipeDir, "themes", "demo.json")],
        }),
      ]);

      const promptResults = await pi.emitExtensionEvent(
        {
          type: "before_agent_start",
          prompt: "hello",
          systemPrompt: "Default Pi prompt",
          systemPromptOptions: {},
        } as any,
        ctx
      );
      expect(promptResults).toEqual([
        {
          systemPrompt: expect.stringContaining("Base recipe prompt"),
        },
      ]);
      expect((promptResults[0] as { systemPrompt: string }).systemPrompt).toContain(
        "Current workspace: " + projectDir
      );
      expect((promptResults[0] as { systemPrompt: string }).systemPrompt).toContain(
        "Profile prompt"
      );
      expect((promptResults[0] as { systemPrompt: string }).systemPrompt).toContain(
        "Agent-specific prompt"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps runtime context when agent system instructions replace recipe prompts", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-launch-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(recipeDir, "defs", "main.yaml"),
        [
          "name: main",
          "tools: []",
          "subagents: []",
          "system_instructions:",
          "  mode: replace",
          "  content: Agent replacement prompt",
        ].join("\n")
      );
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("recipe-agent", "main");

      createPiRecipesExtension()(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        extensionContext(projectDir)
      );

      const promptResults = await pi.emitExtensionEvent(
        {
          type: "before_agent_start",
          prompt: "hello",
          systemPrompt: "Default Pi prompt",
          systemPromptOptions: {},
        } as any,
        extensionContext(projectDir)
      );
      const systemPrompt = (promptResults[0] as { systemPrompt: string }).systemPrompt;
      expect(systemPrompt).toContain("Agent replacement prompt");
      expect(systemPrompt).toContain("Recipe Runtime Context");
      expect(systemPrompt).toContain("Current workspace: " + projectDir);
      expect(systemPrompt).not.toContain("Base recipe prompt");
      expect(systemPrompt).not.toContain("Default Pi prompt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads recipe extensions before selecting active recipe tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-launch-"));
    try {
      const recipeDir = writeRecipe(root);
      mkdirSync(join(recipeDir, "extensions"), { recursive: true });
      writeFileSync(
        join(recipeDir, "defs", "main.yaml"),
        [
          "name: main",
          "tools:",
          "  - setup_git",
          "subagents: []",
        ].join("\n")
      );
      writeFileSync(
        join(recipeDir, "extensions", "setup-git.ts"),
        [
          "export default (pi) => {",
          "  pi.registerTool({",
          "    name: 'setup_git',",
          "    label: 'Setup git',",
          "    description: 'Prepare git auth',",
          "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
          "    async execute() {",
          "      return { content: [{ type: 'text', text: 'ok' }], details: {} };",
          "    },",
          "  });",
          "};",
        ].join("\n")
      );
      writeFileSync(
        join(recipeDir, "extensions", "optional-runtime.ts"),
        "export default () => { throw new Error('runtime-only extension unavailable'); };\n"
      );
      writeFileSync(
        join(recipeDir, "package.json"),
        JSON.stringify({
          name: "demo",
          version: "1.0.0",
          pi: {
            agents: ["defs/*.yaml"],
            extensions: ["extensions/*.ts"],
          },
        })
      );
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("recipe-agent", "main");
      createPiRecipesExtension()(pi);
      const notify = vi.fn();

      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        extensionContext(join(root, "project"), notify)
      );

      expect(pi.tools.has("setup_git")).toBe(true);
      expect(pi.activeTools.sort()).toEqual(["agent", "setup_git"]);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("runtime-only extension unavailable"),
        "warning"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("streams recipe agent prompt and output through tool updates", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-launch-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });

      const createChildAgentRunner = vi.fn((opts: any = {}) => {
        return {
          async start() {
            return undefined;
          },
          async prompt() {
            opts.onAssistantMessage?.("streamed output", "delta");
            return "streamed output final";
          },
          async cancel() {},
          async shutdown() {},
        };
      });
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("recipe-agent", "main");

      createPiRecipesExtension({ createChildAgentRunner })(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        extensionContext(projectDir)
      );

      const updates: AgentToolResult<any>[] = [];
      const result = await pi.tools.get("agent")?.execute(
        "tool-call-1",
        { name: "explorer", task: "inspect auth flow" },
        undefined,
        (update) => updates.push(update),
        extensionContext(projectDir)
      );

      expect(createChildAgentRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          recipeDir,
          agentName: "explorer",
          workspaceDir: projectDir,
        })
      );
      expect(updates[0]?.content[0]).toEqual(
        expect.objectContaining({
          text: expect.stringContaining("Prompt:\ninspect auth flow"),
        })
      );
      expect(
        updates.some((update) =>
          String(update.content[0]?.type === "text" ? update.content[0].text : "").includes("streamed output")
        )
      ).toBe(true);
      expect(result?.content[0]).toEqual(
        expect.objectContaining({
          text: expect.stringContaining("streamed output final"),
        })
      );
      expect(result?.details).toEqual(
        expect.objectContaining({
          task: "inspect auth flow",
          status: "completed",
        })
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
