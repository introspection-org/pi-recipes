import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  packageResourcePaths,
  readPiPackageManifest,
  validatePiPackageManifest,
} from "../src/recipe-package.js";
import { resolveRecipeAgent } from "../src/recipe/resolve.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "recipe-format-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "agents"), { recursive: true });
  mkdirSync(join(root, "skills", "research"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "complete-agent",
      version: "1.0.0",
      description: "A complete portable Pi agent",
      pi: {
        agents: ["agents/*.yaml"],
        skills: ["skills/**/SKILL.md"],
      },
    })
  );
  writeFileSync(
    join(root, "agents", "agent.yaml"),
    [
      "name: agent",
      "model:",
      "  name: anthropic/claude-sonnet-4-5",
      "  thinking_level: high",
      "tools: [read]",
      "skills: [research]",
      "system_instructions:",
      "  mode: append",
      "  content: Produce a sourced answer.",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(root, "skills", "research", "SKILL.md"),
    "---\nname: research\ndescription: Research with sources.\n---\n"
  );
  return root;
}

describe("Recipe Format", () => {
  it("accepts an empty pi manifest with conventional resources and a minimal agent", () => {
    const recipeDir = mkdtempSync(join(tmpdir(), "recipe-format-minimal-"));
    cleanups.push(() => rmSync(recipeDir, { recursive: true, force: true }));
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({ name: "minimal-agent", version: "1.0.0", pi: {} })
    );
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      "name: agent\nmodel:\n  name: anthropic/claude-sonnet-4-5\n"
    );

    const manifest = readPiPackageManifest(recipeDir);
    expect(packageResourcePaths(manifest, "agents")).toEqual([
      join(recipeDir, "agents"),
    ]);
    expect(resolveRecipeAgent({ recipeDir })).toMatchObject({
      name: "agent",
      modelSpec: "anthropic/claude-sonnet-4-5",
      tools: [],
    });
  });

  it("rejects a Recipe with no agent definitions", () => {
    const recipeDir = mkdtempSync(join(tmpdir(), "recipe-format-empty-"));
    cleanups.push(() => rmSync(recipeDir, { recursive: true, force: true }));
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({ name: "empty-agent", version: "1.0.0", pi: {} })
    );

    expect(() => resolveRecipeAgent({ recipeDir })).toThrow(
      'Recipe "empty-agent" does not define any agents'
    );
  });

  it("distinguishes omitted resource conventions from explicit empty arrays", () => {
    const recipeDir = mkdtempSync(join(tmpdir(), "recipe-format-explicit-empty-"));
    cleanups.push(() => rmSync(recipeDir, { recursive: true, force: true }));
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    mkdirSync(join(recipeDir, "skills", "ambient"), { recursive: true });
    mkdirSync(join(recipeDir, "prompts"), { recursive: true });
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      "name: agent\nmodel:\n  name: anthropic/claude-sonnet-4-5\n"
    );
    writeFileSync(
      join(recipeDir, "skills", "ambient", "SKILL.md"),
      "---\nname: ambient\n---\n"
    );
    writeFileSync(join(recipeDir, "prompts", "ambient.md"), "ambient\n");
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "explicit-empty",
        pi: {
          skills: [],
          prompts: [],
        },
      })
    );

    const resolved = resolveRecipeAgent({ recipeDir });
    expect(resolved.skillPaths).toEqual([]);
    expect(resolved.promptPaths).toEqual([]);

    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "explicit-empty",
        pi: { agents: [] },
      })
    );
    expect(() => resolveRecipeAgent({ recipeDir })).toThrow(
      'Recipe "explicit-empty" does not define any agents'
    );
  });

  it("rejects malformed manifest resource shapes in direct resolution", () => {
    const recipeDir = fixture();
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "malformed-resources",
        pi: { agents: "agents/*.yaml" },
      })
    );

    expect(() => resolveRecipeAgent({ recipeDir })).toThrow(
      "package.json#pi.agents must be an array of non-empty strings"
    );
  });

  it("rejects unmatched explicitly declared extension patterns", () => {
    const recipeDir = fixture();
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "missing-extension",
        pi: {
          agents: ["agents/*.yaml"],
          extensions: ["extensions/policy-*.ts"],
        },
      })
    );

    expect(() => resolveRecipeAgent({ recipeDir })).toThrow(
      "declares extensions glob with no matches"
    );
  });

  it("reads and resolves a complete Recipe from ordinary source", () => {
    const recipeDir = fixture();
    const manifest = readPiPackageManifest(recipeDir);

    expect(validatePiPackageManifest(manifest)).toEqual({
      valid: true,
      findings: [],
    });
    expect(packageResourcePaths(manifest, "skills")).toEqual([
      join(recipeDir, "skills", "research", "SKILL.md"),
    ]);

    const recipe = resolveRecipeAgent({ recipeDir });
    expect(recipe.name).toBe("agent");
    expect(recipe.modelSpec).toBe("anthropic/claude-sonnet-4-5");
    expect(recipe.tools).toEqual(["read"]);
    expect(recipe.skillPaths).toEqual([
      join(recipeDir, "skills", "research", "SKILL.md"),
    ]);
  });

  it("rejects resources that escape the package", () => {
    const recipeDir = fixture();
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "escaping-agent",
        pi: { agents: ["../agents/*.yaml"] },
      })
    );

    expect(() => resolveRecipeAgent({ recipeDir })).toThrow(
      /declares agents resource outside the package/
    );
  });

  it("resolves the package extension closure deterministically", () => {
    const recipeDir = fixture();
    mkdirSync(join(recipeDir, "extensions"), { recursive: true });
    writeFileSync(
      join(recipeDir, "extensions", "first.ts"),
      "export default () => {};\n"
    );
    writeFileSync(
      join(recipeDir, "extensions", "second.ts"),
      "export default () => {};\n"
    );
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "complete-agent",
        pi: {
          agents: ["agents/*.yaml"],
          extensions: [
            "extensions/second.ts",
            "extensions/first.ts",
          ],
        },
      })
    );

    expect(
      resolveRecipeAgent({ recipeDir }).extensionPaths
    ).toEqual([
      join(recipeDir, "extensions", "second.ts"),
      join(recipeDir, "extensions", "first.ts"),
    ]);

    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "complete-agent",
        pi: {
          agents: ["agents/*.yaml"],
          extensions: ["extensions/*.ts"],
        },
      })
    );
    expect(resolveRecipeAgent({ recipeDir }).extensionPaths).toEqual([
      join(recipeDir, "extensions", "first.ts"),
      join(recipeDir, "extensions", "second.ts"),
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "rejects extension symlinks that execute outside the package",
    () => {
    const recipeDir = fixture();
    const outside = join(recipeDir, "..", `${basename(recipeDir)}-outside.ts`);
    writeFileSync(outside, "export default () => {};\n");
    cleanups.push(() => rmSync(outside, { force: true }));
    mkdirSync(join(recipeDir, "extensions"), { recursive: true });
    symlinkSync(outside, join(recipeDir, "extensions", "outside.ts"));
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "complete-agent",
        pi: {
          agents: ["agents/*.yaml"],
          extensions: ["extensions/outside.ts"],
        },
      })
    );

    expect(() => resolveRecipeAgent({ recipeDir })).toThrow(
      "Recipe extensions resource resolves outside the package"
    );
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects SYSTEM.md symlinks that resolve outside the package",
    () => {
      const recipeDir = fixture();
      const outside = join(
        recipeDir,
        "..",
        `${basename(recipeDir)}-outside-system.md`
      );
      writeFileSync(outside, "outside prompt\n");
      cleanups.push(() => rmSync(outside, { force: true }));
      symlinkSync(outside, join(recipeDir, "SYSTEM.md"));

      expect(() => resolveRecipeAgent({ recipeDir })).toThrow(
        "Recipe SYSTEM.md resolves outside the package"
      );
    }
  );
});

