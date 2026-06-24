import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readPiPackageManifest,
  validatePiPackageManifest,
  type RecipePackageManifest,
} from "./recipe-package.js";

const execFileAsync = promisify(execFile);

type PackageManager = "npm" | "pnpm" | "yarn";

export interface RecipeStoreOptions {
  storeDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface InstalledRecipe {
  id: string;
  source: string;
  path: string;
  installedAt: string;
  name: string;
  version: string;
  description?: string;
}

export interface RecipeStoreFile {
  version: 1;
  recipes: InstalledRecipe[];
}

interface GithubRecipeSource {
  kind: "github";
  input: string;
  host: "github.com";
  owner: string;
  repo: string;
  ref?: string;
  subdir?: string;
}

interface GitRecipeSource {
  kind: "git";
  input: string;
  url: string;
  ref?: string;
  subdir?: string;
}

interface LocalRecipeSource {
  kind: "local";
  input: string;
  path: string;
}

export type RecipeSource = GithubRecipeSource | GitRecipeSource | LocalRecipeSource;

export function defaultRecipeStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_RECIPES_HOME ?? join(homedir(), ".agent-recipes");
}

export function recipeStoreFilePath(storeDir = defaultRecipeStoreDir()): string {
  return join(storeDir, "recipes.json");
}

function sanitizeSegment(value: string): string {
  const sanitized =
    value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "_";
  return sanitized === "." || sanitized === ".." ? "_" : sanitized;
}

function hashedCacheSegment(value: string): string {
  const slug = sanitizeSegment(redactUrl(value)).slice(0, 80);
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function splitRef(input: string): { spec: string; ref?: string } {
  const index = input.indexOf("#");
  if (index < 0) return { spec: input };
  const spec = input.slice(0, index);
  const ref = input.slice(index + 1).trim();
  return { spec, ...(ref ? { ref } : {}) };
}

function normalizeSubdir(value: string | undefined): string | undefined {
  const subdir = value?.replace(/^\/+|\/+$/g, "");
  if (subdir && !isSafeRelativePath(subdir)) return undefined;
  return subdir ? subdir : undefined;
}

function hasUnsafePathSegment(value: string): boolean {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function isSafeRelativePath(value: string): boolean {
  return !isAbsolute(value) && !hasUnsafePathSegment(value);
}

function isSafeGithubName(value: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}

function parseExplicitGithubShorthand(input: string): GithubRecipeSource | undefined {
  if (!input.startsWith("github:")) return undefined;
  const source = parseGithubShorthand(input.slice("github:".length));
  return source ? { ...source, input } : undefined;
}

function parseGithubUrl(input: string): GithubRecipeSource | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.hostname !== "github.com") return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repoWithGit] = parts;
  if (!owner || !repoWithGit) return undefined;
  const repo = stripGitSuffix(repoWithGit);
  if (!isSafeGithubName(owner) || !isSafeGithubName(repo)) return undefined;
  const hashRef = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;
  if (hashRef && !isSafeRelativePath(hashRef)) return undefined;
  if (parts[2] === "tree" && parts[3]) {
    if (!isSafeRelativePath(parts[3])) return undefined;
    const subdirInput = parts.slice(4).join("/");
    const subdir = normalizeSubdir(subdirInput);
    if (subdirInput && !subdir) return undefined;
    return {
      kind: "github",
      input,
      host: "github.com",
      owner,
      repo,
      ref: hashRef ?? parts[3],
      ...(subdir ? { subdir } : {}),
    };
  }
  return {
    kind: "github",
    input,
    host: "github.com",
    owner,
    repo,
    ...(hashRef ? { ref: hashRef } : {}),
  };
}

