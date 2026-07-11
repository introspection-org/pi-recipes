import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createRecipeChildAgentRunner } from "../src/child-agent.js";
import {
  addRecipe,
  buildRecipeEvalInvocations,
  createRecipePublishGuide,
  createRecipeScaffold,
  customizeRecipe,
  defaultRecipeStoreDir,
  listRecipes,
  loadRecipeAgentDefinitions,
  packageResourcePaths,
  parseRecipeSource,
  publishRecipe,
  readPiPackageManifest,
  recipePreferredIdentifier,
  recipeStoreFilePath,
  RecipePackageError,
  REQUIRED_RECIPE_AGENT_FIELDS,
  type RecipePublishCommandRunner,
  removeRecipe,
  resolveRecipeAgentDefinition,
  resolveRecipeDirectory,
  validateRecipeAgentDefinitions,
  validateResolvedRecipeAgentDefinition,
  validateRecipeDirectory,
  validatePiPackageManifest,
  validateRecipeEvalsConfig,
} from "../src/index.js";
import { isDirectCli, main as recipesCliMain } from "../src/cli.js";
import { materializeRecipeMcpLocalConfig } from "../src/recipe-mcp-config.js";

const execFileAsync = promisify(execFile);
const PI_RECIPES_VERSION = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")
).version as string;

