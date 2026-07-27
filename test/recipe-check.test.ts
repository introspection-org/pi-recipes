import {
  chmodSync,
  copyFileSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRecipeAtLoad } from "../src/recipe-check.js";
import { resolveRecipe } from "../src/recipe/resolve.js";

describe("shared Recipe validator bridge", () => {
  const roots: string[] = [];
  const env = {
    PI_RECIPE_CHECK_BIN: resolve("target/debug/recipe-check"),
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function recipe(agentYaml: string): string {
    const root = mkdtempSync(join(tmpdir(), "recipe-check-bridge-"));
    roots.push(root);
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "validator-bridge",
        version: "1.0.0",
        description: "Validator bridge fixture",
        pi: { agents: ["agents/*.yaml"] },
      })
    );
    writeFileSync(join(root, "agents", "agent.yaml"), agentYaml);
    return root;
  }

  it("keeps the native checker and TypeScript resolver aligned on shared fixtures", async () => {
    const fixtures = JSON.parse(
      readFileSync(
        resolve("test/fixtures/format-conformance.json"),
        "utf8"
      )
    ) as Array<{
      name: string;
      valid: boolean;
      files: Record<string, string>;
    }>;

    for (const fixture of fixtures) {
      const root = mkdtempSync(join(tmpdir(), "recipe-conformance-"));
      roots.push(root);
      for (const [path, content] of Object.entries(fixture.files)) {
        const absolute = join(root, path);
        mkdirSync(join(absolute, ".."), { recursive: true });
        writeFileSync(absolute, content);
      }

      const report = await checkRecipeAtLoad(root, env);
      expect(report.valid, `${fixture.name}: native checker`).toBe(
        fixture.valid
      );
      if (fixture.valid) {
        expect(
          () => resolveRecipe({ recipeDir: root }),
          `${fixture.name}: TypeScript resolver`
        ).not.toThrow();
      } else {
        expect(
          () => resolveRecipe({ recipeDir: root }),
          `${fixture.name}: TypeScript resolver`
        ).toThrow();
      }
    }
  });

  it("returns the same stable Rust diagnostics through Node", async () => {
    const root = recipe(
      [
        "name: [",
      ].join("\n")
    );

    const report = await checkRecipeAtLoad(root, env);

    expect(report.valid).toBe(false);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "agents/agent.yaml",
        }),
      ])
    );
  });

  it("accepts a valid local Recipe snapshot", async () => {
    const root = recipe(
      [
        "name: agent",
        "model:",
        "  name: anthropic/claude-haiku-4-5",
        "tools: []",
        "subagents: []",
        "system_instructions:",
        "  content: Test",
      ].join("\n")
    );
    mkdirSync(join(root, "node_modules", "invalid"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "invalid", "agent.yaml"),
      "name: ["
    );

    await expect(checkRecipeAtLoad(root, env)).resolves.toMatchObject({
      valid: true,
    });
    expect(resolveRecipe({ recipeDir: root }).selectAgent().name).toBe("agent");
  });

  it("retains explicitly declared resources in generated directories", async () => {
    const root = recipe(
      "name: agent\nmodel:\n  name: anthropic/claude-haiku-4-5\n"
    );
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(
      join(root, "dist", "index.js"),
      "export default () => {};\n"
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "validator-bridge",
        pi: {
          agents: ["agents/*.yaml"],
          extensions: ["dist/index.js"],
        },
      })
    );

    await expect(checkRecipeAtLoad(root, env)).resolves.toMatchObject({
      valid: true,
    });
    expect(
      resolveRecipe({ recipeDir: root }).resources.extensions
    ).toEqual([join(root, "dist", "index.js")]);
  });

  it("rejects a Recipe with no agents in both implementations", async () => {
    const root = recipe(
      "name: agent\nmodel:\n  name: anthropic/claude-haiku-4-5\n"
    );
    rmSync(join(root, "agents", "agent.yaml"));

    const report = await checkRecipeAtLoad(root, env);
    expect(report.valid).toBe(false);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "package.agents_missing" }),
      ])
    );
    expect(() => resolveRecipe({ recipeDir: root })).toThrow();
  });

  it("keeps the canonical package MCP shape aligned", async () => {
    const root = recipe(
      "name: agent\nmodel:\n  name: anthropic/claude-haiku-4-5\n"
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "validator-bridge",
        pi: {
          agents: ["agents/*.yaml"],
          mcp: { manifest: "mcp.json" },
        },
      })
    );

    await expect(checkRecipeAtLoad(root, env)).resolves.toMatchObject({
      valid: false,
    });
    expect(() => resolveRecipe({ recipeDir: root })).toThrow(
      "package.json#pi.mcp contains unknown field"
    );
  });

  it.each([
    [
      "missing explicit name",
      "model:\n  name: anthropic/claude-haiku-4-5\n",
    ],
    [
      "missing skill",
      "name: agent\nmodel:\n  name: anthropic/claude-haiku-4-5\nskills: [missing]\n",
    ],
    [
      "missing subagent",
      "name: agent\nmodel:\n  name: anthropic/claude-haiku-4-5\nsubagents: [missing]\n",
    ],
    [
      "legacy agent-level extensions",
      "name: agent\nmodel:\n  name: anthropic/claude-haiku-4-5\nextensions: [extensions/tools.ts]\n",
    ],
    [
      "non-portable agent name",
      "name: Agent One\nmodel:\n  name: anthropic/claude-haiku-4-5\n",
    ],
    [
      "agent name with surrounding whitespace",
      "name: ' agent '\nmodel:\n  name: anthropic/claude-haiku-4-5\n",
    ],
    [
      "blank system instructions",
      "name: agent\nmodel:\n  name: anthropic/claude-haiku-4-5\nsystem_instructions:\n  mode: replace\n  content: '   '\n",
    ],
    [
      "duplicate tools",
      "name: agent\nmodel:\n  name: anthropic/claude-haiku-4-5\ntools: [read, read]\n",
    ],
    [
      "reserved agent tool",
      "name: agent\nmodel:\n  name: anthropic/claude-haiku-4-5\ntools: [agent]\n",
    ],
  ])("keeps Rust and TypeScript rejection aligned for %s", async (_case, yaml) => {
    const root = recipe(yaml);

    await expect(checkRecipeAtLoad(root, env)).resolves.toMatchObject({
      valid: false,
    });
    expect(() => resolveRecipe({ recipeDir: root })).toThrow();
  });

  it("keeps filenames out of agent reference resolution", async () => {
    const root = recipe(
      "name: agent\nmodel:\n  name: anthropic/claude-haiku-4-5\nsubagents: [worker-file]\n"
    );
    writeFileSync(
      join(root, "agents", "worker-file.yaml"),
      "name: worker\nmodel:\n  name: anthropic/claude-haiku-4-5\n"
    );

    await expect(checkRecipeAtLoad(root, env)).resolves.toMatchObject({
      valid: false,
    });
    expect(() => resolveRecipe({ recipeDir: root })).toThrow(
      'references missing subagent "worker-file"'
    );
  });

  it("normalizes whitespace in exact agent and skill references", async () => {
    const root = recipe(
      "name: agent\nmodel:\n  name: anthropic/claude-haiku-4-5\nskills: [' public-name ']\nsubagents: [' worker ']\n"
    );
    writeFileSync(
      join(root, "agents", "worker.yaml"),
      "name: worker\nmodel:\n  name: anthropic/claude-haiku-4-5\n"
    );
    mkdirSync(join(root, "skills", "folder"), { recursive: true });
    writeFileSync(
      join(root, "skills", "folder", "SKILL.md"),
      "---\nname: public-name\ndescription: Test\n---\n"
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "validator-bridge",
        pi: {
          agents: ["agents/*.yaml"],
          skills: ["skills"],
        },
      })
    );

    await expect(checkRecipeAtLoad(root, env)).resolves.toMatchObject({
      valid: true,
    });
    expect(resolveRecipe({ recipeDir: root }).selectAgent().skillPaths).toEqual([
      join(root, "skills", "folder", "SKILL.md"),
    ]);
  });

  it("rejects ambiguous skill identities in both implementations", async () => {
    const root = recipe(
      "name: agent\nmodel:\n  name: anthropic/claude-haiku-4-5\nskills: [shared]\n"
    );
    for (const folder of ["one", "two"]) {
      mkdirSync(join(root, "skills", folder), { recursive: true });
      writeFileSync(
        join(root, "skills", folder, "SKILL.md"),
        "---\nname: shared\ndescription: Test\n---\n"
      );
    }
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "validator-bridge",
        pi: {
          agents: ["agents/*.yaml"],
          skills: ["skills"],
        },
      })
    );

    await expect(checkRecipeAtLoad(root, env)).resolves.toMatchObject({
      valid: false,
    });
    expect(() => resolveRecipe({ recipeDir: root })).toThrow(
      'skill "shared" resolves to multiple packaged SKILL.md files'
    );
  });

  it("includes symlinked Recipe resources without following cycles", async () => {
    const root = recipe(
      [
        "name: agent",
        "model:",
        "  name: anthropic/claude-haiku-4-5",
        "tools: []",
        "skills:",
        "  - linked-skill",
      ].join("\n")
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "validator-bridge",
        pi: {
          agents: ["agents/*.yaml"],
          skills: ["linked-skill"],
        },
      })
    );
    const skill = join(root, "skill-source");
    mkdirSync(skill);
    writeFileSync(join(skill, "SKILL.md"), "# Linked skill\n");
    symlinkSync(skill, join(root, "linked-skill"), "dir");
    symlinkSync(root, join(skill, "cycle"), "dir");

    const report = await checkRecipeAtLoad(root, env);
    expect(report, JSON.stringify(report.diagnostics, null, 2)).toMatchObject({
      valid: true,
    });
  });

  it("resolves declared skills by their frontmatter name", async () => {
    const root = recipe(
      [
        "name: agent",
        "model:",
        "  name: anthropic/claude-haiku-4-5",
        "skills: [public-name]",
      ].join("\n")
    );
    mkdirSync(join(root, "skills", "folder"), { recursive: true });
    writeFileSync(
      join(root, "skills", "folder", "SKILL.md"),
      "---\nname: public-name\ndescription: Test\n---\n"
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "validator-bridge",
        pi: {
          agents: ["agents/*.yaml"],
          skills: ["skills"],
        },
      })
    );

    await expect(checkRecipeAtLoad(root, env)).resolves.toMatchObject({
      valid: true,
    });
  });

  it("ignores dangling symlinks while validating the remaining Recipe", async () => {
    const root = recipe(
      [
        "name: agent",
        "model:",
        "  name: anthropic/claude-haiku-4-5",
        "tools: []",
      ].join("\n")
    );
    symlinkSync(join(root, "missing-target"), join(root, "stale-link"));

    await expect(checkRecipeAtLoad(root, env)).resolves.toMatchObject({
      valid: true,
    });
  });

  it("runs a validator whose npm package mode was normalized to 0644", async () => {
    const root = recipe(
      [
        "name: agent",
        "model:",
        "  name: anthropic/claude-haiku-4-5",
        "tools: []",
      ].join("\n")
    );
    const binDir = mkdtempSync(join(tmpdir(), "recipe-check-mode-"));
    roots.push(binDir);
    const validator = join(binDir, "recipe-check");
    copyFileSync(env.PI_RECIPE_CHECK_BIN, validator);
    chmodSync(validator, 0o644);

    await expect(
      checkRecipeAtLoad(root, { PI_RECIPE_CHECK_BIN: validator })
    ).resolves.toMatchObject({ valid: true });
  });
});
