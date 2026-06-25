import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { validateRecipeDirectory } from "./recipe-dev.js";
import { readPiPackageManifest } from "./recipe-package.js";
import {
  addRecipe,
  customizeRecipe,
  defaultRecipeStoreDir,
  findInstalledRecipe,
  recipePreferredIdentifier,
  recipeScopedIdentifier,
  type InstalledRecipe,
  type RecipeStoreOptions,
} from "./recipe-store.js";

const execFileAsync = promisify(execFile);

export type RecipePublishVisibility = "public" | "private";

export interface RecipePublishCommandResult {
  stdout: string;
  stderr: string;
}

export type RecipePublishCommandRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv }
) => Promise<RecipePublishCommandResult>;

export interface RecipePublishOptions extends RecipeStoreOptions {
  github: string;
  visibility: RecipePublishVisibility;
  message?: string;
  force?: boolean;
  commandRunner?: RecipePublishCommandRunner;
}

export interface PublishedRecipe {
  recipe: InstalledRecipe;
  recipeDir: string;
  github: string;
  packageName: string;
  shortName: string;
  scopedName: string;
  createdRepository: boolean;
  committed: boolean;
  pushed: boolean;
}

interface GithubTarget {
  owner: string;
  repo: string;
  fullName: string;
  packageName: string;
  gitUrl: string;
}

function isSafeGithubName(value: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

function parseGithubTarget(input: string): GithubTarget {
  const trimmed = input.trim().replace(/^github:/, "").replace(/^@/, "");
  const parts = trimmed.split("/").filter(Boolean);
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo || !isSafeGithubName(owner) || !isSafeGithubName(repo)) {
    throw new Error("--github must be in owner/repo form");
  }
  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    packageName: `@${owner}/${repo}`,
    gitUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

async function runCommand(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  runner?: RecipePublishCommandRunner
): Promise<RecipePublishCommandResult> {
  if (runner) return runner(command, args, opts);
  try {
    return await execFileAsync(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    if (err && typeof err === "object") {
      const maybe = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
      const detail = [maybe.stderr, maybe.stdout, maybe.message]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .join("\n")
        .trim();
      if (detail) throw new Error(detail);
    }
    throw err;
  }
}

async function commandSucceeds(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  runner?: RecipePublishCommandRunner
): Promise<boolean> {
  try {
    await runCommand(command, args, opts, runner);
    return true;
  } catch {
    return false;
  }
}

function readPackageJson(recipeDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(recipeDir, "package.json"), "utf8")) as Record<string, unknown>;
}