function parseGithubShorthand(input: string): GithubRecipeSource | undefined {
  const { spec, ref } = splitRef(input);
  const parts = spec.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const [owner, repo, ...subdirParts] = parts;
  if (!owner || !repo) return undefined;
  if (!isSafeGithubName(owner) || !isSafeGithubName(repo)) {
    return undefined;
  }
  if (ref && !isSafeRelativePath(ref)) return undefined;
  const subdirInput = subdirParts.join("/");
  const subdir = normalizeSubdir(subdirInput);
  if (subdirInput && !subdir) return undefined;
  return {
    kind: "github",
    input,
    host: "github.com",
    owner,
    repo,
    ...(ref ? { ref } : {}),
    ...(subdir ? { subdir } : {}),
  };
}

function isLikelyGitUrl(value: string): boolean {
  return (
    /^git\+https?:\/\//i.test(value) ||
    /^https?:\/\/.+\.git(?:#.*)?$/i.test(value) ||
    /^ssh:\/\/.+/i.test(value) ||
    /^file:\/\/.+/i.test(value) ||
    /^git@[^:]+:.+/i.test(value)
  );
}

function parseGitSource(input: string): GitRecipeSource | undefined {
  if (!isLikelyGitUrl(input)) return undefined;
  const { spec, ref } = splitRef(input.replace(/^git\+/i, ""));
  return {
    kind: "git",
    input,
    url: spec,
    ...(ref ? { ref } : {}),
  };
}

export function parseRecipeSource(input: string, opts: RecipeStoreOptions = {}): RecipeSource {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Recipe source is required");

  const cwd = opts.cwd ?? process.cwd();
  const expanded = expandHome(trimmed);
  const localPath = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  if (
    existsSync(localPath) ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~")
  ) {
    return { kind: "local", input, path: localPath };
  }

  const explicitGithub = parseExplicitGithubShorthand(trimmed);
  if (explicitGithub) return explicitGithub;

  const gitSource = parseGitSource(trimmed);
  if (gitSource) return gitSource;

  const githubUrl = parseGithubUrl(trimmed);
  if (githubUrl) return githubUrl;

  const githubShorthand = parseGithubShorthand(trimmed);
  if (githubShorthand) return githubShorthand;

  throw new Error(`Unsupported recipe source: ${input}`);
}

export function recipeSourceId(source: RecipeSource): string {
  if (source.kind === "local") return `local:${source.path}`;
  if (source.kind === "git") {
    return [
      "git:",
      source.url,
      source.subdir ? `/${source.subdir}` : "",
      source.ref ? `#${source.ref}` : "",
    ].join("");
  }
  const suffix = [
    `${source.owner}/${source.repo}`,
    source.subdir,
  ].filter(Boolean).join("/");
  return `github:${suffix}${source.ref ? `#${source.ref}` : ""}`;
}

function cloneDirectoryForSource(source: GithubRecipeSource, storeDir: string): string {
  const ref = sanitizeSegment(source.ref ?? "HEAD");
  return join(
    storeDir,
    "sources",
    source.host,
    sanitizeSegment(source.owner),
    sanitizeSegment(source.repo),
    ref
  );
}

function cloneDirectoryForGitSource(source: GitRecipeSource, storeDir: string): string {
  const ref = hashedCacheSegment(source.ref ?? "HEAD");
  return join(
    storeDir,
    "sources",
    "git",
    hashedCacheSegment(source.url),
    ref
  );
}

function recipeDirectoryForSource(source: RecipeSource, storeDir: string): string {
  if (source.kind === "local") return source.path;
  const cloned =
    source.kind === "github"
      ? cloneDirectoryForSource(source, storeDir)
      : cloneDirectoryForGitSource(source, storeDir);
  const recipeDir = source.subdir ? resolve(cloned, source.subdir) : cloned;
  const relativePath = relative(cloned, recipeDir);
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Recipe source resolves outside its clone: ${source.input}`);
  }
  return recipeDir;
}

export function readRecipeStore(storeDir = defaultRecipeStoreDir()): RecipeStoreFile {
  const path = recipeStoreFilePath(storeDir);
  if (!existsSync(path)) return { version: 1, recipes: [] };
  return JSON.parse(readFileSync(path, "utf8")) as RecipeStoreFile;
}

function writeRecipeStore(store: RecipeStoreFile, storeDir: string): void {
  const path = recipeStoreFilePath(storeDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readPackageJson(path: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    throw new Error(
      `Recipe dependency manifest at ${path} has invalid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

function hasRuntimeDependencies(pkg: Record<string, unknown>): boolean {
  return [pkg.dependencies, pkg.optionalDependencies].some(
    (value) => Object.keys(asRecord(value)).length > 0
  );
}

function packageManagerFromSpec(value: unknown): PackageManager | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.split("@")[0];
  return name === "npm" || name === "pnpm" || name === "yarn" ? name : undefined;
}

function packageManagerForRecipe(recipeDir: string, pkg: Record<string, unknown>): PackageManager {
  return packageManagerFromSpec(pkg.packageManager)
    ?? (existsSync(join(recipeDir, "pnpm-lock.yaml"))
      ? "pnpm"
      : existsSync(join(recipeDir, "yarn.lock"))
        ? "yarn"
        : "npm");
}

function hasDependencyLockfile(recipeDir: string): boolean {
  return [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
  ].some((name) => existsSync(join(recipeDir, name)));
}

function dependencyInstallCommand(
  manager: PackageManager,
  recipeDir: string,
  requireLockfile: boolean
): { command: string; args: string[] } {
  if (manager === "pnpm") {
    return {
      command: "pnpm",
      args: [
        "install",
        "--prod",
        "--ignore-scripts",
        ...(requireLockfile ? ["--frozen-lockfile"] : []),
      ],
    };
  }
  if (manager === "yarn") {
    return {
      command: "yarn",
      args: [
        "install",
        "--production",
        "--ignore-scripts",
        ...(requireLockfile ? ["--frozen-lockfile"] : []),
      ],
    };
  }
  if (
    requireLockfile &&
    (existsSync(join(recipeDir, "package-lock.json")) ||
      existsSync(join(recipeDir, "npm-shrinkwrap.json")))
  ) {
    return { command: "npm", args: ["ci", "--omit=dev", "--ignore-scripts"] };
  }
  return { command: "npm", args: ["install", "--omit=dev", "--ignore-scripts"] };
}

async function installRecipeDependencies(
  recipeDir: string,
  opts: RecipeStoreOptions & { requireLockfile: boolean }
): Promise<void> {
  const packagePath = join(recipeDir, "package.json");
  if (!existsSync(packagePath)) return;

  const pkg = readPackageJson(packagePath);
  if (!hasRuntimeDependencies(pkg)) return;
  if (opts.requireLockfile && !hasDependencyLockfile(recipeDir)) {
    throw new Error(
      `Recipe ${recipeDir} declares extension dependencies but has no lockfile; add package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, or yarn.lock`
    );
  }

  const manager = packageManagerForRecipe(recipeDir, pkg);
  const { command, args } = dependencyInstallCommand(
    manager,
    recipeDir,
    opts.requireLockfile
  );
  try {
    await execFileAsync(command, args, {
      cwd: recipeDir,
      env: opts.env ?? process.env,
    });
  } catch (err) {
    throw new Error(
      `Failed to install recipe extension dependencies with ${command} ${args.join(" ")}:\n${gitErrorText(err)}`
    );
  }
}

function githubToken(env: NodeJS.ProcessEnv): string | undefined {
  return env.GITHUB_TOKEN ?? env.GH_TOKEN;
}

function githubCloneUrl(source: GithubRecipeSource, env: NodeJS.ProcessEnv): string {
  return `https://github.com/${source.owner}/${source.repo}.git`;
}

function githubGitEnv(
  source: GithubRecipeSource,
  env: NodeJS.ProcessEnv,
  dir: string
): { env: NodeJS.ProcessEnv; cleanup(): void } {
  const token = githubToken(env);
  if (!token) return { env, cleanup() {} };

  const askpass = join(
    dir,
    `.recipes-git-askpass-${sanitizeSegment(source.owner)}-${sanitizeSegment(source.repo)}-${Date.now()}.sh`
  );
  writeFileSync(
    askpass,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      "  *Username*) printf '%s\\n' x-access-token ;;",
      "  *) printf '%s\\n' \"$GITHUB_TOKEN\" ;;",
      "esac",
      "",
    ].join("\n")
  );
  chmodSync(askpass, 0o700);
  return {
    env: {
      ...env,
      GITHUB_TOKEN: token,
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: "0",
    },
    cleanup() {
      rmSync(askpass, { force: true });
    },
  };
}

