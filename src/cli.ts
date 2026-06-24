#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createRecipePublishGuide,
  createRecipeScaffold,
  validateRecipeDirectory,
  type RecipeDevelopmentReport,
  type RecipePublishGuide,
} from "./recipe-dev.js";
import {
  addRecipe,
  defaultRecipeStoreDir,
  listRecipes,
  recipeDisplayName,
  removeRecipe,
  resolveRecipeDirectory,
} from "./recipe-store.js";
import {
  readPiPackageManifest,
} from "./recipe-package.js";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "@tfidfwastaken/local-session-tools";
const DEFAULT_PI_EXTENSION_SOURCE = `npm:${PACKAGE_NAME}`;

interface ParsedArgs {
  command: string;
  values: string[];
  storeDir?: string;
  name?: string;
  setupSource?: string;
  local: boolean;
  noSetup: boolean;
  force: boolean;
  json: boolean;
}

function usage(commandName = "pi-recipes"): string {
  return [
    `Usage: ${commandName} <command> [args]`,
    "",
    "Commands:",
    "  setup [source]     Install the Pi recipes extension into Pi",
    "  init <dir>         Create a starter recipe directory",
    "  install <source>   Install or register a recipe source",
    "  add <source>       Alias for install",
    "  list               List installed recipes",
    "  remove <name|id>   Remove an installed recipe record",
    "  path <name|source>  Print the resolved recipe directory",
    "  doctor <target>    Validate a recipe directory or installed recipe",
    "  publish <target>   Validate and print publishing instructions",
    "",
    "Options:",
    "  --store <dir>      Use a custom recipe store",
    "  --name <name>      Recipe name for init",
    "  --setup-source <source>",
    "                     Pi extension source for auto-setup",
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
    `  ${commandName} init ./my-recipe`,
    `  ${commandName} doctor ./my-recipe`,
    `  ${commandName} install ./my-recipe`,
    "  pi --recipe my-recipe",
    "",
    "Publish a recipe:",
    `  ${commandName} publish ./my-recipe`,
    "  git add ./my-recipe && git commit -m \"add my recipe\"",
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
        `  pi-recipes setup ${source}`,
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

function printPublishGuide(guide: RecipePublishGuide): void {
  process.stdout.write(`${guide.manifest.name}@${guide.manifest.version}\n`);
  for (const finding of guide.report.findings) {
    process.stdout.write(`${finding.severity}: ${finding.code}: ${finding.message}\n`);
  }
  if (!guide.report.valid) {
    process.stdout.write("\nFix doctor errors before publishing.\n");
    return;
  }
  if (guide.report.findings.length === 0) process.stdout.write("doctor: ok\n");

  process.stdout.write("\nPublish checklist:\n");
  for (const item of guide.checklist) {
    process.stdout.write(`  - ${item}\n`);
  }

  process.stdout.write("\nShare one of these install commands:\n");
  for (const source of guide.sourceExamples) {
    process.stdout.write(`  ${source}\n`);
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const opts = { storeDir: args.storeDir, cwd: process.cwd(), env: process.env };
  const commandName = "pi-recipes";

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

  if (args.command === "init" || args.command === "new" || args.command === "create") {
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

  if (args.command === "install" || args.command === "add") {
    const source = requireOne(args, "<source>");
    await ensurePiExtension(args);
    const recipe = await addRecipe(source, { ...opts, force: args.force });
    if (args.json) {
      printJson(recipe);
    } else {
      process.stdout.write(`Installed ${recipeDisplayName(recipe)}\n${recipe.path}\n`);
    }
    return 0;
  }

  if (args.command === "list" || args.command === "ls") {
    const recipes = listRecipes(opts);
    if (args.json) {
      printJson(recipes);
    } else if (recipes.length === 0) {
      process.stdout.write(`No recipes installed in ${args.storeDir ?? defaultRecipeStoreDir()}\n`);
    } else {
      for (const recipe of recipes) {
        process.stdout.write(`${recipeDisplayName(recipe)}  ${recipe.id}\n`);
      }
    }
    return 0;
  }

  if (args.command === "remove" || args.command === "rm") {
    const identifier = requireOne(args, "<name|id>");
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
    const identifier = requireOne(args, "<name|source>");
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
    const path = resolveRecipeDirectory(identifier, opts);
    if (!existsSync(path)) throw new Error(`Recipe not found: ${identifier}`);
    const guide = createRecipePublishGuide(path);
    if (args.json) {
      printJson(guide);
    } else {
      printPublishGuide(guide);
    }
    return guide.report.valid ? 0 : 1;
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
