import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRecipeAtLoad } from "../src/recipe-check.js";

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
          severity: "error",
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
      profile: "local",
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