function writePackageName(recipeDir: string, packageName: string): boolean {
  const packagePath = join(recipeDir, "package.json");
  const pkg = readPackageJson(recipeDir);
  if (pkg.name === packageName) return false;
  pkg.name = packageName;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

function ensureGitignore(recipeDir: string): boolean {
  const gitignorePath = join(recipeDir, ".gitignore");
  const desired = ["node_modules/", "dist/", ".DS_Store", ".env", ".env.*"];
  const existing = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf8").split(/\r?\n/)
    : [];
  const existingSet = new Set(existing.map((line) => line.trim()).filter(Boolean));
  const missing = desired.filter((line) => !existingSet.has(line));
  if (missing.length === 0) return false;
  const prefix = existing.length > 0 && existing.some((line) => line.trim()) ? "\n" : "";
  writeFileSync(
    gitignorePath,
    `${existing.join("\n").replace(/\n*$/, "")}${prefix}${missing.join("\n")}\n`
  );
  return true;
}

function localPathForInput(input: string, cwd: string): string {
  const expanded = input === "~"
    ? process.env.HOME ?? input
    : input.startsWith("~/")
      ? join(process.env.HOME ?? "", input.slice(2))
      : input;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

async function editableRecipeDir(
  target: string,
  opts: RecipePublishOptions
): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  const storeDir = opts.storeDir ?? defaultRecipeStoreDir(opts.env);
  const installed = findInstalledRecipe(target, opts);
  if (!installed) {
    const path = localPathForInput(target, cwd);
    if (!existsSync(path)) throw new Error(`Recipe not found: ${target}`);
    return path;
  }

  if (installed.id.startsWith("local:")) return installed.path;
  const customized = await customizeRecipe(target, {
    storeDir,
    cwd,
    env: opts.env,
    force: opts.force,
  });
  return customized.path;
}

async function ensureGitRepository(
  recipeDir: string,
  env: NodeJS.ProcessEnv | undefined,
  runner?: RecipePublishCommandRunner
): Promise<void> {
  if (!existsSync(join(recipeDir, ".git"))) {
    await runCommand("git", ["init"], { cwd: recipeDir, env }, runner);
  }
  const hasHead = await commandSucceeds("git", ["rev-parse", "--verify", "HEAD"], { cwd: recipeDir, env }, runner);
  if (!hasHead) {
    await runCommand("git", ["branch", "-M", "main"], { cwd: recipeDir, env }, runner);
  }
}

async function commitRecipe(
  recipeDir: string,
  message: string,
  env: NodeJS.ProcessEnv | undefined,
  runner?: RecipePublishCommandRunner
): Promise<boolean> {
  await runCommand("git", ["add", "-A"], { cwd: recipeDir, env }, runner);
  const hasChanges = !(await commandSucceeds(
    "git",
    ["diff", "--cached", "--quiet"],
    { cwd: recipeDir, env },
    runner
  ));
  if (!hasChanges) return false;
  await runCommand("git", ["commit", "-m", message], { cwd: recipeDir, env }, runner);
  return true;
}

async function ensureGithubRepository(
  target: GithubTarget,
  visibility: RecipePublishVisibility,
  recipeDir: string,
  env: NodeJS.ProcessEnv | undefined,
  runner?: RecipePublishCommandRunner
): Promise<boolean> {
  const exists = await commandSucceeds(
    "gh",
    ["repo", "view", target.fullName, "--json", "nameWithOwner"],
    { cwd: recipeDir, env },
    runner
  );
  if (exists) return false;

  try {
    await runCommand(
      "gh",
      ["repo", "create", target.fullName, `--${visibility}`],
      { cwd: recipeDir, env },
      runner
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      [
        `Failed to create GitHub repository ${target.fullName}.`,
        message,
        "",
        "Make sure GitHub CLI is installed and authenticated:",
        "  gh auth login",
      ].join("\n")
    );
  }
}

async function setOrigin(
  target: GithubTarget,
  recipeDir: string,
  env: NodeJS.ProcessEnv | undefined,
  runner?: RecipePublishCommandRunner
): Promise<void> {
  const hasOrigin = await commandSucceeds("git", ["remote", "get-url", "origin"], { cwd: recipeDir, env }, runner);
  if (hasOrigin) {
    await runCommand("git", ["remote", "set-url", "origin", target.gitUrl], { cwd: recipeDir, env }, runner);
  } else {
    await runCommand("git", ["remote", "add", "origin", target.gitUrl], { cwd: recipeDir, env }, runner);
  }
}

export async function publishRecipe(
  target: string,
  opts: RecipePublishOptions
): Promise<PublishedRecipe> {
  const github = parseGithubTarget(opts.github);
  const recipeDir = await editableRecipeDir(target, opts);
  mkdirSync(dirname(recipeDir), { recursive: true });
  readPiPackageManifest(recipeDir);

  const report = validateRecipeDirectory(recipeDir);
  const errors = report.findings.filter((finding) => finding.severity === "error");
  if (errors.length > 0) {
    throw new Error(
      [
        `Recipe ${report.manifest.name} is not ready to publish.`,
        ...errors.map((finding) => `- ${finding.message}`),
      ].join("\n")
    );
  }

  writePackageName(recipeDir, github.packageName);
  ensureGitignore(recipeDir);

  const env = opts.env ?? process.env;
  await ensureGitRepository(recipeDir, env, opts.commandRunner);
  const committed = await commitRecipe(
    recipeDir,
    opts.message ?? `Publish ${github.packageName}`,
    env,
    opts.commandRunner
  );
  const createdRepository = await ensureGithubRepository(
    github,
    opts.visibility,
    recipeDir,
    env,
    opts.commandRunner
  );
  await setOrigin(github, recipeDir, env, opts.commandRunner);
  await runCommand("git", ["push", "-u", "origin", "HEAD:main"], { cwd: recipeDir, env }, opts.commandRunner);

  const recipe = await addRecipe(recipeDir, opts);
  return {
    recipe,
    recipeDir,
    github: github.fullName,
    packageName: github.packageName,
    shortName: recipePreferredIdentifier(recipe),
    scopedName: recipeScopedIdentifier(recipe),
    createdRepository,
    committed,
    pushed: true,
  };
}
