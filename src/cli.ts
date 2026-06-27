#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createRecipeScaffold,
  validateRecipeDirectory,
  type RecipeDevelopmentReport,
} from "./recipe-dev.js";
import {
  publishRecipe,
  type PublishedRecipe,
  type RecipePublishVisibility,
} from "./recipe-publish.js";
import {
  addRecipe,
  customizeRecipe,
  defaultRecipeStoreDir,
  listRecipes,
  recipeDisplayName,
  recipePreferredIdentifier,
  recipeScopedIdentifier,
  removeRecipe,
  resolveRecipeDirectory,
  type InstalledRecipe,
} from "./recipe-store.js";
import {
  readPiPackageManifest,
} from "./recipe-package.js";
import {
  materializeRecipeMcpLocalConfig,
  type RecipeMcpLocalConfigResult,
} from "./recipe-mcp-config.js";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "@introspection-ai/pi-recipes";
const DEFAULT_PI_EXTENSION_SOURCE = `npm:${PACKAGE_NAME}`;

interface ParsedArgs {
  command: string;
  values: string[];
  storeDir?: string;
  name?: string;
  setupSource?: string;
  github?: string;
  message?: string;
  visibility?: RecipePublishVisibility;
  local: boolean;
  noSetup: boolean;
  force: boolean;
  json: boolean;
}

function usage(commandName = "recipes"): string {
  return [
    `Usage: ${commandName} <command> [args]`,
    "",
    "Commands:",
    "  setup [source]     Install the Pi recipes extension into Pi",
    "  create <dir>       Create a starter recipe directory",
    "  install <source>   Install or register a recipe source",
    "  customize <recipe> Copy an installed recipe into an editable local copy",
    "  list               List installed recipes",
    "  remove <recipe>     Remove an installed recipe record",
    "  path <recipe|path>  Print the resolved recipe directory",
    "  doctor <target>    Validate a recipe directory or installed recipe",
    "  publish <target>   Publish a recipe to a GitHub repository",
    "",
    "Options:",
    "  --store <dir>      Use a custom recipe store",
    "  --name <name>      Recipe name for create",
    "  --setup-source <source>",
    "                     Pi extension source for auto-setup",
    "  --github <owner/repo>",
    "                     Create or update a GitHub recipe repository during publish",
    "  --message <text>   Commit message for publish",
    "  --visibility <public|private>",
    "                     Required with --github; controls GitHub repository visibility",
    "  --local            Install the Pi extension into project settings during setup",
    "  --no-setup         Skip automatic Pi extension setup",
    "  --force            Re-clone an existing remote source",
    "  --json             Print machine-readable JSON",
    "",
    "First-time setup:",
    `  npm install -g ${PACKAGE_NAME}`,
    `  ${commandName} install github:owner/repo`,
    "",
    "Create and try a recipe:",
    `  ${commandName} create ./my-recipe`,
    `  ${commandName} doctor ./my-recipe`,
    `  ${commandName} install ./my-recipe`,
    "  pi --recipe my-recipe",
    "",
    "Publish a recipe:",
    `  ${commandName} publish ./my-recipe --github owner/my-recipe --visibility private`,
    "",
    "Source examples:",
    "  ./local-recipe",
    "  git@github.com:owner/private-recipe.git",
    "  git+https://github.com/owner/recipe.git#v1.0.0",
    "  github:owner/repo/path/to/recipe#v1.0.0",
    "  owner/repo",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const values: string[] = [];
  let command = "";
  let storeDir: string | undefined;
  let name: string | undefined;
  let setupSource: string | undefined;
  let github: string | undefined;
  let message: string | undefined;
  let visibility: RecipePublishVisibility | undefined;
  let local = false;
  let noSetup = false;
  let force = false;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      command = "help";
    } else if (arg === "--store") {
      const value = argv[++index];
      if (!value) throw new Error("--store requires a directory");
      storeDir = value;
    } else if (arg === "--name") {
      const value = argv[++index];
      if (!value) throw new Error("--name requires a value");
      name = value;
    } else if (arg === "--setup-source") {
      const value = argv[++index];
      if (!value) throw new Error("--setup-source requires a value");
      setupSource = value;
    } else if (arg === "--github") {
      const value = argv[++index];
      if (!value) throw new Error("--github requires owner/repo");
      github = value;
    } else if (arg === "--message" || arg === "-m") {
      const value = argv[++index];
      if (!value) throw new Error("--message requires text");
      message = value;
    } else if (arg === "--visibility") {
      const value = argv[++index];
      if (value !== "public" && value !== "private") {
        throw new Error("--visibility requires public or private");
      }
      visibility = value;
    } else if (arg === "--local" || arg === "-l") {
      local = true;
    } else if (arg === "--no-setup") {
      noSetup = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--json") {
      json = true;
    } else if (!command) {
      command = arg;
    } else {
      values.push(arg);
    }
  }

  return {
    command: command || "help",
    values,
    storeDir,
    name,
    setupSource,
    github,
    message,
    visibility,
    local,
    noSetup,
    force,
    json,
  };
}

