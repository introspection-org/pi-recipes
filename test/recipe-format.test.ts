import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  packageResourcePaths,
  readPiPackageManifest,
  validatePiPackageManifest,
} from "../src/recipe-package.js";
import { resolveRecipe } from "../src/recipe/resolve.js";

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

    const recipe = resolveRecipe({ recipeDir });
    expect(recipe.agentName).toBe("agent");
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

    expect(() => resolveRecipe({ recipeDir })).toThrow(
      /declares agents resource outside the package/
    );
  });
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
    expect(pkg.exports).toHaveProperty("./session");
    expect(pkg.exports).toHaveProperty("./run");
    expect(pkg.exports).toHaveProperty("./test-utils");
    expect(pkg.files).not.toContain("harbor/pi_recipe_agent.py");
    expect(existsSync(join(root, "src", "cli.ts"))).toBe(false);
    expect(existsSync(join(root, "src", "serve.ts"))).toBe(false);
  });
});
