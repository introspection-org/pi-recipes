import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  addRecipe,
  listRecipes,
  parseRecipeSource,
  readRecipePackageManifest,
  RecipePackageError,
  removeRecipe,
  resolveRecipeDirectory,
  validatePiPackageManifest,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("recipe package manifest", () => {
  it("reads neutral recipe.yaml manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-manifest-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writeFileSync(
        join(root, "recipe.yaml"),
        [
          "name: neutral-recipe",
          "version: 0.2.0",
          "description: Portable recipe",
          "entrypoint: reviewer",
          "agents:",
          "  - agents/*.yaml",
          "skills:",
          "  - skills/**/SKILL.md",
          "",
        ].join("\n")
      );

      const manifest = readRecipePackageManifest(root);
      const report = validatePiPackageManifest(manifest);

      expect(manifest).toMatchObject({
        name: "neutral-recipe",
        version: "0.2.0",
        description: "Portable recipe",
        entrypoint: "reviewer",
      });
      expect(manifest.resources.agents).toEqual(["agents/*.yaml"]);
      expect(manifest.resources.skills).toEqual(["skills/**/SKILL.md"]);
      expect(report).toEqual({ valid: true, findings: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads legacy package.json pi manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "recipe-package",
          version: "0.1.0",
          pi: {
            entrypoint: "agent",
            agents: ["./agents/*.yaml"],
            extensions: ["extensions/*.ts"],
            skills: ["skills/**/SKILL.md"],
            themes: ["themes/*.json"],
          },
        })
      );

      const manifest = readRecipePackageManifest(root);
      const report = validatePiPackageManifest(manifest);

      expect(manifest).toMatchObject({
        name: "recipe-package",
        version: "0.1.0",
        entrypoint: "agent",
      });
      expect(manifest.resources.agents).toEqual(["agents/*.yaml"]);
      expect(manifest.resources.extensions).toEqual(["extensions/*.ts"]);
      expect(manifest.resources.skills).toEqual(["skills/**/SKILL.md"]);
      expect(manifest.resources.themes).toEqual(["themes/*.json"]);
      expect(report).toEqual({ valid: true, findings: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads legacy package.json recipe manifests", () => {
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

      const manifest = readRecipePackageManifest(root);

      expect(manifest.name).toBe("recipe-package");
      expect(manifest.resources.agents).toEqual(["agents/*.yaml"]);
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

      expect(() => readRecipePackageManifest(root)).toThrow(RecipePackageError);
      expect(() => readRecipePackageManifest(root)).toThrow(
        /missing recipe\.yaml or legacy package\.json recipe\/pi manifest/
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
      writeFileSync(
        join(root, "recipe.yaml"),
        [
          "name: recipe-package",
          "version: 0.1.0",
          "agents:",
          "  - agents/*.yaml",
          "extensions:",
          "  - extensions/*.ts",
          "  - extensions/*/index.ts",
          "skills:",
          "  - skills/**/SKILL.md",
          "themes:",
          "  - themes/*.json",
          "",
        ].join("\n")
      );

      const manifest = readRecipePackageManifest(root);

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

  it("reports packages with no declared/default agents", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-"));
    try {
      writeFileSync(
        join(root, "recipe.yaml"),
        "name: recipe-package\nversion: 0.1.0\n"
      );

      const report = validatePiPackageManifest(readRecipePackageManifest(root));

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

  it("registers local recipes and resolves them by name", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-store-"));
    const storeDir = join(root, "store");
    const recipeDir = join(root, "recipe");
    try {
      mkdirSync(join(recipeDir, "agents"), { recursive: true });
      writeFileSync(
        join(recipeDir, "recipe.yaml"),
        "name: local-review\nversion: 0.1.0\nagents:\n  - agents/*.yaml\n"
      );

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

  it("installs recipes from explicit git URLs", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-git-store-"));
    const sourceDir = join(root, "source");
    const bareDir = join(root, "recipe.git");
    const storeDir = join(root, "store");
    try {
      mkdirSync(join(sourceDir, "agents"), { recursive: true });
      writeFileSync(
        join(sourceDir, "recipe.yaml"),
        "name: git-review\nversion: 0.3.0\nentrypoint: agent\nagents:\n  - agents/*.yaml\n"
      );
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
      expect(readRecipePackageManifest(installed.path).entrypoint).toBe("agent");
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
      writeFileSync(
        join(sourceDir, "recipe.yaml"),
        `name: ${name}\nversion: 1.0.0\nentrypoint: agent\nagents:\n  - agents/*.yaml\n`
      );
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
      expect(readRecipePackageManifest(second.path).name).toBe("git-collision-two");
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
      writeFileSync(
        join(sourceDir, "recipe.yaml"),
        "name: dep-review\nversion: 0.4.0\nentrypoint: agent\nagents:\n  - agents/*.yaml\nextensions:\n  - extensions/*.ts\n"
      );
      writeFileSync(join(sourceDir, "agents", "agent.yaml"), "name: agent\ntools: []\n");
      writeFileSync(
        join(sourceDir, "package.json"),
        JSON.stringify({
          name: "dep-review-extension-runtime",
          version: "0.0.0",
          type: "module",
          dependencies: {
            "recipe-test-dep": "file:deps/recipe-test-dep",
          },
        })
      );
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
