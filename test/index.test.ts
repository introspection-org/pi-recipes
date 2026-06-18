import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLocalRecipeRunner,
  createRecipeRunner,
  launchContextFromPortableEnv,
  LocalRecipeProvider,
  LocalResourceProvider,
  readPiPackageManifest,
  validatePiPackageManifest,
  workspaceFromPortableEnv,
} from "../src/index.js";

describe("portable runner environment", () => {
  it("builds a neutral launch context from PI_* variables", () => {
    const ctx = launchContextFromPortableEnv({
      PI_TASK_ID: "task-1",
      PI_RUN_ID: "run-1",
      PI_CONVERSATION_ID: "conversation-1",
      PI_PROJECT_ID: "project-1",
      PI_PROFILE_NAME: "main",
      PI_AGENT_NAME: "agent",
      PI_WORKSPACE_DIR: "/tmp/pi-workspace",
      PI_TASK_METADATA_JSON: JSON.stringify({ last_response: "resp-1" }),
    });

    expect(ctx).toEqual(
      expect.objectContaining({
        taskId: "task-1",
        runId: "run-1",
        conversationId: "conversation-1",
        projectId: "project-1",
        profileName: "main",
        agentName: "agent",
        metadata: { last_response: "resp-1" },
      })
    );
    expect(ctx.workspace.outputsDir).toBe("/tmp/pi-workspace/outputs");
  });

  it("resolves local workspace overrides", () => {
    const workspace = workspaceFromPortableEnv({
      PI_WORKSPACE_DIR: "/tmp/work",
      PI_REPOS_DIR: "/tmp/repos",
      PI_UPLOADS_DIR: "/tmp/uploads",
      PI_OUTPUTS_DIR: "/tmp/outputs",
      PI_MEMORIES_DIR: "/tmp/memories",
    });

    expect(workspace).toEqual(
      expect.objectContaining({
        workspaceDir: "/tmp/work",
        reposDir: "/tmp/repos",
        uploadsDir: "/tmp/uploads",
        outputsDir: "/tmp/outputs",
        memoriesDir: "/tmp/memories",
      })
    );
  });
});

describe("recipe runner core", () => {
  it("starts through adapter providers in order", async () => {
    const calls: string[] = [];
    const context = launchContextFromPortableEnv({
      PI_TASK_ID: "task-1",
      PI_WORKSPACE_DIR: "/tmp/pi-workspace",
    });
    const recipe = {
      source: "local_path" as const,
      agentDir: "/tmp/recipe",
      packageName: "package",
      packageVersion: "1.0.0",
    };
    const resources = {
      recipe,
      repositories: [],
      files: [],
      memories: [],
      skills: [],
      secrets: [],
      tools: [],
      connectors: [],
      outputMounts: [],
    };

    const runner = createRecipeRunner({
      context,
      adapter: {
        recipes: {
          async materializeRecipe() {
            calls.push("recipe");
            return recipe;
          },
        },
        resources: {
          async resolveResources() {
            calls.push("resources");
            return resources;
          },
        },
        resourceSync: {
          async syncDown() {
            calls.push("syncDown");
          },
          async syncUp() {
            calls.push("syncUp");
          },
        },
        createSession() {
          calls.push("createSession");
          return {
            async start() {
              calls.push("sessionStart");
            },
            async prompt() {
              calls.push("sessionPrompt");
              return "ok";
            },
            async cancel() {
              calls.push("sessionCancel");
            },
            async shutdown() {
              calls.push("sessionShutdown");
            },
          };
        },
        telemetry: {
          init() {
            calls.push("telemetryInit");
          },
          shutdown() {
            calls.push("telemetryShutdown");
          },
        },
      },
    });

    await runner.start();
    await expect(runner.prompt("hello")).resolves.toBe("ok");
    await runner.shutdown();

    expect(runner.state).toEqual(
      expect.objectContaining({ recipe, resources, started: true })
    );
    expect(calls).toEqual([
      "telemetryInit",
      "recipe",
      "resources",
      "syncDown",
      "createSession",
      "sessionStart",
      "sessionPrompt",
      "syncUp",
      "sessionShutdown",
      "telemetryShutdown",
    ]);
  });
});

describe("local adapter", () => {
  it("materializes a local recipe and default local resources", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipe-runner-"));
    try {
      const recipeDir = join(root, "recipe");
      mkdirSync(recipeDir, { recursive: true });
      writeFileSync(
        join(recipeDir, "package.json"),
        JSON.stringify({ name: "local-recipe", version: "1.2.3" })
      );
      const context = launchContextFromPortableEnv({
        PI_TASK_ID: "task-1",
        PI_WORKSPACE_DIR: join(root, "workspace"),
      });

      const recipe = await new LocalRecipeProvider(recipeDir).materializeRecipe(
        context
      );
      const resources = await new LocalResourceProvider().resolveResources(
        context,
        recipe
      );

      expect(recipe).toEqual(
        expect.objectContaining({
          source: "local_path",
          agentDir: recipeDir,
          packageName: "local-recipe",
          packageVersion: "1.2.3",
        })
      );
      expect(resources.outputMounts).toEqual([
        expect.objectContaining({
          mountPath: join(root, "workspace", "outputs"),
          persistAs: "local",
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a callable local runner from PI_* env", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-local-runner-"));
    try {
      const recipeDir = join(root, "recipe");
      mkdirSync(recipeDir, { recursive: true });
      writeFileSync(
        join(recipeDir, "package.json"),
        JSON.stringify({ name: "local-recipe", version: "1.2.3" })
      );

      const runner = createLocalRecipeRunner({
        env: {
          PI_TASK_ID: "task-1",
          PI_RECIPE_DIR: recipeDir,
          PI_WORKSPACE_DIR: join(root, "workspace"),
        },
        adapter: { session: false },
      });

      const state = await runner.start();

      expect(state.recipe?.agentDir).toBe(recipeDir);
      expect(state.resources?.outputMounts[0]?.mountPath).toBe(
        join(root, "workspace", "outputs")
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("recipe package manifest", () => {
  it("reads pi package resources", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "portable",
          version: "0.1.0",
          pi: {
            agents: ["./agents/*.yaml"],
            profiles: ["profiles/*.yaml"],
            extensions: ["extensions/*.ts"],
            skills: ["skills/**/SKILL.md"],
          },
        })
      );

      const manifest = readPiPackageManifest(root);
      const report = validatePiPackageManifest(manifest);

      expect(manifest.resources.agents).toEqual(["agents/*.yaml"]);
      expect(manifest.resources.skills).toEqual(["skills/**/SKILL.md"]);
      expect(report).toEqual({ valid: true, findings: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports packages with no declared/default agents", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-package-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "portable", version: "0.1.0" })
      );

      const report = validatePiPackageManifest(readPiPackageManifest(root));

      expect(report.valid).toBe(true);
      expect(report.findings).toEqual([
        {
          severity: "warning",
          code: "package.no_agents",
          message: "Package declares no agents and has no agents directory",
          packageName: "portable",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("architecture boundary", () => {
  it("keeps the core package free of Introspection runtime dependencies", async () => {
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
