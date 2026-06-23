#!/usr/bin/env node
import { existsSync } from "node:fs";
import {
  addRecipe,
  defaultRecipeStoreDir,
  listRecipes,
  recipeDisplayName,
  removeRecipe,
  resolveRecipeDirectory,
} from "./recipe-store.js";
import {
  readRecipePackageManifest,
  validatePiPackageManifest,
} from "./recipe-package.js";

interface ParsedArgs {
  command: string;
  values: string[];
  storeDir?: string;
  force: boolean;
  json: boolean;
}

function usage(): string {
  return [
    "Usage: recipes <command> [args]",
    "",
    "Commands:",
    "  add <source>       Install or register a recipe source",
    "  list               List installed recipes",
    "  remove <name|id>   Remove an installed recipe record",
    "  path <name|source>  Print the resolved recipe directory",
    "  doctor <target>    Validate a recipe directory or installed recipe",
    "",
    "Options:",
    "  --store <dir>      Use a custom recipe store",
    "  --force            Re-clone an existing remote source",
    "  --json             Print machine-readable JSON",
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

  return { command: command || "help", values, storeDir, force, json };
}

function requireOne(args: ParsedArgs, label: string): string {
  const value = args.values[0];
  if (!value) throw new Error(`${args.command} requires ${label}`);
  return value;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const opts = { storeDir: args.storeDir, cwd: process.cwd(), env: process.env };

  if (args.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (args.command === "add") {
    const source = requireOne(args, "<source>");
    const recipe = await addRecipe(source, { ...opts, force: args.force });
    if (args.json) {
      printJson(recipe);
    } else {
      process.stdout.write(`Added ${recipeDisplayName(recipe)}\n${recipe.path}\n`);
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
    const manifest = readRecipePackageManifest(path);
    const report = validatePiPackageManifest(manifest);
    if (args.json) {
      printJson({ manifest, report });
    } else {
      process.stdout.write(`${manifest.name}@${manifest.version}\n`);
      for (const finding of report.findings) {
        process.stdout.write(`${finding.severity}: ${finding.code}: ${finding.message}\n`);
      }
      if (report.findings.length === 0) process.stdout.write("ok\n");
    }
    return report.valid ? 0 : 1;
  }

  throw new Error(`Unknown command: ${args.command}\n\n${usage()}`);
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
