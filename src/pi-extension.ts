import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { launchContextFromPortableEnv } from "./env.js";
import { createLocalRecipeRunner } from "./local.js";
import { loadRecipeAgentDefinitions, loadRecipeProfile } from "./recipe-agent.js";
import { readPiPackageManifest } from "./recipe-package.js";

export interface RunRecipeRequest {
  recipeDir: string;
  prompt: string;
  workspaceDir: string;
}

export interface RunRecipeResult {
  output: string;
  workspaceDir: string;
}

export interface PiRecipesExtensionOptions {
  libraryDir?: string;
  env?: NodeJS.ProcessEnv;
  runRecipe?: (request: RunRecipeRequest) => Promise<RunRecipeResult>;
}

const DEFAULT_PROMPT = "Run this recipe.";

function defaultLibraryDir(env: NodeJS.ProcessEnv): string {
  return resolve(env.PI_RECIPES_LIBRARY_DIR || join(homedir(), ".pi", "recipes"));
}

function parseArgs(args: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(args)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "recipe";
}

function ensureLibrary(libraryDir: string): void {
  mkdirSync(libraryDir, { recursive: true });
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  type: "info" | "warning" | "error" = "info"
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
    return;
  }
  console.log(message);
}

function resolveRecipeRef(libraryDir: string, ref: string): string {
  const direct = resolve(ref);
  if (existsSync(direct)) return direct;
  return join(libraryDir, slug(ref));
}

function recipeSummary(recipeDir: string): string {
  const manifest = readPiPackageManifest(recipeDir);
  const agents = [...loadRecipeAgentDefinitions(recipeDir).values()];
  const uniqueAgents = [...new Map(agents.map((agent) => [agent.name, agent])).values()];
  return [
    `Recipe: ${manifest.name}@${manifest.version}`,
    `Path: ${recipeDir}`,
    `Agents: ${uniqueAgents.map((agent) => agent.name).join(", ") || "none"}`,
  ].join("\n");
}

function writeStarterRecipe(recipeDir: string, name: string): void {
  mkdirSync(join(recipeDir, "agents"), { recursive: true });
  writeFileSync(
    join(recipeDir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
          profiles: ["profiles/*.yaml"],
          skills: ["skills/**/SKILL.md"],
          prompts: ["SYSTEM.md"],
        },
      },
      null,
      2
    ) + "\n"
  );
  writeFileSync(
    join(recipeDir, "SYSTEM.md"),
    `You are the ${name} recipe agent. Follow the user's task carefully.\n`
  );
  writeFileSync(
    join(recipeDir, "agents", "agent.yaml"),
    [
      "name: agent",
      `description: Default agent for ${name}`,
      "model:",
      "  name: openai/gpt-5.5",
      "  thinking_level: low",
      "tools: []",
      "skills: []",
      "subagents: []",
      "",
    ].join("\n")
  );
}

async function defaultRunRecipe(
  request: RunRecipeRequest,
  env: NodeJS.ProcessEnv
): Promise<RunRecipeResult> {
  const runner = createLocalRecipeRunner({
    recipeDir: request.recipeDir,
    env,
    context: launchContextFromPortableEnv({
      ...env,
      PI_TASK_ID: `local-${Date.now()}`,
      PI_RECIPE_DIR: request.recipeDir,
      PI_WORKSPACE_DIR: request.workspaceDir,
    }),
  });
  try {
    await runner.start();
    const result = await runner.prompt(request.prompt);
    return {
      output: typeof result === "string" ? result : JSON.stringify(result, null, 2),
      workspaceDir: request.workspaceDir,
    };
  } finally {
    await runner.shutdown();
  }
}

function helpText(): string {
  return [
    "Usage: /recipe <command>",
    "Commands:",
    "  new <name>",
    "  import <path> [name]",
    "  list",
    "  inspect <name-or-path> [profile]",
    "  run <name-or-path> [prompt]",
    "  export <name-or-path>",
  ].join("\n");
}