function redactUrl(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@");
}

function gitErrorText(err: unknown): string {
  if (err && typeof err === "object") {
    const maybe = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
    const text = [maybe.stderr, maybe.stdout]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n")
      .trim();
    if (text) return redactUrl(text);
    if (typeof maybe.message === "string" && maybe.message.trim()) {
      return redactUrl(maybe.message);
    }
  }
  return redactUrl(err instanceof Error ? err.message : String(err));
}

function githubAuthHint(source: GithubRecipeSource): string {
  return [
    `Could not install github:${source.owner}/${source.repo}.`,
    "",
    "If this repository is private, use standard git authentication:",
    `  pi-recipes install git@github.com:${source.owner}/${source.repo}.git`,
    "",
    "For CI or noninteractive installs, set GITHUB_TOKEN or GH_TOKEN:",
    `  GITHUB_TOKEN=... pi-recipes install github:${source.owner}/${source.repo}`,
  ].join("\n");
}

async function cloneGitSource(
  source: GithubRecipeSource | GitRecipeSource,
  storeDir: string,
  opts: RecipeStoreOptions & { force?: boolean }
): Promise<void> {
  const target =
    source.kind === "github"
      ? cloneDirectoryForSource(source, storeDir)
      : cloneDirectoryForGitSource(source, storeDir);
  if (opts.force) rmSync(target, { recursive: true, force: true });
  if (existsSync(target)) return;

  mkdirSync(dirname(target), { recursive: true });
  const baseEnv = opts.env ?? process.env;
  const gitEnv =
    source.kind === "github"
      ? githubGitEnv(source, baseEnv, dirname(target))
      : { env: baseEnv, cleanup() {} };
  const url = source.kind === "github" ? githubCloneUrl(source, gitEnv.env) : source.url;
  const baseArgs = ["clone", "--depth", "1"];
  const args = source.ref
    ? [...baseArgs, "--branch", source.ref, url, target]
    : [...baseArgs, url, target];

  try {
    await execFileAsync("git", args, { env: gitEnv.env });
  } catch (err) {
    if (!source.ref) {
      const message = source.kind === "github"
        ? `${githubAuthHint(source)}\n\nUnderlying git error:\n${gitErrorText(err)}`
        : `Could not install git source ${redactUrl(source.input)}.\n\nUnderlying git error:\n${gitErrorText(err)}`;
      throw new Error(message);
    }
    rmSync(target, { recursive: true, force: true });
    try {
      await execFileAsync("git", ["clone", url, target], { env: gitEnv.env });
      await execFileAsync("git", ["checkout", source.ref], { cwd: target, env: gitEnv.env });
    } catch (fallbackErr) {
      const message = source.kind === "github"
        ? `${githubAuthHint(source)}\n\nUnderlying git error:\n${gitErrorText(fallbackErr)}`
        : `Could not install git source ${redactUrl(source.input)}.\n\nUnderlying git error:\n${gitErrorText(fallbackErr)}`;
      throw new Error(message);
    }
  } finally {
    gitEnv.cleanup();
  }
}