describe("npm package boundary", () => {
  it("ships a library and Pi extension without a standalone CLI or server", () => {
    const root = join(import.meta.dirname, "..");
    const pkg = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8")
    ) as {
      name: string;
      description: string;
      bin?: unknown;
      exports: Record<string, unknown>;
      files: string[];
    };

    expect(pkg.name).toBe("@introspection-ai/recipes");
    expect(pkg.description).toBe(
      "The open package format for complete, portable Pi agents."
    );
    expect(pkg.bin).toBeUndefined();
    expect(pkg.exports).not.toHaveProperty("./serve");
    expect(pkg.exports).not.toHaveProperty("./agui");
    expect(pkg.exports).not.toHaveProperty("./tracing");
    expect(pkg.exports).toHaveProperty("./session");
    expect(pkg.exports).toHaveProperty("./extensions");
    expect(pkg.exports).not.toHaveProperty("./run");
    expect(pkg.exports).toHaveProperty("./test-utils");
    expect(existsSync(join(root, "src", "cli.ts"))).toBe(false);
    expect(existsSync(join(root, "src", "serve.ts"))).toBe(false);
    // Internal snapshot bridge used by `pi --recipe`; it is not exposed in
    // package.json#bin and therefore does not restore a Recipes CLI.
    expect(
      existsSync(join(root, "crates", "recipe-check", "src", "main.rs"))
    ).toBe(true);
    expect(existsSync(join(root, "bindings"))).toBe(false);
    expect(existsSync(join(root, "harbor"))).toBe(false);
    expect(existsSync(join(root, "docs", "recipe-evals.md"))).toBe(false);
  });
});