export function createPiRecipesExtension(
  opts: PiRecipesExtensionOptions = {}
): ExtensionFactory {
  const env = opts.env ?? process.env;
  const libraryDir = opts.libraryDir ?? defaultLibraryDir(env);
  const runRecipe = opts.runRecipe ?? ((request) => defaultRunRecipe(request, env));

  return (pi: ExtensionAPI) => {
    pi.registerCommand("recipe", {
      description: "Create, import, inspect, and run local Pi recipes.",
      getArgumentCompletions(argumentPrefix: string) {
        const [command, refPrefix = ""] = parseArgs(argumentPrefix);
        if (!command || !argumentPrefix.trim().includes(" ")) {
          return ["new", "import", "list", "inspect", "run", "export"]
            .filter((item) => item.startsWith(command ?? ""))
            .map((label) => ({ label, value: label }));
        }
        if (["inspect", "run", "export"].includes(command)) {
          ensureLibrary(libraryDir);
          return readdirSync(libraryDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith(refPrefix))
            .map((entry) => ({ label: entry.name, value: entry.name }));
        }
        return null;
      },
      async handler(args: string, ctx: ExtensionCommandContext) {
        const [command, ...rest] = parseArgs(args);
        try {
          switch (command) {
            case "new": {
              const name = slug(rest[0] ?? "");
              if (!name) throw new Error("Recipe name is required");
              ensureLibrary(libraryDir);
              const recipeDir = join(libraryDir, name);
              if (existsSync(recipeDir)) {
                throw new Error(`Recipe already exists: ${name}`);
              }
              writeStarterRecipe(recipeDir, name);
              notify(ctx, `Created recipe ${name} at ${recipeDir}`);
              return;
            }
            case "import": {
              const source = rest[0];
              if (!source) throw new Error("Import path is required");
              const sourceDir = resolve(source);
              if (!existsSync(sourceDir)) throw new Error(`Recipe path does not exist: ${sourceDir}`);
              readPiPackageManifest(sourceDir);
              ensureLibrary(libraryDir);
              const name = slug(rest[1] ?? basename(sourceDir));
              const targetDir = join(libraryDir, name);
              if (existsSync(targetDir)) throw new Error(`Recipe already exists: ${name}`);
              cpSync(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: true });
              notify(ctx, `Imported recipe ${name} from ${sourceDir}`);
              return;
            }
            case "list": {
              ensureLibrary(libraryDir);
              const lines = readdirSync(libraryDir, { withFileTypes: true })
                .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
                .map((entry) => {
                  const recipeDir = join(libraryDir, entry.name);
                  try {
                    const manifest = readPiPackageManifest(recipeDir);
                    return `${entry.name} - ${manifest.name}@${manifest.version}`;
                  } catch {
                    return `${entry.name} - invalid recipe`;
                  }
                });
              notify(ctx, lines.length > 0 ? lines.join("\n") : `No recipes in ${libraryDir}`);
              return;
            }
            case "inspect": {
              const ref = rest[0];
              if (!ref) throw new Error("Recipe name or path is required");
              const recipeDir = resolveRecipeRef(libraryDir, ref);
              const profile = rest[1] ? loadRecipeProfile(recipeDir, rest[1]) : null;
              const profileLine = profile ? `\nProfile: ${profile.name} -> ${profile.entrypoint}` : "";
              notify(ctx, recipeSummary(recipeDir) + profileLine);
              return;
            }
            case "run": {
              const ref = rest[0];
              if (!ref) throw new Error("Recipe name or path is required");
              const recipeDir = resolveRecipeRef(libraryDir, ref);
              readPiPackageManifest(recipeDir);
              const prompt = rest.slice(1).join(" ").trim() || DEFAULT_PROMPT;
              const workspaceDir = join(libraryDir, ".runs", `${Date.now()}-${slug(basename(recipeDir))}`);
              const result = await runRecipe({ recipeDir, prompt, workspaceDir });
              notify(ctx, `Recipe run completed in ${result.workspaceDir}\n${result.output}`);
              return;
            }
            case "export": {
              const ref = rest[0];
              if (!ref) throw new Error("Recipe name or path is required");
              const recipeDir = resolveRecipeRef(libraryDir, ref);
              readPiPackageManifest(recipeDir);
              notify(ctx, `Recipe directory: ${recipeDir}`);
              return;
            }
            default:
              notify(ctx, helpText());
          }
        } catch (err) {
          notify(ctx, err instanceof Error ? err.message : String(err), "error");
        }
      },
    });
  };
}

export default createPiRecipesExtension();
