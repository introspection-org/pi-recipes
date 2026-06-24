import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createPiRecipesExtension } from "../src/pi-extension.js";
import { createMockExtensionAPI } from "../src/testing.js";

function extensionContext(cwd: string, notify = vi.fn()) {
  const authStorage = { kind: "shared-auth-storage" };
  return {
    cwd,
    hasUI: true,
    ui: { notify },
    modelRegistry: {
      authStorage,
      find: vi.fn((provider: string, id: string) => ({ provider, id })),
    },
  } as any;
}

function writeRecipe(root: string) {
  const recipeDir = join(root, "recipe");
  mkdirSync(join(recipeDir, "defs"), { recursive: true });
  mkdirSync(join(recipeDir, "skills", "repo-index"), { recursive: true });
  mkdirSync(join(recipeDir, "prompts"), { recursive: true });
  mkdirSync(join(recipeDir, "themes"), { recursive: true });
  writeFileSync(
    join(recipeDir, "package.json"),
    `${JSON.stringify(
      {
        name: "demo",
        version: "1.0.0",
        pi: {
          agents: ["defs/*.yaml"],
          skills: ["skills/**/SKILL.md"],
          prompts: ["prompts"],
          themes: ["themes/*.json"],
        },
      },
      null,
      2
    )}\n`
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
  writeFileSync(join(recipeDir, "skills", "repo-index", "SKILL.md"), "---\ndescription: Index repo\n---\n");
  writeFileSync(join(recipeDir, "prompts", "review.md"), "Review this\n");
  writeFileSync(join(recipeDir, "themes", "demo.json"), "{}\n");
  return recipeDir;
}

describe("Pi recipes launch extension", () => {
  it("registers recipe launch flags", async () => {
    const pi = createMockExtensionAPI();
    createPiRecipesExtension()(pi);

    expect(pi.commands.has("recipe")).toBe(true);
    expect(pi.commands.has("recipe-resources")).toBe(false);
    expect(pi.flags.has("recipe")).toBe(true);
    expect(pi.flags.has("agent")).toBe(true);

    const results = await pi.emitExtensionEvent(
      { type: "resources_discover", cwd: process.cwd(), reason: "startup" } as any,
      extensionContext(process.cwd())
    );
    expect(results).toEqual([{}]);
    expect(pi.activeTools).toEqual([]);
  });

  it("reports when recipe inspection commands run without an active recipe", async () => {
    const pi = createMockExtensionAPI();
    const notify = vi.fn();
    createPiRecipesExtension()(pi);

    await pi.commands.get("recipe")?.handler("", extensionContext(process.cwd(), notify));

    expect(notify).toHaveBeenCalledWith(
      "No recipe is active. Launch Pi with --recipe <recipe>.",
      "info"
    );
  });

  it("reports a friendly message when the selected recipe is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-missing-"));
    try {
      const pi = createMockExtensionAPI();
      const notify = vi.fn();
      const ctx = extensionContext(root, notify);
      pi.flagValues.set("recipe", "missing-recipe");

      createPiRecipesExtension()(pi);
      await expect(
        pi.emitExtensionEvent({ type: "session_start", reason: "startup" } as any, ctx)
      ).resolves.toEqual([undefined]);

      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining('Recipe "missing-recipe" was not found.'),
        "warning"
      );
      const message = notify.mock.calls[0]?.[0] as string;
      expect(message).toContain("pi-recipes list");
      expect(message).toContain("pi-recipes install <source>");
      expect(message).not.toContain("RecipePackageError");
      expect(message).not.toContain("at ");

      const resourceResults = await pi.emitExtensionEvent(
        { type: "resources_discover", cwd: root, reason: "startup" } as any,
        ctx
      );
      expect(resourceResults).toEqual([{}]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      pi.flagValues.set("agent", "main");

      createPiRecipesExtension()(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      expect(pi.sessionName).toBe("demo@1.0.0 agent:main");
      expect(pi.model).toEqual({ provider: "openai", id: "gpt-4.1" });
      expect(pi.thinkingLevel).toBe("low");
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
        "Agent-specific prompt"
      );

      await pi.commands.get("recipe")?.handler("", ctx as any);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Name: demo@1.0.0"),
        "info"
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Agent: main"),
        "info"
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Active recipe tools:"),
        "info"
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("  - bash"),
        "info"
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("  - read"),
        "info"
      );
      const recipeMessage = notify.mock.calls
        .map((call) => call[0])
        .find((message): message is string =>
          typeof message === "string" && message.includes("Active Recipe")
        );
      expect(recipeMessage).not.toContain(join(recipeDir, "skills", "repo-index", "SKILL.md"));
      expect(recipeMessage).not.toContain(join(recipeDir, "prompts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reloads recipe state through the recipe command", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-reload-"));
    try {
      const recipeDir = writeRecipe(root);
      const projectDir = join(root, "project");
      mkdirSync(projectDir, { recursive: true });
      const notify = vi.fn();
      const reload = vi.fn();
      const waitForIdle = vi.fn();
      const ctx = {
        ...extensionContext(projectDir, notify),
        reload,
        waitForIdle,
      } as any;
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");

      createPiRecipesExtension()(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      mkdirSync(join(recipeDir, "skills", "new-skill"), { recursive: true });
      writeFileSync(join(recipeDir, "skills", "new-skill", "SKILL.md"), "---\ndescription: New\n---\n");
      writeFileSync(
        join(recipeDir, "package.json"),
        `${JSON.stringify(
          {
            name: "demo",
            version: "1.0.0",
            pi: {
              agents: ["defs/*.yaml"],
              skills: ["skills/new-skill/SKILL.md"],
            },
          },
          null,
          2
        )}\n`
      );

      await pi.commands.get("recipe")?.handler("reload", ctx);

      expect(waitForIdle).toHaveBeenCalled();
      expect(reload).toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(
        "Recipe reload requested: demo@1.0.0",
        "info"
      );

      const resourceResults = await pi.emitExtensionEvent(
        { type: "resources_discover", cwd: projectDir, reason: "reload" } as any,
        ctx
      );
      expect(resourceResults).toEqual([
        expect.objectContaining({
          skillPaths: [join(recipeDir, "skills", "new-skill", "SKILL.md")],
        }),
      ]);
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
      pi.flagValues.set("agent", "main");

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
      mkdirSync(join(recipeDir, "node_modules", "recipe-test-dep"), { recursive: true });
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
          "import dep from 'recipe-test-dep';",
          "export default (pi) => {",
          "  if (dep.value !== 'loaded') throw new Error('recipe dependency did not load');",
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
        join(recipeDir, "node_modules", "recipe-test-dep", "package.json"),
        JSON.stringify({ name: "recipe-test-dep", version: "1.0.0", main: "index.js" })
      );
      writeFileSync(
        join(recipeDir, "node_modules", "recipe-test-dep", "index.js"),
        "module.exports = { value: 'loaded' };\n"
      );
      writeFileSync(
        join(recipeDir, "package.json"),
        `${JSON.stringify(
          {
            name: "demo",
            version: "1.0.0",
            pi: {
              agents: ["defs/*.yaml"],
              extensions: ["extensions/*.ts"],
            },
          },
          null,
          2
        )}\n`
      );
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");
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

  it("filters recipe extensions through the selected agent", async () => {
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
          "extensions:",
          "  include:",
          "    - \"*\"",
          "  exclude:",
          "    - optional-runtime",
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
        "export default () => { throw new Error('excluded extension loaded'); };\n"
      );
      writeFileSync(
        join(recipeDir, "package.json"),
        `${JSON.stringify(
          {
            name: "demo",
            version: "1.0.0",
            pi: {
              agents: ["defs/*.yaml"],
              extensions: ["extensions/*.ts"],
            },
          },
          null,
          2
        )}\n`
      );
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");
      createPiRecipesExtension()(pi);
      const notify = vi.fn();

      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        extensionContext(join(root, "project"), notify)
      );

      expect(pi.tools.has("setup_git")).toBe(true);
      expect(pi.activeTools.sort()).toEqual(["agent", "setup_git"]);
      expect(notify).not.toHaveBeenCalledWith(
        expect.stringContaining("excluded extension loaded"),
        "warning"
      );
      expect(notify).toHaveBeenCalledWith(
        "Recipe extensions: 1/1 loaded",
        "info"
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
            opts.onToolEvent?.({
              type: "start",
              id: "read-a",
              name: "read",
              args: { path: "src/a.ts" },
            });
            opts.onToolEvent?.({
              type: "start",
              id: "read-b",
              name: "read",
              args: { path: "src/b.ts" },
            });
            opts.onToolEvent?.({
              type: "end",
              id: "read-b",
              name: "read",
              args: { path: "src/b.ts" },
              result: { content: [{ type: "text", text: "file b" }], details: undefined },
              isError: false,
            });
            opts.onToolEvent?.({
              type: "end",
              id: "read-a",
              name: "read",
              args: { path: "src/a.ts" },
              result: { content: [{ type: "text", text: "file a" }], details: undefined },
              isError: false,
            });
            opts.onAssistantMessage?.("streamed output", "delta");
            return "streamed output final";
          },
          async cancel() {},
          async shutdown() {},
        };
      });
      const pi = createMockExtensionAPI();
      pi.flagValues.set("recipe", recipeDir);
      pi.flagValues.set("agent", "main");
      const ctx = extensionContext(projectDir);

      createPiRecipesExtension({ createChildAgentRunner })(pi);
      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      const updates: AgentToolResult<any>[] = [];
      const result = await pi.tools.get("agent")?.execute(
        "tool-call-1",
        { name: "explorer", task: "inspect auth flow" },
        undefined,
        (update) => updates.push(update),
        ctx
      );

      expect(createChildAgentRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          recipeDir,
          agentName: "explorer",
          workspaceDir: projectDir,
          authStorage: ctx.modelRegistry.authStorage,
          modelRegistry: ctx.modelRegistry,
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
          tool_calls: [
            expect.objectContaining({
              id: "read-a",
              name: "read",
              status: "completed",
              output: "file a",
            }),
            expect.objectContaining({
              id: "read-b",
              name: "read",
              status: "completed",
              output: "file b",
            }),
          ],
        })
      );
      const rendered = pi.tools.get("agent")?.renderResult?.(
        result as any,
        { expanded: false, isPartial: false },
        { fg: (_name: string, text: string) => text, bold: (text: string) => text } as any,
        { lastComponent: undefined } as any
      );
      expect(rendered?.render(100).join("\n")).toContain("Tool calls:");
      expect(rendered?.render(100).join("\n")).toContain("read src/a.ts [done]");
      expect(rendered?.render(100).join("\n")).not.toContain("Prompt:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