function fullAgentYaml(name = "agent"): string {
  return [
    `name: ${name}`,
    "model:",
    "  name: test/provider-model",
    "  thinking_level: low",
    "tools: []",
    "skills: []",
    "subagents: []",
    "system_instructions:",
    "  mode: append",
    "  content: Test instructions",
    "",
  ].join("\n");
}

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
          mcp: {
            manifest: "mcp.json",
            servers: [
              {
                id: "partner-mcp",
                required: true,
                tools: {
                  include: ["*"],
                  exclude: ["delete_value"],
                },
              },
            ],
          },
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
      });
      expect(manifest.mcp).toEqual({
        manifests: ["mcp.json"],
        servers: [
          {
            id: "partner-mcp",
            required: true,
            tools: {
              include: ["*"],
              exclude: ["delete_value"],
            },
          },
        ],
      });
      expect(report).toEqual({ valid: true, findings: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on an invalid package MCP policy", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-mcp-include-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writePiPackageManifest(root, {
        name: "missing-package-mcp-include",
        version: "0.1.0",
        pi: {
          mcp: {
            servers: [{ id: "salesforce", tools: {} }],
          },
        },
      });

      expect(validatePiPackageManifest(readPiPackageManifest(root))).toMatchObject({
        valid: false,
        findings: [
          expect.objectContaining({
            code: "pi.mcp_invalid",
            severity: "error",
          }),
        ],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collapses package MCP policy failures into one runtime error", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-mcp-selector-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writePiPackageManifest(root, {
        name: "invalid-package-mcp-selector",
        version: "0.1.0",
        pi: {
          mcp: {
            servers: [
              {
                id: "salesforce",
                tools: { include: ["search_*"], exclude: ["*"] },
              },
            ],
          },
        },
      });

      expect(validatePiPackageManifest(readPiPackageManifest(root))).toMatchObject({
        valid: false,
        findings: [
          expect.objectContaining({
            code: "pi.mcp_invalid",
            severity: "error",
          }),
        ],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes MCP ids and rejects duplicate normalized ids", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-mcp-id-"));
    try {
      writePiPackageManifest(root, {
        name: "normalized-package-mcp-ids",
        version: "0.1.0",
        pi: {
          mcp: {
            servers: [
              { id: "Git Hub", tools: { include: ["*"] } },
            ],
          },
        },
      });
      expect(readPiPackageManifest(root).mcp.servers[0]?.id).toBe("git-hub");

      writePiPackageManifest(root, {
        name: "duplicate-package-mcp-ids",
        version: "0.1.0",
        pi: {
          mcp: {
            servers: [
              { id: "Git Hub", tools: { include: ["*"] } },
              { id: "git-hub", tools: { include: ["*"] } },
            ],
          },
        },
      });
      expect(() => readPiPackageManifest(root)).toThrow(
        'Duplicate MCP server id after normalization: "git-hub"'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unusable MCP ids and unsupported tools.allow", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-mcp-invalid-"));
    try {
      writePiPackageManifest(root, {
        name: "invalid-package-mcp-id",
        version: "0.1.0",
        pi: {
          mcp: {
            servers: [{ id: "!!!", tools: { include: ["*"] } }],
          },
        },
      });
      expect(() => readPiPackageManifest(root)).toThrow(
        "must contain a letter, number, underscore, or dash"
      );

      writePiPackageManifest(root, {
        name: "invalid-package-mcp-tools",
        version: "0.1.0",
        pi: {
          mcp: {
            servers: [
              {
                id: "github",
                tools: { allow: ["*"] },
              },
            ],
          },
        },
      });
      expect(() => readPiPackageManifest(root)).toThrow(
        "tools contains unsupported field: allow"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads Harbor eval suite pins from package.json pi blocks", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-evals-"));
    try {
      writePiPackageManifest(root, {
        name: "evals-recipe",
        version: "0.1.0",
        pi: {
          evals: {
            suites: [
              {
                name: "smoke",
                type: "registry",
                dataset: "acme/smoke",
                version: "1.2.3",
              },
              {
                name: "terminal-bench",
                type: "registry",
                dataset: "terminal-bench/terminal-bench-2-1",
                version: "6",
              },
              {
                name: "coding",
                type: "git",
                repo: "https://github.com/acme/coding-evals.git",
                rev: "abcdef1234567890",
                dataset: "smoke",
              },
            ],
          },
        },
      });

      const manifest = readPiPackageManifest(root);

      expect(manifest.evals.suites).toEqual([
        {
          name: "smoke",
          type: "registry",
          dataset: "acme/smoke",
          version: "1.2.3",
        },
        {
          name: "terminal-bench",
          type: "registry",
          dataset: "terminal-bench/terminal-bench-2-1",
          version: "6",
        },
        {
          name: "coding",
          type: "git",
          repo: "https://github.com/acme/coding-evals.git",
          rev: "abcdef1234567890",
          dataset: "smoke",
        },
      ]);
      expect(validateRecipeEvalsConfig(manifest.evals)).toEqual({
        valid: true,
        findings: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports mutable Harbor eval pins and duplicate suite names", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-bad-evals-"));
    try {
      writePiPackageManifest(root, {
        name: "bad-evals-recipe",
        version: "0.1.0",
        pi: {
          evals: {
            suites: [
              {
                name: "smoke",
                type: "registry",
                dataset: "acme/smoke",
                version: "^1.0",
              },
              {
                name: "latest",
                type: "registry",
                dataset: "terminal-bench/terminal-bench-2-1",
                version: "latest",
              },
              {
                name: "smoke",
                type: "git",
                repo: "https://github.com/acme/coding-evals.git",
                rev: "main",
              },
            ],
          },
        },
      });

      const report = validatePiPackageManifest(readPiPackageManifest(root));

      expect(report.valid).toBe(false);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "evals.pin_mutable" }),
          expect.objectContaining({ code: "evals.name_duplicate" }),
        ])
      );
      expect(report.findings.filter((finding) => finding.code === "evals.pin_mutable"))
        .toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports present malformed Harbor eval blocks", () => {
    for (const evals of [false, null]) {
      const root = mkdtempSync(join(tmpdir(), "pi-package-malformed-evals-"));
      try {
        writePiPackageManifest(root, {
          name: "malformed-evals-recipe",
          version: "0.1.0",
          pi: { evals },
        });

        const report = validatePiPackageManifest(readPiPackageManifest(root));

        expect(report.valid).toBe(false);
        expect(report.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "evals.suite_invalid" }),
          ])
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("copies an MCP local config example for installed recipes", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-mcp-install-"));
    try {
      mkdirSync(join(root, ".pi"), { recursive: true });
      writePiPackageManifest(root, {
        name: "mcp-recipe",
        version: "0.1.0",
        pi: {
          mcp: {
            servers: [
              {
                id: "partner",
                tools: { include: ["search"] },
              },
            ],
          },
        },
      });
      writeFileSync(
        join(root, ".pi", "mcp.local.example.json"),
        [
          "{",
          '  "servers": [',
          '    { "id": "partner", "url": "${PARTNER_URL}", "headers": { "Authorization": "Bearer ${PARTNER_TOKEN}" } }',
          "  ]",
          "}",
          "",
        ].join("\n")
      );

      const result = await materializeRecipeMcpLocalConfig(
        root,
        readPiPackageManifest(root)
      );

      expect(result).toEqual({
        path: join(root, ".pi", "mcp.local.json"),
        created: true,
        source: "example",
        envVars: ["PARTNER_TOKEN", "PARTNER_URL"],
      });
      expect(readFileSync(join(root, ".pi", "mcp.local.json"), "utf8")).toContain(
        "${PARTNER_TOKEN}"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("generates an MCP local config template from recipe server policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-mcp-install-"));
    try {
      writePiPackageManifest(root, {
        name: "mcp-recipe",
        version: "0.1.0",
        pi: {
          mcp: {
            servers: [
              {
                id: "partner-mcp",
                tools: { include: ["search"] },
              },
            ],
          },
        },
      });

      const result = await materializeRecipeMcpLocalConfig(
        root,
        readPiPackageManifest(root)
      );

      expect(result).toMatchObject({
        path: join(root, ".pi", "mcp.local.json"),
        created: true,
        source: "generated",
        envVars: ["PARTNER_MCP_TOKEN", "PARTNER_MCP_URL"],
      });
      expect(JSON.parse(readFileSync(join(root, ".pi", "mcp.local.json"), "utf8"))).toEqual({
        servers: [
          {
            id: "partner-mcp",
            transport: "streamable_http",
            url: "${PARTNER_MCP_URL}",
            headers: {
              Authorization: "Bearer ${PARTNER_MCP_TOKEN}",
            },
          },
        ],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing MCP local config", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-mcp-install-"));
    try {
      mkdirSync(join(root, ".pi"), { recursive: true });
      writePiPackageManifest(root, {
        name: "mcp-recipe",
        version: "0.1.0",
        pi: {
          mcp: {
            servers: [
              {
                id: "partner",
                tools: { include: ["search"] },
              },
            ],
          },
        },
      });
      writeFileSync(join(root, ".pi", "mcp.local.json"), "custom ${CUSTOM_TOKEN}\n");
      writeFileSync(join(root, ".pi", "mcp.local.example.json"), "example ${EXAMPLE_TOKEN}\n");

      const result = await materializeRecipeMcpLocalConfig(
        root,
        readPiPackageManifest(root)
      );

      expect(result).toEqual({
        path: join(root, ".pi", "mcp.local.json"),
        created: false,
        source: "existing",
        envVars: ["CUSTOM_TOKEN"],
      });
      expect(readFileSync(join(root, ".pi", "mcp.local.json"), "utf8")).toBe(
        "custom ${CUSTOM_TOKEN}\n"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports package.json pi manifests without package names", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-name-"));
    try {
      writePiPackageManifest(root, {
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });

      const manifest = readPiPackageManifest(root);
      const report = validatePiPackageManifest(manifest);

      expect(manifest.name).toBe("");
      expect(report).toEqual({
        valid: false,
        findings: [
          {
            severity: "error",
            code: "package.name_missing",
            message: "Package is missing name",
          },
        ],
      });
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
        },
      });

      const manifest = readPiPackageManifest(root);

      expect(packageResourcePaths(manifest, "skills")).toEqual([
        join(root, "skills", "repo-index", "SKILL.md"),
      ]);
      expect(packageResourcePaths(manifest, "extensions")).toEqual([
        join(root, "extensions", "tools.ts"),
      ]);
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

  it("reports invalid Harbor eval suite pins during recipe development validation", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-dev-evals-validation-"));
    try {
      writePiPackageManifest(root, {
        name: "broken-evals-recipe",
        version: "0.1.0",
        pi: {
          evals: {
            suites: [
              {
                name: "smoke",
                type: "registry",
                dataset: "acme/smoke",
                version: "^1.0",
              },
            ],
          },
        },
      });

      const report = validateRecipeDirectory(root);

      expect(report.valid).toBe(false);
      expect(report.resources.evals).toEqual(["smoke"]);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            code: "evals.pin_mutable",
          }),
        ])
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds Harbor eval dry-run commands for registry and git suites", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-evals-commands-"));
    try {
      writePiPackageManifest(root, {
        name: "evals-recipe",
        version: "0.1.0",
        pi: {
          evals: {
            suites: [
              {
                name: "registry-smoke",
                type: "registry",
                dataset: "acme/smoke",
                version: "1.2.3",
              },
              {
                name: "git-smoke",
                type: "git",
                repo: "https://github.com/acme/coding-evals.git",
                rev: "abcdef1",
                dataset: "smoke",
              },
            ],
          },
        },
      });

      const runtime = join(root, "runtime");
      mkdirSync(runtime);
      const invocations = buildRecipeEvalInvocations(readPiPackageManifest(root), {
        recipeSource: root,
        runtimeSource: runtime,
        adapterDir: "/tmp/pi-recipes-harbor",
        env: {},
        harborArgs: ["--task", "acme/one", "--install-only"],
      });

      expect(invocations[0]?.command).toEqual([
        "harbor",
        "run",
        "-d",
        "acme/smoke@1.2.3",
        "--agent",
        "pi_recipe_agent:PiRecipeAgent",
        "--mounts",
        JSON.stringify([
          {
            type: "bind",
            source: root,
            target: "/pi-recipe-source",
            read_only: true,
          },
          {
            type: "bind",
            source: runtime,
            target: "/pi-recipe-runtime",
            read_only: true,
          },
        ]),
        "--task",
        "acme/one",
        "--install-only",
      ]);
      expect(invocations[1]?.command).toEqual([
        "harbor",
        "run",
        "--registry-path",
        "<checkout:https://github.com/acme/coding-evals.git@abcdef1>",
        "-d",
        "smoke",
        "--agent",
        "pi_recipe_agent:PiRecipeAgent",
        "--mounts",
        JSON.stringify([
          {
            type: "bind",
            source: root,
            target: "/pi-recipe-source",
            read_only: true,
          },
          {
            type: "bind",
            source: runtime,
            target: "/pi-recipe-runtime",
            read_only: true,
          },
        ]),
        "--task",
        "acme/one",
        "--install-only",
      ]);
      expect(invocations[1]?.gitRegistry).toEqual({
        repo: "https://github.com/acme/coding-evals.git",
        rev: "abcdef1",
        placeholderPath: "<checkout:https://github.com/acme/coding-evals.git@abcdef1>",
      });
      for (const invocation of invocations) {
        expect(invocation.command).not.toContain("-m");
      }
      expect(invocations[0]?.env).toMatchObject({
        PI_RECIPE_SOURCE: "/pi-recipe-source",
        PI_RECIPE_NAME: "evals-recipe",
        PI_RECIPE_RUNTIME: "/pi-recipe-runtime",
        PYTHONPATH: "/tmp/pi-recipes-harbor",
      });
      expect(invocations.map((invocation) => invocation.cwd)).toEqual([root, root]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds Harbor eval dry-run commands for local dataset dev mode", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-evals-dev-"));
    try {
      const dataset = join(root, "dataset");
      mkdirSync(dataset, { recursive: true });
      writePiPackageManifest(root, {
        name: "evals-dev-recipe",
        version: "0.1.0",
        pi: {
          agents: [],
        },
      });

      const invocations = buildRecipeEvalInvocations(readPiPackageManifest(root), {
        datasetPath: dataset,
        recipeSource: root,
        adapterDir: "/tmp/pi-recipes-harbor",
        env: {},
      });

      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.mode).toBe("dataset-path");
      expect(invocations[0]?.command).toEqual([
        "harbor",
        "run",
        "-p",
        dataset,
        "--agent",
        "pi_recipe_agent:PiRecipeAgent",
        "--mounts",
        JSON.stringify([
          {
            type: "bind",
            source: root,
            target: "/pi-recipe-source",
            read_only: true,
          },
        ]),
      ]);
      expect(invocations[0]?.cwd).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints Harbor eval dry-run commands from the recipes CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-evals-cli-"));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let stdout = "";
    write.mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
    try {
      writePiPackageManifest(root, {
        name: "evals-cli-recipe",
        version: "0.1.0",
        pi: {
          evals: {
            suites: [
              {
                name: "smoke",
                type: "registry",
                dataset: "acme/smoke",
                version: "1.0.0",
              },
            ],
          },
        },
      });

      await expect(
        recipesCliMain([
          "evals",
          "run",
          root,
          "--suite",
          "smoke",
          "--dry-run",
          "--",
          "--task",
          "acme/one",
        ])
      ).resolves.toBe(0);

      expect(stdout).toContain("Harbor eval dry run for evals-cli-recipe");
      expect(stdout).toContain(
        "harbor run -d acme/smoke@1.0.0 --agent pi_recipe_agent:PiRecipeAgent"
      );
      expect(stdout).toContain("--task acme/one");
      expect(stdout).toContain("/pi-recipe-source");
    } finally {
      write.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints Harbor eval suite records from the recipes CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-evals-list-"));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let stdout = "";
    write.mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
    try {
      writePiPackageManifest(root, {
        name: "evals-list-recipe",
        version: "0.1.0",
        pi: {
          evals: {
            suites: [
              {
                name: "smoke",
                type: "git",
                repo: "https://github.com/acme/coding-evals.git",
                rev: "abcdef1",
                dataset: "smoke",
              },
              {
                name: "terminal",
                type: "registry",
                dataset: "terminal-bench/terminal-bench-2-1",
                version: "6",
              },
            ],
          },
        },
      });

      await expect(recipesCliMain(["evals", "list", root])).resolves.toBe(0);

      expect(stdout).toContain("Harbor eval suites for evals-list-recipe");
      expect(stdout).toContain("\nsmoke\n");
      expect(stdout).toContain("  type: git\n");
      expect(stdout).toContain("  repo: https://github.com/acme/coding-evals.git\n");
      expect(stdout).toContain("\nterminal\n");
      expect(stdout).toContain("  type: registry\n");
      expect(stdout).toContain("recipes evals clone");
    } finally {
      write.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clones git-backed Harbor eval suites from the recipes CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-evals-clone-"));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let stdout = "";
    write.mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
    try {
      const evalRepo = join(root, "eval-source");
      mkdirSync(evalRepo, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: evalRepo });
      writeFileSync(join(evalRepo, "registry.json"), "[]\n");
      await execFileAsync("git", ["add", "registry.json"], { cwd: evalRepo });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=Test User",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "add registry",
        ],
        { cwd: evalRepo }
      );
      const { stdout: rev } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: evalRepo,
      });

      writePiPackageManifest(root, {
        name: "evals-clone-recipe",
        version: "0.1.0",
        pi: {
          evals: {
            suites: [
              {
                name: "smoke",
                type: "git",
                repo: evalRepo,
                rev: rev.trim(),
                dataset: "smoke",
              },
              {
                name: "smoke-again",
                type: "git",
                repo: evalRepo,
                rev: rev.trim(),
                dataset: "smoke",
              },
            ],
          },
        },
      });

      const destination = join(root, "dev-evals");
      await expect(recipesCliMain(["evals", "clone", root, destination])).resolves.toBe(0);

      const checkout = join(destination, "eval-source");
      expect(existsSync(join(checkout, "registry.json"))).toBe(true);
      await expect(readdir(destination)).resolves.toEqual(["eval-source"]);
      expect(stdout).toContain("Cloned Harbor eval sources for evals-clone-recipe");
      expect(stdout).toContain(`  repo: ${evalRepo}\n`);
      expect(stdout).toContain("  suites: smoke, smoke-again\n");
    } finally {
      write.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects Harbor passthrough args for non-evals commands", async () => {
    await expect(
      recipesCliMain(["doctor", ".", "--", "--task", "acme/one"])
    ).rejects.toThrow(/only supported by recipes evals/);
  });

  it("passes check profiles through to recipe-check", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-cli-check-profile-"));
    const previousBin = process.env.PI_RECIPE_CHECK_BIN;
    const previousArgsPath = process.env.RECIPE_CHECK_ARGS_PATH;
    try {
      const checker = join(root, "recipe-check-bin.mjs");
      const argsPath = join(root, "args.json");
      writeFileSync(
        checker,
        [
          "#!/usr/bin/env node",
          "import { writeFileSync } from 'node:fs';",
          "writeFileSync(process.env.RECIPE_CHECK_ARGS_PATH, JSON.stringify(process.argv.slice(2)));",
          "process.exit(0);",
          "",
        ].join("\n")
      );
      chmodSync(checker, 0o755);
      process.env.PI_RECIPE_CHECK_BIN = checker;
      process.env.RECIPE_CHECK_ARGS_PATH = argsPath;

      await expect(
        recipesCliMain(["check", root, "--profile", "ci", "--json"])
      ).resolves.toBe(0);

      expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual([
        root,
        "--profile",
        "ci",
        "--json",
      ]);
    } finally {
      if (previousBin === undefined) {
        delete process.env.PI_RECIPE_CHECK_BIN;
      } else {
        process.env.PI_RECIPE_CHECK_BIN = previousBin;
      }
      if (previousArgsPath === undefined) {
        delete process.env.RECIPE_CHECK_ARGS_PATH;
      } else {
        process.env.RECIPE_CHECK_ARGS_PATH = previousArgsPath;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown check profiles", async () => {
    await expect(
      recipesCliMain(["check", ".", "--profile", "staging"])
    ).rejects.toThrow(/--profile requires local, ci, or publish/);
  });

  it("does not treat imported CLI modules as direct invocations", () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-cli-imported-"));
    try {
      const entry = join(root, "runner.js");
      const module = join(root, "dist", "cli.js");
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(entry, "");
      writeFileSync(module, "");
      expect(isDirectCli(entry, pathToFileURL(module).href)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects model overrides for Harbor recipe evals", async () => {
    await expect(
      recipesCliMain(["evals", "run", ".", "--model", "openai/gpt-5.4-mini", "--dry-run"])
    ).rejects.toThrow(/--model is not supported/);
  });

  it("detects direct CLI execution through package bin symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-cli-symlink-"));
    try {
      const target = join(root, "cli.js");
      const link = join(root, "recipes");
      writeFileSync(target, "");
      symlinkSync(target, link);

      expect(isDirectCli(link, pathToFileURL(target).href)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports agents missing required launch fields during recipe validation", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-agent-validation-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writePiPackageManifest(root, {
        name: "strict-agents",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(
        join(root, "agents", "agent.yaml"),
        [
          "name: agent",
          "model:",
          "  name: test/provider-model",
          "  thinking_level: low",
          "tools: []",
          "system_instructions:",
          "  mode: append",
          "  content: Main instructions",
          "",
        ].join("\n")
      );

      const report = validateRecipeDirectory(root);

      expect(report.valid).toBe(false);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            code: "agent.skills_missing",
            message: 'Recipe agent "agent" must declare skills directly or inherit it with from',
          }),
          expect.objectContaining({
            severity: "error",
            code: "agent.subagents_missing",
            message: 'Recipe agent "agent" must declare subagents directly or inherit it with from',
          }),
        ])
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts explicitly blank agent system instructions", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-agent-blank-instructions-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writePiPackageManifest(root, {
        name: "blank-instructions",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(
        join(root, "agents", "agent.yaml"),
        [
          "name: agent",
          "model:",
          "  name: test/provider-model",
          "  thinking_level: low",
          "tools: []",
          "skills: []",
          "subagents: []",
          "system_instructions:",
          "  mode: append",
          '  content: ""',
          "",
        ].join("\n")
      );

      const report = validateRecipeDirectory(root);
      const agent = resolveRecipeAgentDefinition({ recipeDir: root }).agent;

      expect(report.valid).toBe(true);
      expect(agent?.systemInstructions).toEqual({
        mode: "append",
        content: "",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports agents with missing inherited bases during recipe validation", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-agent-from-validation-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writePiPackageManifest(root, {
        name: "broken-inheritance",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(
        join(root, "agents", "agent.yaml"),
        [
          "name: agent",
          "from: missing-base",
          "model:",
          "  name: test/provider-model",
          "  thinking_level: low",
          "tools: []",
          "skills: []",
          "subagents: []",
          "system_instructions:",
          "  mode: append",
          "  content: Main instructions",
          "",
        ].join("\n")
      );

      const report = validateRecipeDirectory(root);

      expect(report.valid).toBe(false);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            code: "agent.from_missing",
            message: 'Recipe agent "agent" inherits from missing agent "missing-base"',
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
      expect(guide.checklist).toContain("Run `recipes check .` and fix any errors.");
      expect(guide.sourceExamples).toContain("recipes install github:owner/guide-recipe");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("recipe agent definitions", () => {
  it("keeps explicit agent names from being shadowed by filename aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-agent-alias-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writePiPackageManifest(root, {
        name: "alias-agents",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(join(root, "agents", "agent.yaml"), fullAgentYaml("main"));
      writeFileSync(join(root, "agents", "main.yaml"), fullAgentYaml("worker"));

      const definitions = loadRecipeAgentDefinitions(root);
      const resolved = resolveRecipeAgentDefinition({
        recipeDir: root,
        agentName: "main",
      });

      expect(definitions.get("main")?.name).toBe("main");
      expect(resolved.agent?.name).toBe("main");
      expect(validateRecipeAgentDefinitions(root)).toEqual(
        expect.arrayContaining([
          {
            agentName: "worker",
            field: "name",
            message: 'Recipe agent file alias "main" conflicts with an explicit agent name',
          },
        ])
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags model names that are not <provider>/<model_id>", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-agents-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writePiPackageManifest(root, {
        name: "model-spec-agents",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(
        join(root, "agents", "agent.yaml"),
        fullAgentYaml().replace("test/provider-model", "gpt-5.5")
      );

      expect(validateRecipeAgentDefinitions(root)).toEqual(
        expect.arrayContaining([
          {
            agentName: "agent",
            field: "model.name",
            message:
              'Recipe agent "agent" has invalid model.name "gpt-5.5" - expected "<provider>/<model_id>"',
          },
        ])
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts aggregator model ids containing slashes and rejects colon-form specs", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-agents-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writePiPackageManifest(root, {
        name: "model-spec-agents",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(
        join(root, "agents", "agent.yaml"),
        fullAgentYaml().replace(
          "test/provider-model",
          "openrouter/anthropic/claude-opus-4.8"
        )
      );
      writeFileSync(
        join(root, "agents", "fireworks.yaml"),
        fullAgentYaml("fireworks").replace(
          "test/provider-model",
          "fireworks/accounts/fireworks/models/kimi-k2p6"
        )
      );
      writeFileSync(
        join(root, "agents", "colon.yaml"),
        fullAgentYaml("colon").replace("test/provider-model", "openai:gpt-5.5")
      );

      const findings = validateRecipeAgentDefinitions(root);
      expect(findings).toEqual([
        {
          agentName: "colon",
          field: "model.name",
          message:
            'Recipe agent "colon" has invalid model.name "openai:gpt-5.5" - expected "<provider>/<model_id>"',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
          "mcp:",
          "  salesforce:",
          "    include:",
          "      - \"*\"",
          "    exclude:",
          "      - delete_org",
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
          "mcp:",
          "  salesforce:",
          "    exclude:",
          "      - delete_org",
          "      - purge_records",
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
          mcp: {
            salesforce: {
              include: ["*"],
              exclude: ["delete_org", "purge_records"],
            },
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

  it("leaves advisory MCP diagnostics to recipe-check", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-agent-mcp-tools-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writePiPackageManifest(root, {
        name: "child-agent-mcp-tools",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
          mcp: {
            servers: [
              {
                id: "contacts",
                tools: { include: ["search_contacts"] },
              },
            ],
          },
        },
      });
      writeFileSync(
        join(root, "agents", "base.yaml"),
        [
          "name: base",
          "model:",
          "  name: test/provider-model",
          "  thinking_level: low",
          "tools:",
          "  - bash",
          "mcp:",
          "  contacts:",
          "    include:",
          "      - search_contacts",
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
        [
          "name: worker",
          "from: base",
          "tools:",
          "  - read",
          "",
        ].join("\n")
      );

      expect(
        validateResolvedRecipeAgentDefinition({
          recipeDir: root,
          agentName: "base",
          requiredFields: REQUIRED_RECIPE_AGENT_FIELDS,
        })
      ).toEqual([]);
      expect(
        validateResolvedRecipeAgentDefinition({
          recipeDir: root,
          agentName: "worker",
          requiredFields: REQUIRED_RECIPE_AGENT_FIELDS,
        })
      ).toEqual([]);
      const report = validateRecipeDirectory(root);
      expect(report.valid).toBe(true);
      expect(
        report.findings.filter((finding) => finding.code.includes("mcp"))
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

  it("collapses agent MCP policy failures into one runtime error per agent", () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-agent-mcp-selector-"));
    try {
      mkdirSync(join(root, "agents"), { recursive: true });
      writePiPackageManifest(root, {
        name: "invalid-mcp-selector",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
          mcp: {
            servers: [
              {
                id: "salesforce",
                tools: { include: ["search_accounts"] },
              },
            ],
          },
        },
      });
      const writeAgent = (name: string, mcpLines: string[]) =>
        writeFileSync(
          join(root, "agents", `${name}.yaml`),
          [
            `name: ${name}`,
            "model:",
            "  name: test/provider-model",
            "  thinking_level: low",
            "tools:",
            "  - bash",
            ...mcpLines,
            "skills: []",
            "subagents: []",
            "system_instructions:",
            "  mode: append",
            "  content: Test instructions",
            "",
          ].join("\n")
        );
      writeAgent("missing-include", ["mcp:", "  salesforce: {}"]);
      writeAgent("empty-mcp", ["mcp: {}"]);
      writeAgent("undeclared-server", [
        "mcp:",
        "  nextplay:",
        "    include:",
        "      - \"*\"",
      ]);
      writeAgent("package-blocked-tool", [
        "mcp:",
        "  salesforce:",
        "    include:",
        "      - delete_org",
      ]);
      writeAgent("invalid-patterns", [
        "mcp:",
        "  salesforce:",
        "    include:",
        "      - search_*",
        "    exclude:",
        "      - \"*\"",
      ]);

      const findings = validateRecipeAgentDefinitions(root);
      expect(findings.map((finding) => finding.agentName).sort()).toEqual([
        "empty-mcp",
        "invalid-patterns",
        "missing-include",
        "package-blocked-tool",
        "undeclared-server",
      ]);
      expect(findings.every((finding) =>
        finding.field === "mcp" && finding.code === "mcp_invalid"
      )).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("recipe store", () => {
  it("defaults recipe storage to ~/.pi/recipes", () => {
    expect(defaultRecipeStoreDir({})).toBe(join(homedir(), ".pi", "recipes"));
    expect(defaultRecipeStoreDir({ PI_RECIPES_HOME: "/tmp/pi-recipes-home" })).toBe(
      "/tmp/pi-recipes-home"
    );
  });

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

  it("recovers from stale recipe store locks during mutations", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-store-lock-"));
    const storeDir = join(root, "store");
    const recipeDir = join(root, "recipe");
    try {
      mkdirSync(join(recipeDir, "agents"), { recursive: true });
      writePiPackageManifest(recipeDir, {
        name: "locked-review",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      const lockDir = `${recipeStoreFilePath(storeDir)}.lock`;
      mkdirSync(lockDir, { recursive: true });
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockDir, old, old);

      const installed = await addRecipe(recipeDir, { storeDir });

      expect(installed.name).toBe("locked-review");
      expect(listRecipes({ storeDir })).toEqual([installed]);
      expect(existsSync(lockDir)).toBe(false);
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

  it("publishes an installed git recipe by customizing it into a local editable repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-publish-"));
    const sourceDir = join(root, "source");
    const bareDir = join(root, "recipe.git");
    const storeDir = join(root, "store");
    const commands: string[] = [];
    try {
      mkdirSync(join(sourceDir, "agents"), { recursive: true });
      writePiPackageManifest(sourceDir, {
        name: "upstream-review",
        version: "0.1.0",
        description: "Publishable recipe",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(join(sourceDir, "agents", "agent.yaml"), fullAgentYaml());
      await execFileAsync("git", ["init"], { cwd: sourceDir });
      await execFileAsync("git", ["add", "."], { cwd: sourceDir });
      await execFileAsync(
        "git",
        ["-c", "user.name=Recipe Test", "-c", "user.email=recipe@example.com", "commit", "-m", "recipe"],
        { cwd: sourceDir }
      );
      await execFileAsync("git", ["clone", "--bare", sourceDir, bareDir]);
      await addRecipe(`file://${bareDir}`, { storeDir, env: { DO_NOT_TRACK: "1" } });

      const result = await publishRecipe("upstream-review", {
        storeDir,
        github: "acme/upstream-review",
        visibility: "public",
        env: { DO_NOT_TRACK: "1" },
        commandRunner: async (command, args) => {
          commands.push([command, ...args].join(" "));
          if (
            command === "git" &&
            args.join(" ") === "rev-parse --verify HEAD"
          ) {
            throw new Error("no commits");
          }
          if (
            command === "git" &&
            args.join(" ") === "diff --cached --quiet"
          ) {
            throw new Error("has changes");
          }
          if (
            command === "gh" &&
            args.slice(0, 3).join(" ") === "repo view acme/upstream-review"
          ) {
            throw new Error("not found");
          }
          if (
            command === "git" &&
            args.join(" ") === "remote get-url origin"
          ) {
            throw new Error("no origin");
          }
          return { stdout: "", stderr: "" };
        },
      });

      expect(result).toMatchObject({
        recipeDir: join(storeDir, "local", "upstream-review"),
        github: "acme/upstream-review",
        packageName: "@acme/upstream-review",
        shortName: "upstream-review",
        scopedName: "acme/upstream-review",
        createdRepository: true,
        committed: true,
        pushed: true,
      });
      expect(readPiPackageManifest(result.recipeDir).name).toBe("@acme/upstream-review");
      expect(readFileSync(join(result.recipeDir, ".gitignore"), "utf8")).toContain("node_modules/");
      expect(resolveRecipeDirectory("upstream-review", { storeDir })).toBe(result.recipeDir);
      expect(resolveRecipeDirectory("acme/upstream-review", { storeDir })).toBe(result.recipeDir);
      expect(commands).toEqual(
        expect.arrayContaining([
          "git init",
          "git branch -M main",
          "git add -A",
          "git commit -m Publish @acme/upstream-review",
          "gh repo create acme/upstream-review --public",
          "git remote add origin https://github.com/acme/upstream-review.git",
          "git push -u origin HEAD:main",
        ])
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not mutate recipes when publish validation fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-publish-invalid-"));
    const recipeDir = join(root, "recipe");
    const commands: string[] = [];
    try {
      mkdirSync(join(recipeDir, "agents"), { recursive: true });
      writePiPackageManifest(recipeDir, {
        name: "invalid-review",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(join(recipeDir, "agents", "agent.yaml"), "name: agent\ntools: []\n");

      await expect(
        publishRecipe(recipeDir, {
          github: "acme/invalid-review",
          visibility: "private",
          commandRunner: async (command, args) => {
            commands.push([command, ...args].join(" "));
            return { stdout: "", stderr: "" };
          },
        })
      ).rejects.toThrow(/is not ready to publish/);

      expect(readPiPackageManifest(recipeDir).name).toBe("invalid-review");
      expect(existsSync(join(recipeDir, ".gitignore"))).toBe(false);
      expect(commands).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the package manifest basename as the short recipe name and scope for precision", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-manifest-name-"));
    const storeDir = join(root, "store");
    const sourceDir = join(root, "source");
    try {
      mkdirSync(join(sourceDir, "agents"), { recursive: true });
      writePiPackageManifest(sourceDir, {
        name: "@introspection/pi-codex-recipe",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });

      const installed = await addRecipe(sourceDir, { storeDir });

      expect(recipePreferredIdentifier(installed)).toBe("pi-codex-recipe");
      expect(resolveRecipeDirectory("pi-codex-recipe", { storeDir })).toBe(sourceDir);
      expect(resolveRecipeDirectory("introspection/pi-codex-recipe", { storeDir })).toBe(sourceDir);
      expect(resolveRecipeDirectory("@introspection/pi-codex-recipe", { storeDir, cwd: root })).toBe(
        join(root, "@introspection/pi-codex-recipe")
      );

      const customized = await customizeRecipe("pi-codex-recipe", { storeDir });

      expect(customized.path).toBe(join(storeDir, "local", "introspection-pi-codex-recipe"));
      expect(resolveRecipeDirectory("pi-codex-recipe", { storeDir })).toBe(customized.path);
      expect(resolveRecipeDirectory("introspection/pi-codex-recipe", { storeDir })).toBe(customized.path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires scoped recipe names when short names are ambiguous", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-name-ambiguity-"));
    const storeDir = join(root, "store");
    const firstDir = join(root, "first");
    const secondDir = join(root, "second");
    try {
      for (const [dir, name] of [
        [firstDir, "@alpha/shared-review"],
        [secondDir, "@beta/shared-review"],
      ] as const) {
        mkdirSync(join(dir, "agents"), { recursive: true });
        writePiPackageManifest(dir, {
          name,
          version: "0.1.0",
          pi: {
            agents: ["agents/*.yaml"],
          },
        });
        await addRecipe(dir, { storeDir });
      }

      expect(resolveRecipeDirectory("alpha/shared-review", { storeDir })).toBe(firstDir);
      expect(resolveRecipeDirectory("beta/shared-review", { storeDir })).toBe(secondDir);
      expect(() => resolveRecipeDirectory("shared-review", { storeDir })).toThrow(
        /Recipe name "shared-review" is ambiguous/
      );
      expect(() => removeRecipe("shared-review", { storeDir })).toThrow(
        /Use one of these scoped recipe names/
      );
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
      expect(resolveRecipeDirectory(installed.id, { storeDir })).toBe(installed.path);
      expect(resolveRecipeDirectory(installed.source, { storeDir })).toBe(installed.path);
      expect(resolveRecipeDirectory("recipe", { storeDir, cwd: root })).toBe(join(root, "recipe"));
      expect(readPiPackageManifest(installed.path).resources.agents).toEqual(["agents/*.yaml"]);
      expect(removeRecipe("recipe", { storeDir })).toBeUndefined();
      expect(removeRecipe("git-review", { storeDir })).toEqual(installed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reuse fallback clones after a ref checkout failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-git-bad-ref-"));
    const sourceDir = join(root, "source");
    const bareDir = join(root, "recipe.git");
    const storeDir = join(root, "store");
    try {
      mkdirSync(join(sourceDir, "agents"), { recursive: true });
      writePiPackageManifest(sourceDir, {
        name: "bad-ref-review",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
        },
      });
      writeFileSync(join(sourceDir, "agents", "agent.yaml"), fullAgentYaml());
      await execFileAsync("git", ["init"], { cwd: sourceDir });
      await execFileAsync("git", ["add", "."], { cwd: sourceDir });
      await execFileAsync(
        "git",
        ["-c", "user.name=Recipe Test", "-c", "user.email=recipe@example.com", "commit", "-m", "recipe"],
        { cwd: sourceDir }
      );
      await execFileAsync("git", ["clone", "--bare", sourceDir, bareDir]);

      const source = `file://${bareDir}#missing-ref`;
      await expect(addRecipe(source, { storeDir })).rejects.toThrow(/missing-ref/);
      await expect(addRecipe(source, { storeDir })).rejects.toThrow(/missing-ref/);
      expect(listRecipes({ storeDir })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent installs of the same remote source", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-git-concurrent-"));
    const sourceDir = join(root, "source");
    const bareDir = join(root, "recipe.git");
    const storeDir = join(root, "store");
    try {
      mkdirSync(join(sourceDir, "agents"), { recursive: true });
      writePiPackageManifest(sourceDir, {
        name: "concurrent-review",
        version: "0.1.0",
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
      await execFileAsync("git", ["tag", "v0.1.0"], { cwd: sourceDir });
      await execFileAsync("git", ["clone", "--bare", sourceDir, bareDir]);

      const [first, second] = await Promise.all([
        addRecipe(`file://${bareDir}#v0.1.0`, { storeDir }),
        addRecipe(`file://${bareDir}#v0.1.0`, { storeDir }),
      ]);

      expect(first.path).toBe(second.path);
      expect(listRecipes({ storeDir })).toHaveLength(1);
      expect(readPiPackageManifest(first.path).name).toBe("concurrent-review");
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

  it("installs extension runtime dependencies for cloned recipes", { timeout: 60_000 }, async () => {
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
  it("publishes all runtime modules imported by public entrypoints", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")
    ) as { bin?: Record<string, string>; files?: string[] };

    expect(pkg.files).toEqual(
      expect.arrayContaining([
        "dist/recipe-publish.d.ts",
        "dist/recipe-publish.js",
        "dist/recipe-mcp-config.d.ts",
        "dist/recipe-mcp-config.js",
        "dist/recipe-check.d.ts",
        "dist/recipe-check.js",
        "vendor/recipe-check",
        "harbor/pi_recipe_agent.py",
      ])
    );
    expect(pkg.files).not.toEqual(
      expect.arrayContaining([
        "Cargo.toml",
        "Cargo.lock",
        "crates/pi-recipe-check/Cargo.toml",
        "crates/pi-recipe-check/src",
        "harbor",
      ])
    );
    expect(pkg.bin).toEqual({ recipes: "dist/cli.js" });
  });

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

describe("install telemetry", () => {
  type Ping = { url: string; body: unknown };

  function recordingFetch(pings: Ping[], impl?: () => Promise<Response>) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      pings.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return impl ? impl() : new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
  }

  async function buildBareRecipe(root: string, name: string): Promise<string> {
    const sourceDir = join(root, "source");
    const bareDir = join(root, `${name}.git`);
    mkdirSync(join(sourceDir, "agents"), { recursive: true });
    writePiPackageManifest(sourceDir, {
      name,
      version: "1.2.3",
      description: "Telemetry recipe",
      pi: { agents: ["agents/*.yaml"] },
    });
    writeFileSync(join(sourceDir, "agents", "agent.yaml"), fullAgentYaml());
    await execFileAsync("git", ["init"], { cwd: sourceDir });
    await execFileAsync("git", ["add", "."], { cwd: sourceDir });
    await execFileAsync(
      "git",
      ["-c", "user.name=Recipe Test", "-c", "user.email=recipe@example.com", "commit", "-m", "recipe"],
      { cwd: sourceDir }
    );
    await execFileAsync("git", ["clone", "--bare", sourceDir, bareDir]);
    return bareDir;
  }

  it("sends one anonymous ping with the canonical id for a remote install", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-telemetry-"));
    const storeDir = join(root, "store");
    const pings: Ping[] = [];
    try {
      const bareDir = await buildBareRecipe(root, "telemetry-recipe");
      const installed = await addRecipe(`file://${bareDir}`, {
        storeDir,
        env: { PI_RECIPES_TELEMETRY_ENDPOINT: "https://example.test/api/installs" },
        fetchImpl: recordingFetch(pings),
      });
      expect(pings).toHaveLength(1);
      expect(pings[0].url).toBe("https://example.test/api/installs");
      expect(pings[0].body).toEqual({
        event: "install",
        id: installed.id,
        name: "telemetry-recipe",
        version: "1.2.3",
        piRecipesVersion: PI_RECIPES_VERSION,
      });
      expect(installed.id).toBe(`git:file://${bareDir}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not ping again when a remote recipe is already installed", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-telemetry-repeat-"));
    const storeDir = join(root, "store");
    const pings: Ping[] = [];
    try {
      const bareDir = await buildBareRecipe(root, "repeat-telemetry-recipe");
      await addRecipe(`file://${bareDir}`, {
        storeDir,
        fetchImpl: recordingFetch(pings),
      });
      await addRecipe(`file://${bareDir}`, {
        storeDir,
        fetchImpl: recordingFetch(pings),
      });
      expect(pings).toHaveLength(1);
      expect(pings[0].body).toMatchObject({
        event: "install",
        name: "repeat-telemetry-recipe",
        version: "1.2.3",
        piRecipesVersion: PI_RECIPES_VERSION,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not ping for local recipe registration", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-telemetry-local-"));
    const storeDir = join(root, "store");
    const recipeDir = join(root, "recipe");
    const pings: Ping[] = [];
    try {
      mkdirSync(join(recipeDir, "agents"), { recursive: true });
      writePiPackageManifest(recipeDir, {
        name: "local-only",
        version: "0.1.0",
        pi: { agents: ["agents/*.yaml"] },
      });
      writeFileSync(join(recipeDir, "agents", "agent.yaml"), fullAgentYaml());
      await addRecipe(recipeDir, { storeDir, fetchImpl: recordingFetch(pings) });
      expect(pings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is suppressed by DO_NOT_TRACK", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-telemetry-optout-"));
    const storeDir = join(root, "store");
    const pings: Ping[] = [];
    try {
      const bareDir = await buildBareRecipe(root, "opt-out-recipe");
      await addRecipe(`file://${bareDir}`, {
        storeDir,
        env: { DO_NOT_TRACK: "1" },
        fetchImpl: recordingFetch(pings),
      });
      expect(pings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never throws when the telemetry request fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-telemetry-error-"));
    const storeDir = join(root, "store");
    const pings: Ping[] = [];
    try {
      const bareDir = await buildBareRecipe(root, "resilient-recipe");
      const failing = recordingFetch(pings, () => Promise.reject(new Error("network down")));
      const installed = await addRecipe(`file://${bareDir}`, { storeDir, fetchImpl: failing });
      expect(installed.name).toBe("resilient-recipe");
      expect(pings).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("publish telemetry", () => {
  type Ping = { url: string; body: unknown };

  function recordingFetch(pings: Ping[], impl?: () => Promise<Response>) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      pings.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return impl ? impl() : new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
  }

  function createPublishableRecipe(root: string, name: string): string {
    const recipeDir = join(root, "recipe");
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    mkdirSync(join(recipeDir, "skills", "helper"), { recursive: true });
    writePiPackageManifest(recipeDir, {
      name,
      version: "2.3.4",
      description: "Catalogued recipe",
      pi: {
        agents: ["agents/*.yaml"],
        skills: ["skills/**/SKILL.md"],
      },
    });
    writeFileSync(join(recipeDir, "agents", "agent.yaml"), fullAgentYaml());
    writeFileSync(join(recipeDir, "skills", "helper", "SKILL.md"), "# Helper\n");
    return recipeDir;
  }

  function publishingCommandRunner(
    opts: { headSha?: string; tagsAtHead?: string[]; remoteTagsAtHead?: string[] } = {}
  ): RecipePublishCommandRunner {
    return async (command, args) => {
      if (
        command === "git" &&
        args.join(" ") === "rev-parse --verify HEAD"
      ) {
        throw new Error("no commits");
      }
      if (
        command === "git" &&
        args.join(" ") === "diff --cached --quiet"
      ) {
        throw new Error("has changes");
      }
      if (
        command === "gh" &&
        args.slice(0, 2).join(" ") === "repo view"
      ) {
        throw new Error("not found");
      }
      if (
        command === "git" &&
        args.join(" ") === "remote get-url origin"
      ) {
        throw new Error("no origin");
      }
      if (
        command === "git" &&
        args.join(" ") === "tag --points-at HEAD --sort=version:refname"
      ) {
        return { stdout: `${(opts.tagsAtHead ?? []).join("\n")}\n`, stderr: "" };
      }
      if (
        command === "git" &&
        args.join(" ") === "rev-parse HEAD"
      ) {
        return {
          stdout: `${opts.headSha ?? "0123456789abcdef0123456789abcdef01234567"}\n`,
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args[0] === "ls-remote" &&
        args[1] === "--tags" &&
        args[2] === "origin"
      ) {
        const headSha = opts.headSha ?? "0123456789abcdef0123456789abcdef01234567";
        const remoteTags = new Set(opts.remoteTagsAtHead ?? []);
        const lines = args
          .slice(3)
          .map((ref) => ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, ""))
          .filter((tag, index, tags) => tags.indexOf(tag) === index && remoteTags.has(tag))
          .map((tag) => `${headSha}\trefs/tags/${tag}`);
        return { stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
  }

  it("submits public publishes to the recipe catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-publish-catalog-"));
    const storeDir = join(root, "store");
    const pings: Ping[] = [];
    try {
      const recipeDir = createPublishableRecipe(root, "catalog-review");

      const result = await publishRecipe(recipeDir, {
        storeDir,
        github: "acme/catalog-review",
        visibility: "public",
        env: { PI_RECIPES_CATALOG_ENDPOINT: "https://example.test/api/catalog/recipes" },
        fetchImpl: recordingFetch(pings),
        commandRunner: publishingCommandRunner(),
      });

      expect(result.catalogued).toBe(true);
      expect(pings).toHaveLength(1);
      expect(pings[0].url).toBe("https://example.test/api/catalog/recipes");
      expect(pings[0].body).toEqual({
        event: "publish",
        piRecipesVersion: PI_RECIPES_VERSION,
        name: "@acme/catalog-review",
        version: "0123456789abcdef0123456789abcdef01234567",
        description: "Catalogued recipe",
        source: "github:acme/catalog-review",
        resources: {
          agents: 1,
          extensions: 0,
          skills: 1,
          prompts: 0,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a safe tag at the published commit as the catalog install ref", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-publish-catalog-tag-"));
    const storeDir = join(root, "store");
    const pings: Ping[] = [];
    try {
      const recipeDir = createPublishableRecipe(root, "tagged-catalog-review");

      await publishRecipe(recipeDir, {
        storeDir,
        github: "acme/tagged-catalog-review",
        visibility: "public",
        fetchImpl: recordingFetch(pings),
        commandRunner: publishingCommandRunner({
          tagsAtHead: ["release/latest", "v2.3.4"],
          remoteTagsAtHead: ["v2.3.4"],
          headSha: "fedcba9876543210fedcba9876543210fedcba98",
        }),
      });

      expect(pings).toHaveLength(1);
      expect(pings[0].body).toMatchObject({
        event: "publish",
        version: "v2.3.4",
        source: "github:acme/tagged-catalog-review",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the commit SHA when a local tag has not been pushed", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-publish-catalog-unpushed-tag-"));
    const storeDir = join(root, "store");
    const pings: Ping[] = [];
    try {
      const recipeDir = createPublishableRecipe(root, "unpushed-tag-catalog-review");

      await publishRecipe(recipeDir, {
        storeDir,
        github: "acme/unpushed-tag-catalog-review",
        visibility: "public",
        fetchImpl: recordingFetch(pings),
        commandRunner: publishingCommandRunner({
          tagsAtHead: ["v2.3.4"],
          remoteTagsAtHead: [],
          headSha: "1234567890abcdef1234567890abcdef12345678",
        }),
      });

      expect(pings).toHaveLength(1);
      expect(pings[0].body).toMatchObject({
        event: "publish",
        version: "1234567890abcdef1234567890abcdef12345678",
        source: "github:acme/unpushed-tag-catalog-review",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the commit SHA when tags at the published commit are unsafe", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-publish-catalog-unsafe-tag-"));
    const storeDir = join(root, "store");
    const pings: Ping[] = [];
    try {
      const recipeDir = createPublishableRecipe(root, "unsafe-tag-catalog-review");

      await publishRecipe(recipeDir, {
        storeDir,
        github: "acme/unsafe-tag-catalog-review",
        visibility: "public",
        fetchImpl: recordingFetch(pings),
        commandRunner: publishingCommandRunner({
          tagsAtHead: ["bad tag"],
          headSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        }),
      });

      expect(pings).toHaveLength(1);
      expect(pings[0].body).toMatchObject({
        event: "publish",
        version: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        source: "github:acme/unsafe-tag-catalog-review",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not catalogue private publishes", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-publish-private-catalog-"));
    const storeDir = join(root, "store");
    const pings: Ping[] = [];
    try {
      const recipeDir = createPublishableRecipe(root, "private-review");

      const result = await publishRecipe(recipeDir, {
        storeDir,
        github: "acme/private-review",
        visibility: "private",
        fetchImpl: recordingFetch(pings),
        commandRunner: publishingCommandRunner(),
      });

      expect(result.catalogued).toBe(false);
      expect(pings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors telemetry opt-out for public publish catalog submissions", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-publish-catalog-optout-"));
    const storeDir = join(root, "store");
    const pings: Ping[] = [];
    try {
      const recipeDir = createPublishableRecipe(root, "optout-review");

      const result = await publishRecipe(recipeDir, {
        storeDir,
        github: "acme/optout-review",
        visibility: "public",
        env: { DO_NOT_TRACK: "1" },
        fetchImpl: recordingFetch(pings),
        commandRunner: publishingCommandRunner(),
      });

      expect(result.catalogued).toBe(false);
      expect(pings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never throws when catalog submission fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipe-publish-catalog-error-"));
    const storeDir = join(root, "store");
    const pings: Ping[] = [];
    try {
      const recipeDir = createPublishableRecipe(root, "resilient-catalog-review");
      const failing = recordingFetch(pings, () => Promise.reject(new Error("network down")));

      const result = await publishRecipe(recipeDir, {
        storeDir,
        github: "acme/resilient-catalog-review",
        visibility: "public",
        fetchImpl: failing,
        commandRunner: publishingCommandRunner(),
      });

      expect(result.catalogued).toBe(true);
      expect(pings).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
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