function installedRecipeFromManifest(
  id: string,
  source: string,
  path: string,
  manifest: RecipePackageManifest
): InstalledRecipe {
  return {
    id,
    source,
    path,
    installedAt: new Date().toISOString(),
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description ? { description: manifest.description } : {}),
  };
}

export async function addRecipe(
  input: string,
  opts: RecipeStoreOptions & { force?: boolean } = {}
): Promise<InstalledRecipe> {
  const storeDir = opts.storeDir ?? defaultRecipeStoreDir(opts.env);
  const source = parseRecipeSource(input, opts);
  if (source.kind === "github" || source.kind === "git") {
    await cloneGitSource(source, storeDir, opts);
  }

  const path = recipeDirectoryForSource(source, storeDir);
  const manifest = readPiPackageManifest(path);
  const validation = validatePiPackageManifest(manifest);
  const errors = validation.findings.filter((finding) => finding.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((finding) => finding.message).join("\n"));
  }
  await installRecipeDependencies(path, {
    ...opts,
    requireLockfile: source.kind !== "local",
  });

  const id = recipeSourceId(source);
  const installed = installedRecipeFromManifest(id, input, path, manifest);
  const store = readRecipeStore(storeDir);
  store.recipes = [
    ...store.recipes.filter((recipe) => recipe.id !== id && recipe.name !== manifest.name),
    installed,
  ].sort((a, b) => a.name.localeCompare(b.name));
  writeRecipeStore(store, storeDir);
  return installed;
}