function requireOne(args: ParsedArgs, label: string): string {
  const value = args.values[0];
  if (!value) throw new Error(`${args.command} requires ${label}`);
  return value;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function packageRoot(): string {
  const filename = fileURLToPath(import.meta.url);
  return resolve(dirname(filename), "..");
}

async function normalizedPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function piExtensionInstalled(): Promise<boolean> {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("pi", ["list"], {
      env: process.env,
      maxBuffer: 1024 * 1024,
    }));
  } catch {
    return false;
  }

  if (stdout.includes(DEFAULT_PI_EXTENSION_SOURCE) || stdout.includes(PACKAGE_NAME)) {
    return true;
  }

  const root = await normalizedPath(packageRoot());
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("User packages:") || trimmed.startsWith("Project packages:")) {
      continue;
    }
    if ((await normalizedPath(trimmed)) === root) return true;
  }
  return false;
}

async function installPiExtension(
  source: string,
  opts: { local?: boolean; quiet?: boolean } = {}
): Promise<void> {
  const args = ["install", source, ...(opts.local ? ["--local"] : [])];
  try {
    if (opts.quiet) {
      await execFileAsync("pi", args, {
        env: process.env,
        maxBuffer: 1024 * 1024,
      });
    } else {
      await new Promise<void>((resolveInstall, rejectInstall) => {
        const child = spawn("pi", args, {
          env: process.env,
          stdio: "inherit",
        });
        child.on("error", rejectInstall);
        child.on("close", (code, signal) => {
          if (code === 0) {
            resolveInstall();
          } else if (signal) {
            rejectInstall(new Error(`pi ${args.join(" ")} terminated by signal ${signal}`));
          } else {
            rejectInstall(new Error(`pi ${args.join(" ")} exited with code ${code ?? "unknown"}`));
          }
        });
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      [
        `Failed to install the Pi recipes extension with: pi ${args.join(" ")}`,
        message,
        "",
        "Make sure `pi` is installed and available on PATH, then run:",
        `  recipes setup ${source}`,
      ].join("\n")
    );
  }
}

async function ensurePiExtension(args: ParsedArgs): Promise<void> {
  if (args.noSetup) return;
  if (await piExtensionInstalled()) return;
  const source = args.setupSource ?? DEFAULT_PI_EXTENSION_SOURCE;
  process.stderr.write(`Installing Pi recipes extension with: pi install ${source}\n`);
  await installPiExtension(source, { local: args.local, quiet: true });
}

function printDoctorReport(report: RecipeDevelopmentReport): void {
  process.stdout.write(`${report.manifest.name}@${report.manifest.version}\n`);
  for (const finding of report.findings) {
    process.stdout.write(`${finding.severity}: ${finding.code}: ${finding.message}\n`);
  }
  if (report.findings.length === 0) process.stdout.write("ok\n");

  const resourceEntries = Object.entries(report.resources);
  if (resourceEntries.length > 0) {
    process.stdout.write("\nResources:\n");
    for (const [key, paths] of resourceEntries) {
      process.stdout.write(`  ${key}: ${paths.length}\n`);
    }
  }
}

function printPublishedRecipe(result: PublishedRecipe): void {
  process.stdout.write(
    [
      `Published ${result.packageName}@${result.recipe.version}`,
      result.recipeDir,
      "",
      `GitHub: ${result.github}`,
      `Recipe name: ${result.shortName}`,
      ...(result.scopedName !== result.shortName ? [`Scoped name: ${result.scopedName}`] : []),
      `Repository: ${result.createdRepository ? "created" : "existing"}`,
      `Commit: ${result.committed ? "created" : "no changes"}`,
      "Push: ok",
      `Catalog: ${result.catalogued ? "submitted" : "skipped"}`,
      "",
      "Use:",
      `  pi --recipe ${result.shortName}`,
      ...(result.scopedName !== result.shortName ? [`  pi --recipe ${result.scopedName}`] : []),
      "",
    ].join("\n")
  );
}

function recipeInstallSource(recipe: InstalledRecipe): string {
  if (recipe.id.startsWith("github:")) return `GitHub ${recipe.id.slice("github:".length)}`;
  if (recipe.id.startsWith("local:")) return "local editable copy";
  if (recipe.id.startsWith("git:")) return `Git ${recipe.id.slice("git:".length)}`;
  if (recipe.source.startsWith("github:")) return `GitHub ${recipe.source.slice("github:".length)}`;
  return recipe.source;
}

function printRecipeMcpInstallNotes(result: RecipeMcpLocalConfigResult): void {
  process.stdout.write("\nMCP config:\n");
  process.stdout.write(`  ${result.created ? "created" : "using existing"}: ${result.path}\n`);
  if (result.envVars.length > 0) {
    process.stdout.write("  Set these environment variables before launching Pi:\n");
    for (const name of result.envVars) {
      process.stdout.write(`    ${name}\n`);
    }
  } else {
    process.stdout.write("  Fill in endpoint URLs and tokens before launching Pi.\n");
  }
}

function printRecipeList(recipes: InstalledRecipe[], storeDir: string): void {
  if (recipes.length === 0) {
    process.stdout.write(`No recipes installed in ${storeDir}\n`);
    return;
  }

  process.stdout.write(`Installed recipes (${recipes.length})\n`);
  process.stdout.write(`Store: ${storeDir}\n\n`);
  for (const [index, recipe] of recipes.entries()) {
    const identifier = recipePreferredIdentifier(recipe);
    const scopedIdentifier = recipeScopedIdentifier(recipe);
    process.stdout.write(`${identifier}\n`);
    if (scopedIdentifier !== identifier) {
      process.stdout.write(`  Scoped name: ${scopedIdentifier}\n`);
    }
    process.stdout.write(`  Version: ${recipe.version}\n`);
    process.stdout.write(`  Installed from: ${recipeInstallSource(recipe)}\n`);
    process.stdout.write(`  Local files: ${recipe.path}\n`);
    if (index < recipes.length - 1) process.stdout.write("\n");
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const opts = { storeDir: args.storeDir, cwd: process.cwd(), env: process.env };
  const commandName = "recipes";

  if (args.command === "help") {
    process.stdout.write(`${usage(commandName)}\n`);
    return 0;
  }

  if (args.command === "setup") {
    const source = args.values[0] ?? args.setupSource ?? DEFAULT_PI_EXTENSION_SOURCE;
    if (!args.force && await piExtensionInstalled()) {
      process.stdout.write("Pi recipes extension is already installed.\n");
      return 0;
    }
    await installPiExtension(source, { local: args.local });
    process.stdout.write(`Pi recipes extension installed from ${source}\n`);
    return 0;
  }

  if (args.command === "create") {
    const target = requireOne(args, "<dir>");
    const result = createRecipeScaffold(target, {
      cwd: opts.cwd,
      name: args.name,
      force: args.force,
    });
    if (args.json) {
      printJson(result);
    } else {
      process.stdout.write(`Created recipe ${result.name}\n${result.recipeDir}\n\n`);
      for (const file of result.files) {
        process.stdout.write(`${file.action}: ${file.path}\n`);
      }
      process.stdout.write(
        [
          "",
          "Next steps:",
          `  ${commandName} doctor ${result.recipeDir}`,
          `  ${commandName} install ${result.recipeDir}`,
          `  pi --recipe ${result.name}`,
          `  ${commandName} publish ${result.recipeDir}`,
          "",
        ].join("\n")
      );
    }
    return 0;
  }

  if (args.command === "install") {
    const source = requireOne(args, "<source>");
    await ensurePiExtension(args);
    const recipe = await addRecipe(source, { ...opts, force: args.force });
    const mcpLocalConfig = await materializeRecipeMcpLocalConfig(
      recipe.path,
      readPiPackageManifest(recipe.path)
    );
    if (args.json) {
      printJson({ ...recipe, ...(mcpLocalConfig ? { mcpLocalConfig } : {}) });
    } else {
      process.stdout.write(`Installed ${recipeDisplayName(recipe)}\n${recipe.path}\n`);
      if (mcpLocalConfig) printRecipeMcpInstallNotes(mcpLocalConfig);
      process.stdout.write(`\nRun:\n  pi --recipe ${recipePreferredIdentifier(recipe)}\n`);
    }
    return 0;
  }

  if (args.command === "customize") {
    const identifier = requireOne(args, "<recipe>");
    const result = await customizeRecipe(identifier, { ...opts, force: args.force });
    if (args.json) {
      printJson(result);
    } else {
      const identifier = recipePreferredIdentifier(result.recipe);
      const heading = result.overwritten
        ? `Updated editable copy for ${identifier}`
        : `Created editable copy for ${identifier}`;
      process.stdout.write(
        [
          heading,
          "",
          "Edit this folder:",
          `  ${result.path}`,
          "",
          "Then check and run it:",
          `  ${commandName} doctor ${identifier}`,
          `  pi --recipe ${identifier}`,
          "",
        ].join("\n")
      );
    }
    return 0;
  }

  if (args.command === "list") {
    const recipes = listRecipes(opts);
    if (args.json) {
      printJson(recipes);
    } else {
      printRecipeList(recipes, args.storeDir ?? defaultRecipeStoreDir(process.env));
    }
    return 0;
  }

  if (args.command === "remove") {
    const identifier = requireOne(args, "<recipe>");
    const recipe = removeRecipe(identifier, opts);
    if (!recipe) throw new Error(`Recipe not found: ${identifier}`);
    if (args.json) {
      printJson(recipe);
    } else {
      process.stdout.write(`Removed ${recipeDisplayName(recipe)}\n`);
    }
    return 0;
  }

  if (args.command === "path") {
    const identifier = requireOne(args, "<recipe|path>");
    const path = resolveRecipeDirectory(identifier, opts);
    if (!existsSync(path)) throw new Error(`Recipe not found: ${identifier}`);
    if (args.json) {
      printJson({ path });
    } else {
      process.stdout.write(`${path}\n`);
    }
    return 0;
  }

  if (args.command === "doctor") {
    const identifier = args.values[0] ?? ".";
    const path = resolveRecipeDirectory(identifier, opts);
    readPiPackageManifest(path);
    const report = validateRecipeDirectory(path);
    if (args.json) {
      printJson(report);
    } else {
      printDoctorReport(report);
    }
    return report.valid ? 0 : 1;
  }

  if (args.command === "publish") {
    const identifier = args.values[0] ?? ".";
    if (!args.github) {
      throw new Error("publish requires --github owner/repo");
    }
    if (!args.visibility) {
      throw new Error("publish requires --visibility public or --visibility private");
    }
    const result = await publishRecipe(identifier, {
      ...opts,
      github: args.github,
      message: args.message,
      visibility: args.visibility,
      force: args.force,
    });
    if (args.json) {
      printJson(result);
    } else {
      printPublishedRecipe(result);
    }
    return 0;
  }

  throw new Error(`Unknown command: ${args.command}\n\n${usage(commandName)}`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
);
