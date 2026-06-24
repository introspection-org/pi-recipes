import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createRecipeChildAgentRunner } from "../src/child-agent.js";
import {
  addRecipe,
  createRecipePublishGuide,
  createRecipeScaffold,
  customizeRecipe,
  listRecipes,
  loadRecipeAgentDefinitions,
  packageResourcePaths,
  parseRecipeSource,
  readPiPackageManifest,
  RecipePackageError,
  removeRecipe,
  resolveRecipeAgentDefinition,
  resolveRecipeDirectory,
  validateResolvedRecipeAgentDefinition,
  validateRecipeDirectory,
  validatePiPackageManifest,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

function writePiPackageManifest(
  root: string,
  pkg: Record<string, unknown>
): void {
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

describe("recipe package manifest", () => {
  it("scaffolds a working starter recipe", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-scaffold-"));
    try {
      const result = createRecipeScaffold("my-recipe", {
        cwd: root,
        name: "my-recipe",
      });

      expect(result).toMatchObject({
        recipeDir: join(root, "my-recipe"),
        name: "my-recipe",
      });
      expect(result.files.map((file) => file.action)).toEqual([
        "created",
        "created",
        "created",
        "created",
      ]);
      expect(readPiPackageManifest(result.recipeDir).name).toBe("my-recipe");
      expect(loadRecipeAgentDefinitions(result.recipeDir).get("agent")).toMatchObject({
        name: "agent",
        tools: ["read", "bash"],
      });
      expect(validateRecipeDirectory(result.recipeDir)).toMatchObject({
        valid: true,
        findings: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite scaffold files unless forced", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-scaffold-"));
    try {
      const recipeDir = join(root, "my-recipe");
      mkdirSync(recipeDir, { recursive: true });
      writePiPackageManifest(recipeDir, { name: "existing", version: "0.0.0", pi: {} });

      expect(() => createRecipeScaffold(recipeDir)).toThrow(/would overwrite/);
      const result = createRecipeScaffold(recipeDir, { force: true });

      expect(result.files[0]).toMatchObject({
        path: join(recipeDir, "package.json"),
        action: "overwritten",
      });
      expect(readPiPackageManifest(recipeDir).name).toBe("my-recipe");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads package.json pi manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-manifest-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writePiPackageManifest(root, {
        name: "pi-recipe",
        version: "0.2.0",
        description: "Pi recipe",
        pi: {
          agents: ["agents/*.yaml"],
          skills: ["skills/**/SKILL.md"],
        },
      });

      const manifest = readPiPackageManifest(root);
      const report = validatePiPackageManifest(manifest);

      expect(manifest).toMatchObject({
        name: "pi-recipe",
        version: "0.2.0",
        description: "Pi recipe",
      });
      expect(manifest.resources.agents).toEqual(["agents/*.yaml"]);
      expect(manifest.resources.skills).toEqual(["skills/**/SKILL.md"]);
      expect(report).toEqual({ valid: true, findings: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads package.json pi blocks as recipe manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-"));
    try {
      writePiPackageManifest(root, {
        name: "recipe-package",
        version: "0.1.0",
        description: "Pi recipe",
        pi: {
          agents: ["./agents/*.yaml"],
          extensions: ["extensions/*.ts"],
          skills: ["skills/**/SKILL.md"],
          prompts: ["prompts/*.md"],
          themes: ["themes/*.json"],
        },
      });

      const manifest = readPiPackageManifest(root);
      const report = validatePiPackageManifest(manifest);

      expect(manifest).toMatchObject({
        name: "recipe-package",
        version: "0.1.0",
        description: "Pi recipe",
      });
      expect(manifest.resources).toEqual({
        agents: ["agents/*.yaml"],
        extensions: ["extensions/*.ts"],
        skills: ["skills/**/SKILL.md"],
        prompts: ["prompts/*.md"],
        themes: ["themes/*.json"],
      });
      expect(report).toEqual({ valid: true, findings: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects package.json files without pi manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-package-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "recipe-package",
          version: "0.1.0",
          recipe: {
            agents: ["agents/*.yaml"],
          },
        })
      );

      expect(() => readPiPackageManifest(root)).toThrow(RecipePackageError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not treat plain package.json files as recipe manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "dependency-package-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "dependency-package",
          version: "0.1.0",
          dependencies: {
            zod: "^4.0.0",
          },
        })
      );

      expect(() => readPiPackageManifest(root)).toThrow(RecipePackageError);
      expect(() => readPiPackageManifest(root)).toThrow(
        /missing package\.json pi manifest/
      );
      expect(() => readPiPackageManifest(root)).toThrow(
        /missing package\.json pi manifest/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("expands declared package resource globs and tolerates empty optional globs", async () => {
    const {
      packageResourcePaths,
      resolvePiPackageResourcePaths,
      RecipePackageError,
    } = await import("../src/index.js");
    const root = mkdtempSync(join(tmpdir(), "pi-package-"));
    try {
      mkdirSync(join(root, "skills", "repo-index"), { recursive: true });
      mkdirSync(join(root, "extensions"), { recursive: true });
      writeFileSync(join(root, "skills", "repo-index", "SKILL.md"), "Index repos\n");
      writeFileSync(join(root, "extensions", "tools.ts"), "export default () => {}\n");
      writePiPackageManifest(root, {
        name: "recipe-package",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
          extensions: ["extensions/*.ts", "extensions/*/index.ts"],
          skills: ["skills/**/SKILL.md"],
          themes: ["themes/*.json"],
        },
      });

      const manifest = readPiPackageManifest(root);

      expect(packageResourcePaths(manifest, "skills")).toEqual([
        join(root, "skills", "repo-index", "SKILL.md"),
      ]);
      expect(packageResourcePaths(manifest, "extensions")).toEqual([
        join(root, "extensions", "tools.ts"),
      ]);
      expect(packageResourcePaths(manifest, "themes")).toEqual([]);
      expect(() => resolvePiPackageResourcePaths(manifest, "agents")).toThrow(
        RecipePackageError
      );
      expect(() => resolvePiPackageResourcePaths(manifest, "agents")).toThrow(
        /glob with no matches/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects declared package resources outside the recipe directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-boundary-"));
    try {
      const recipeDir = join(root, "recipe");
      mkdirSync(recipeDir, { recursive: true });
      mkdirSync(join(root, "outside-prompts"), { recursive: true });
      writePiPackageManifest(recipeDir, {
        name: "escaped-resources",
        version: "0.1.0",
        pi: {
          prompts: ["../outside-prompts"],
        },
      });

      const manifest = readPiPackageManifest(recipeDir);

      expect(() => packageResourcePaths(manifest, "prompts")).toThrow(
        /outside the package/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports packages with no declared/default agents", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-"));
    try {
      writePiPackageManifest(root, {
        name: "recipe-package",
        version: "0.1.0",
        pi: {
          prompts: ["prompts"],
        },
      });

      const report = validatePiPackageManifest(readPiPackageManifest(root));

      expect(report.valid).toBe(true);
      expect(report.findings).toEqual([
        {
          severity: "warning",
          code: "package.no_agents",
          message: "Package declares no agents and has no agents directory",
          packageName: "recipe-package",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports invalid resource globs during recipe development validation", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-dev-validation-"));
    try {
      writePiPackageManifest(root, {
        name: "broken-recipe",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });

      const report = validateRecipeDirectory(root);

      expect(report.valid).toBe(false);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            code: "package.agents_invalid",
          }),
        ])
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a publish guide from a valid recipe", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-publish-guide-"));
    try {
      const { recipeDir } = createRecipeScaffold("guide-recipe", { cwd: root });
      const guide = createRecipePublishGuide(recipeDir);

      expect(guide.report.valid).toBe(true);
      expect(guide.checklist).toContain("Run `pi-recipes doctor .` and fix any errors.");
      expect(guide.sourceExamples).toContain("pi-recipes install github:owner/guide-recipe");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("recipe agent definitions", () => {
  it("resolves variants through agent from inheritance", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-agents-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writePiPackageManifest(root, {
        name: "inherited-agents",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(
        join(root, "agents", "agent.yaml"),
        [
          "name: agent",
          "description: Base agent",
          "model:",
          "  name: openai/gpt-5.4",
          "  thinking_level: low",
          "tools:",
          "  - read",
          "  - bash",
          "skills:",
          "  - repo-index",
          "subagents:",
          "  - explorer",
          "extensions:",
          "  include:",
          "    - \"*\"",
          "  exclude:",
          "    - optional-runtime",
          "system_instructions:",
          "  mode: append",
          "  content: Base prompt",
          "",
        ].join("\n")
      );
      writeFileSync(
        join(root, "agents", "agent-opus.yaml"),
        [
          "name: agent-opus",
          "from: agent",
          "model:",
          "  name: openrouter/anthropic/claude-opus-4.8",
          "tools:",
          "  - read",
          "extensions:",
          "  exclude:",
          "    - optional-runtime",
          "    - tracing",
          "",
        ].join("\n")
      );

      const definitions = loadRecipeAgentDefinitions(root);
      const inherited = definitions.get("agent-opus");

      expect(resolveRecipeAgentDefinition({ recipeDir: root }).agentName).toBe("agent");
      expect(inherited).toEqual(
        expect.objectContaining({
          name: "agent-opus",
          from: "agent",
          description: "Base agent",
          model: {
            name: "openrouter/anthropic/claude-opus-4.8",
            thinkingLevel: "low",
          },
          tools: ["read"],
          skills: ["repo-index"],
          subagents: ["explorer"],
          extensions: {
            include: ["*"],
            exclude: ["optional-runtime", "tracing"],
          },
          systemInstructions: {
            mode: "append",
            content: "Base prompt",
          },
        })
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("recipe child agents", () => {
  it("requires child agents to declare a model name", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-child-agent-"));
    const recipeDir = join(root, "recipe");
    const workspaceDir = join(root, "workspace");
    try {
      mkdirSync(join(recipeDir, "agents"), { recursive: true });
      mkdirSync(workspaceDir, { recursive: true });
      writePiPackageManifest(recipeDir, {
        name: "child-agent-model",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(
        join(recipeDir, "agents", "worker.yaml"),
        "name: worker\ntools: []\n"
      );

      const runner = createRecipeChildAgentRunner({
        recipeDir,
        workspaceDir,
        agentName: "worker",
        env: {},
      });

      await expect(runner.start()).rejects.toThrow(
        'Recipe agent "worker" must declare model.name'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts required child agent fields inherited through from", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-child-agent-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writePiPackageManifest(root, {
        name: "child-agent-model",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(
        join(root, "agents", "base.yaml"),
        [
          "name: base",
          "model:",
          "  name: test/provider-model",
          "  thinking_level: low",
          "tools: []",
          "skills: []",
          "subagents: []",
          "system_instructions:",
          "  mode: append",
          "  content: Base instructions",
          "",
        ].join("\n")
      );
      writeFileSync(
        join(root, "agents", "worker.yaml"),
        "name: worker\nfrom: base\nmodel:\n  thinking_level: medium\n"
      );

      expect(
        validateResolvedRecipeAgentDefinition({
          recipeDir: root,
          agentName: "worker",
          requireExplicitName: true,
          requiredFields: [
            "model.name",
            "model.thinkingLevel",
            "tools",
            "skills",
            "subagents",
            "systemInstructions",
          ],
        })
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires child agent names to be explicit in each file", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-child-agent-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writePiPackageManifest(root, {
        name: "child-agent-model",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(
        join(root, "agents", "worker.yaml"),
        [
          "model:",
          "  name: test/provider-model",
          "  thinking_level: low",
          "tools: []",
          "skills: []",
          "subagents: []",
          "system_instructions:",
          "  mode: append",
          "  content: Worker instructions",
          "",
        ].join("\n")
      );

      expect(
        validateResolvedRecipeAgentDefinition({
          recipeDir: root,
          agentName: "worker",
          requireExplicitName: true,
          requiredFields: [
            "model.name",
            "model.thinkingLevel",
            "tools",
            "skills",
            "subagents",
            "systemInstructions",
          ],
        })
      ).toEqual([
        {
          agentName: "worker",
          field: "name",
          message: 'Recipe agent "worker" must declare name',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("recipe store", () => {
  it("parses explicit git and github recipe sources", () => {
    expect(parseRecipeSource("github:owner/repo/path#v1")).toMatchObject({
      kind: "github",
      owner: "owner",
      repo: "repo",
      subdir: "path",
      ref: "v1",
    });
    expect(parseRecipeSource("git@github.com:owner/private.git#main")).toMatchObject({
      kind: "git",
      url: "git@github.com:owner/private.git",
      ref: "main",
    });
    expect(parseRecipeSource("git+https://example.com/team/recipe.git#abc123")).toMatchObject({
      kind: "git",
      url: "https://example.com/team/recipe.git",
      ref: "abc123",
    });
  });

  it("rejects github recipe sources with traversal segments", () => {
    expect(() => parseRecipeSource("github:owner/repo/../outside#main")).toThrow(
      /Unsupported recipe source/
    );
    expect(() => parseRecipeSource("github:owner/../recipe#v1")).toThrow(
      /Unsupported recipe source/
    );
    expect(() => parseRecipeSource("github:owner/repo/path#../secret")).toThrow(
      /Unsupported recipe source/
    );
  });

  it("redacts credentials from explicit git clone errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-git-redact-"));
    try {
      let message = "";
      try {
        await addRecipe("git+https://user:secret-token@127.0.0.1:1/nope.git", {
          storeDir: join(root, "store"),
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }

      expect(message).toMatch(/git\+https:\/\/\*\*\*@127\.0\.0\.1:1\/nope\.git/);
      expect(message).not.toContain("secret-token");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers local recipes and resolves them by name", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-store-"));
    const storeDir = join(root, "store");
    const recipeDir = join(root, "recipe");
    try {
      mkdirSync(join(recipeDir, "agents"), { recursive: true });
      writePiPackageManifest(recipeDir, {
        name: "local-review",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });

      const installed = await addRecipe(recipeDir, { storeDir });

      expect(installed.name).toBe("local-review");
      expect(listRecipes({ storeDir })).toEqual([installed]);
      expect(resolveRecipeDirectory("local-review", { storeDir })).toBe(recipeDir);
      expect(removeRecipe("local-review", { storeDir })).toEqual(installed);
      expect(listRecipes({ storeDir })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("customizes installed recipes into editable local copies", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-customize-"));
    const storeDir = join(root, "store");
    const sourceDir = join(root, "source");
    try {
      mkdirSync(join(sourceDir, "agents"), { recursive: true });
      mkdirSync(join(sourceDir, "node_modules", "transient"), { recursive: true });
      mkdirSync(join(sourceDir, ".git"), { recursive: true });
      writePiPackageManifest(sourceDir, {
        name: "upstream-review",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(join(sourceDir, "agents", "agent.yaml"), "name: agent\ntools: []\n");
      writeFileSync(join(sourceDir, "node_modules", "transient", "index.js"), "module.exports = {};\n");
      writeFileSync(join(sourceDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      const original = await addRecipe(sourceDir, { storeDir });
      const customized = await customizeRecipe("upstream-review", { storeDir });

      expect(customized.original).toEqual(original);
      expect(customized.recipe.name).toBe("upstream-review");
      expect(customized.path).toBe(join(storeDir, "local", "upstream-review"));
      expect(customized.overwritten).toBe(false);
      expect(resolveRecipeDirectory("upstream-review", { storeDir })).toBe(customized.path);
      expect(listRecipes({ storeDir })).toEqual([customized.recipe]);
      expect(readPiPackageManifest(customized.path).resources.agents).toEqual(["agents/*.yaml"]);
      expect(existsSync(join(customized.path, "agents", "agent.yaml"))).toBe(true);
      expect(existsSync(join(customized.path, "node_modules"))).toBe(false);
      expect(existsSync(join(customized.path, ".git"))).toBe(false);
      const alreadyCustomized = await customizeRecipe("upstream-review", { storeDir });
      expect(alreadyCustomized.path).toBe(customized.path);
      expect(alreadyCustomized.overwritten).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs recipes from explicit git URLs", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-git-store-"));
    const sourceDir = join(root, "source");
    const bareDir = join(root, "recipe.git");
    const storeDir = join(root, "store");
    try {
      mkdirSync(join(sourceDir, "agents"), { recursive: true });
      writePiPackageManifest(sourceDir, {
        name: "git-review",
        version: "0.3.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(join(sourceDir, "agents", "agent.yaml"), "name: agent\ntools: []\n");
      await execFileAsync("git", ["init"], { cwd: sourceDir });
      await execFileAsync("git", ["add", "."], { cwd: sourceDir });
      await execFileAsync(
        "git",
        ["-c", "user.name=Recipe Test", "-c", "user.email=recipe@example.com", "commit", "-m", "recipe"],
        { cwd: sourceDir }
      );
      await execFileAsync("git", ["tag", "v0.3.0"], { cwd: sourceDir });
      await execFileAsync("git", ["clone", "--bare", sourceDir, bareDir]);

      const installed = await addRecipe(`file://${bareDir}#v0.3.0`, { storeDir });

      expect(installed).toMatchObject({
        id: `git:file://${bareDir}#v0.3.0`,
        name: "git-review",
        version: "0.3.0",
      });
      expect(resolveRecipeDirectory("git-review", { storeDir })).toBe(installed.path);
      expect(resolveRecipeDirectory("recipe", { storeDir })).toBe(installed.path);
      expect(readPiPackageManifest(installed.path).resources.agents).toEqual(["agents/*.yaml"]);
      expect(removeRecipe("recipe", { storeDir })).toEqual(installed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps explicit git URL clone caches distinct after sanitization", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-git-collision-"));
    const storeDir = join(root, "store");
    const firstSourceDir = join(root, "first-source");
    const secondSourceDir = join(root, "second-source");
    const firstBareDir = join(root, "a-b.git");
    const secondBareDir = join(root, "a", "b.git");

    async function createBareRecipeRepo(sourceDir: string, bareDir: string, name: string) {
      mkdirSync(join(sourceDir, "agents"), { recursive: true });
      writePiPackageManifest(sourceDir, {
        name,
        version: "1.0.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(join(sourceDir, "agents", "agent.yaml"), "name: agent\ntools: []\n");
      await execFileAsync("git", ["init"], { cwd: sourceDir });
      await execFileAsync("git", ["add", "."], { cwd: sourceDir });
      await execFileAsync(
        "git",
        ["-c", "user.name=Recipe Test", "-c", "user.email=recipe@example.com", "commit", "-m", "recipe"],
        { cwd: sourceDir }
      );
      await execFileAsync("git", ["tag", "v1"], { cwd: sourceDir });
      await execFileAsync("git", ["clone", "--bare", sourceDir, bareDir]);
    }

    try {
      mkdirSync(join(root, "a"), { recursive: true });
      await createBareRecipeRepo(firstSourceDir, firstBareDir, "git-collision-one");
      await createBareRecipeRepo(secondSourceDir, secondBareDir, "git-collision-two");

      const first = await addRecipe(`file://${firstBareDir}#v1`, { storeDir });
      const second = await addRecipe(`file://${secondBareDir}#v1`, { storeDir });

      expect(first.path).not.toBe(second.path);
      expect(first.name).toBe("git-collision-one");
      expect(second.name).toBe("git-collision-two");
      expect(readPiPackageManifest(second.path).name).toBe("git-collision-two");
      expect(listRecipes({ storeDir }).map((recipe) => recipe.name).sort()).toEqual([
        "git-collision-one",
        "git-collision-two",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs extension runtime dependencies for cloned recipes", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-git-deps-"));
    const sourceDir = join(root, "source");
    const bareDir = join(root, "recipe.git");
    const storeDir = join(root, "store");
    try {
      mkdirSync(join(sourceDir, "agents"), { recursive: true });
      mkdirSync(join(sourceDir, "deps", "recipe-test-dep"), { recursive: true });
      writeFileSync(join(sourceDir, "agents", "agent.yaml"), "name: agent\ntools: []\n");
      writePiPackageManifest(sourceDir, {
        name: "dep-review",
        version: "0.4.0",
        type: "module",
        pi: {
          agents: ["agents/*.yaml"],
          extensions: ["extensions/*.ts"],
        },
        dependencies: {
          "recipe-test-dep": "file:deps/recipe-test-dep",
        },
      });
      writeFileSync(
        join(sourceDir, "deps", "recipe-test-dep", "package.json"),
        JSON.stringify({ name: "recipe-test-dep", version: "1.0.0", main: "index.js" })
      );
      writeFileSync(
        join(sourceDir, "deps", "recipe-test-dep", "index.js"),
        "module.exports = { value: 'installed' };\n"
      );
      await execFileAsync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: sourceDir });
      await execFileAsync("git", ["init"], { cwd: sourceDir });
      await execFileAsync("git", ["add", "."], { cwd: sourceDir });
      await execFileAsync(
        "git",
        ["-c", "user.name=Recipe Test", "-c", "user.email=recipe@example.com", "commit", "-m", "recipe"],
        { cwd: sourceDir }
      );
      await execFileAsync("git", ["tag", "v0.4.0"], { cwd: sourceDir });
      await execFileAsync("git", ["clone", "--bare", sourceDir, bareDir]);

      const installed = await addRecipe(`file://${bareDir}#v0.4.0`, { storeDir });

      expect(installed.name).toBe("dep-review");
      expect(
        await readFile(join(installed.path, "node_modules", "recipe-test-dep", "index.js"), "utf8")
      ).toContain("installed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("package boundary", () => {
  it("keeps the package free of Introspection runtime dependencies", async () => {
    const root = join(import.meta.dirname, "..", "src");
    const files = await collectFiles(root);
    const forbidden = [
      "@introspection-sdk/",
      "INTROSPECTION_",
      "/v1/",
      "/internal/",
      "DPClient",
    ];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const token of forbidden) {
        expect(content, `${file} contains ${token}`).not.toContain(token);
      }
    }
  });
});

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}