export function listRecipes(opts: RecipeStoreOptions = {}): InstalledRecipe[] {
  const storeDir = opts.storeDir ?? defaultRecipeStoreDir(opts.env);
  return readRecipeStore(storeDir).recipes;
}

function recipeSourceSlug(value: string): string | undefined {
  const withoutRef = value.replace(/^git:/, "").split("#")[0] ?? "";
  const withoutGit = stripGitSuffix(withoutRef.replace(/\/+$/g, ""));
  const sshMatch = withoutGit.match(/^[^@]+@[^:]+:.+\/([^/]+)$/);
  if (sshMatch?.[1]) return sshMatch[1];
  const parts = withoutGit.split("/").filter(Boolean);
  const repo = parts.at(-1);
  if (!repo) return undefined;
  if (repo.includes(":")) return undefined;
  return repo;
}

function installedRecipeMatches(recipe: InstalledRecipe, identifier: string): boolean {
  return [
    recipe.name,
    recipe.id,
    recipe.source,
    recipeSourceSlug(recipe.source),
    recipeSourceSlug(recipe.id),
  ].some((value) => value === identifier);
}

export function removeRecipe(identifier: string, opts: RecipeStoreOptions = {}): InstalledRecipe | undefined {
  const storeDir = opts.storeDir ?? defaultRecipeStoreDir(opts.env);
  const store = readRecipeStore(storeDir);
  const removed = store.recipes.find((recipe) => installedRecipeMatches(recipe, identifier));
  if (!removed) return undefined;
  store.recipes = store.recipes.filter((recipe) => recipe !== removed);
  writeRecipeStore(store, storeDir);
  return removed;
}

export function resolveRecipeDirectory(input: string, opts: RecipeStoreOptions = {}): string {
  const cwd = opts.cwd ?? process.cwd();
  const expanded = expandHome(input.trim());
  const localPath = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  if (existsSync(localPath)) return localPath;

  const storeDir = opts.storeDir ?? defaultRecipeStoreDir(opts.env);
  const store = readRecipeStore(storeDir);
  const direct = store.recipes.find((recipe) => installedRecipeMatches(recipe, input));
  if (direct) return direct.path;

  try {
    const id = recipeSourceId(parseRecipeSource(input, opts));
    const parsed = store.recipes.find((recipe) => recipe.id === id);
    if (parsed) return parsed.path;
  } catch {
    // Return the original path-shaped value below for the existing error paths.
  }

  return localPath;
}

export function recipeDisplayName(recipe: InstalledRecipe): string {
  return `${recipe.name}@${recipe.version}`;
}

export function recipeBasename(path: string): string {
  return basename(path.replace(/\/+$/g, ""));
}
