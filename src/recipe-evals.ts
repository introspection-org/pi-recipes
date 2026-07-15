import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type RecipeEvalSuite,
  type RecipePackageManifest,
  validateRecipeEvalsConfig,
} from "./recipe-package.js";

const execFileAsync = promisify(execFile);
const PI_HARBOR_AGENT = "pi_recipe_agent:PiRecipeAgent";
const CONTAINER_RECIPE_SOURCE = "/pi-recipe-source";
const CONTAINER_RECIPE_RUNTIME = "/pi-recipe-runtime";

export interface RecipeEvalsOptions {
  suite?: string;
  dryRun?: boolean;
  datasetPath?: string;
  recipeSource?: string;
  agentName?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  harborBin?: string;
  adapterDir?: string;
  harborArgs?: string[];
  runtimeSource?: string;
}

interface HarborMount {
  type: "bind";
  source: string;
  target: string;
  read_only: true;
}

export interface RecipeEvalInvocation {
  suite?: string;
  mode: "registry" | "git" | "dataset-path";
  command: string[];
  cwd: string;
  env: Record<string, string>;
  displayCommand: string;
  gitRegistry?: {
    repo: string;
    rev: string;
    placeholderPath: string;
  };
}

export interface RecipeEvalsResult {
  recipe: string;
  dryRun: boolean;
  invocations: RecipeEvalInvocation[];
}

export interface RecipeEvalSuiteListResult {
  recipe: string;
  suites: RecipeEvalSuite[];
}

export interface RecipeEvalCloneCheckout {
  repo: string;
  rev: string;
  path: string;
  suites: string[];
  overwritten: boolean;
}

export interface RecipeEvalCloneResult {
  recipe: string;
  destination: string;
  checkouts: RecipeEvalCloneCheckout[];
}

export interface RecipeEvalCloneOptions {
  suite?: string;
  destination: string;
  cwd?: string;
  force?: boolean;
}

function packageRootFromModule(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function defaultHarborAdapterDir(): string {
  return resolve(packageRootFromModule(), "harbor");
}

function harborInstallHint(): string {
  return [
    "Harbor is required to run recipe evals, but `harbor` was not found on PATH.",
    "Install Harbor and try again, or use `recipes evals ... --dry-run` to inspect commands without executing.",
  ].join("\n");
}

async function requireHarbor(harborBin: string): Promise<void> {
  try {
    await execFileAsync("which", [harborBin], { maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error(harborInstallHint());
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function envWithPythonPath(
  env: NodeJS.ProcessEnv,
  adapterDir: string,
  recipeSource: string,
  manifest: RecipePackageManifest,
  agentName?: string,
  runtimeSource?: string
): Record<string, string> {
  const additions: Record<string, string> = {
    PI_RECIPE_SOURCE: recipeSource,
    PI_RECIPE_NAME: recipeRuntimeName(manifest.name),
    PYTHONPATH: env.PYTHONPATH ? `${adapterDir}:${env.PYTHONPATH}` : adapterDir,
  };
  if (agentName) additions.PI_RECIPE_AGENT = agentName;
  if (runtimeSource) additions.PI_RECIPE_RUNTIME = runtimeSource;
  return additions;
}

function recipeRuntimeName(packageName: string): string {
  const scoped = packageName.startsWith("@") ? packageName.slice(1) : packageName;
  return scoped.split("/").at(-1) ?? scoped;
}

function recipeMounts(recipeSource: string, runtimeSource?: string): {
  mounts: HarborMount[];
  recipeSource: string;
} {
  const mounts: HarborMount[] = [];
  let mountedRecipeSource = recipeSource;
  if (!isAbsolute(recipeSource) || !existsSync(recipeSource)) {
    return { mounts, recipeSource: mountedRecipeSource };
  }
  mountedRecipeSource = CONTAINER_RECIPE_SOURCE;
  mounts.push({
    type: "bind",
    source: recipeSource,
    target: CONTAINER_RECIPE_SOURCE,
    read_only: true,
  });
  if (runtimeSource && isAbsolute(runtimeSource) && existsSync(runtimeSource)) {
    mounts.push({
      type: "bind",
      source: runtimeSource,
      target: CONTAINER_RECIPE_RUNTIME,
      read_only: true,
    });
  }
  return {
    recipeSource: mountedRecipeSource,
    mounts,
  };
}

function commandDisplay(
  command: string[],
  env: Record<string, string>
): string {
  const envParts = Object.entries(env).map(
    ([key, value]) => `${key}=${shellQuote(value)}`
  );
  return [...envParts, ...command.map(shellQuote)].join(" ");
}

function mountArgs(mounts: HarborMount[]): string[] {
  return mounts.length > 0 ? ["--mounts", JSON.stringify(mounts)] : [];
}

function selectedSuites(
  manifest: RecipePackageManifest,
  suiteName?: string
): RecipeEvalSuite[] {
  if (!suiteName) return manifest.evals.suites;
  return manifest.evals.suites.filter((suite) => suite.name === suiteName);
}

function assertValidRecipeEvals(manifest: RecipePackageManifest): void {
  const validation = validateRecipeEvalsConfig(manifest.evals, manifest.name);
  if (!validation.valid) {
    const details = validation.findings
      .map((finding) => `${finding.code}: ${finding.message}`)
      .join("\n");
    throw new Error(`Recipe has invalid Harbor eval suite pins:\n${details}`);
  }
}

function validatedSelectedSuites(
  manifest: RecipePackageManifest,
  suiteName?: string
): RecipeEvalSuite[] {
  assertValidRecipeEvals(manifest);
  if (manifest.evals.suites.length === 0) {
    throw new Error(`Recipe ${manifest.name} declares no Harbor eval suites`);
  }
  const suites = selectedSuites(manifest, suiteName);
  if (suites.length === 0) {
    throw new Error(`Recipe ${manifest.name} has no Harbor eval suite named ${suiteName}`);
  }
  return suites;
}

export function listRecipeEvalSuites(
  manifest: RecipePackageManifest,
  suite?: string
): RecipeEvalSuiteListResult {
  assertValidRecipeEvals(manifest);
  const suites = selectedSuites(manifest, suite);
  if (suite && suites.length === 0) {
    throw new Error(`Recipe ${manifest.name} has no Harbor eval suite named ${suite}`);
  }
  return {
    recipe: manifest.name,
    suites,
  };
}

export function buildRecipeEvalInvocations(
  manifest: RecipePackageManifest,
  opts: RecipeEvalsOptions = {}
): RecipeEvalInvocation[] {
  const harborBin = opts.harborBin ?? "harbor";
  const harborArgs = opts.harborArgs ?? [];
  const adapterDir = opts.adapterDir ?? defaultHarborAdapterDir();
  const recipeMount = recipeMounts(
    opts.recipeSource ?? manifest.path,
    opts.runtimeSource
  );
  const env = envWithPythonPath(
    opts.env ?? process.env,
    adapterDir,
    recipeMount.recipeSource,
    manifest,
    opts.agentName,
    opts.runtimeSource ? CONTAINER_RECIPE_RUNTIME : undefined
  );
  const cwd = opts.cwd ?? manifest.path;
  const mounts = mountArgs(recipeMount.mounts);

  if (opts.datasetPath) {
    const datasetPath = resolve(opts.datasetPath);
    const command = [
      harborBin,
      "run",
      "-p",
      datasetPath,
      "--agent",
      PI_HARBOR_AGENT,
      ...mounts,
      ...harborArgs,
    ];
    return [
      {
        suite: opts.suite,
        mode: "dataset-path",
        command,
        cwd,
        env,
        displayCommand: commandDisplay(command, env),
      },
    ];
  }

  const suites = validatedSelectedSuites(manifest, opts.suite);

  return suites.map((suite) => {
    const gitRegistryPath =
      suite.type === "git"
        ? `<checkout:${suite.repo}@${suite.rev}>`
        : undefined;
    const command = suite.type === "registry"
      ? [
          harborBin,
          "run",
          "-d",
          `${suite.dataset}@${suite.version}`,
          "--agent",
          PI_HARBOR_AGENT,
          ...mounts,
          ...harborArgs,
        ]
      : [
          harborBin,
          "run",
          "--registry-path",
          gitRegistryPath!,
          "-d",
          suite.dataset,
          "--agent",
          PI_HARBOR_AGENT,
          ...mounts,
          ...harborArgs,
        ];
    return {
      suite: suite.name,
      mode: suite.type,
      command,
      cwd,
      env,
      displayCommand: commandDisplay(command, env),
      ...(suite.type === "git"
        ? {
            gitRegistry: {
              repo: suite.repo,
              rev: suite.rev,
              placeholderPath: gitRegistryPath!,
            },
          }
        : {}),
    };
  });
}

function checkoutDirName(repo: string): string {
  const repoPath = repo.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const rawName = basename(repoPath).replace(/\.git$/, "") || "evals";
  return rawName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "evals";
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export async function cloneRecipeEvalSuites(
  manifest: RecipePackageManifest,
  opts: RecipeEvalCloneOptions
): Promise<RecipeEvalCloneResult> {
  const suites = validatedSelectedSuites(manifest, opts.suite);
  const gitSuites = suites.filter((suite): suite is Extract<RecipeEvalSuite, { type: "git" }> =>
    suite.type === "git"
  );

  if (gitSuites.length === 0) {
    if (opts.suite && suites[0]?.type === "registry") {
      throw new Error(
        `Suite "${opts.suite}" is a Harbor registry dataset, so there is no git source to clone.`
      );
    }
    throw new Error(`Recipe ${manifest.name} declares no git-backed Harbor eval suites to clone`);
  }

  const destination = resolve(opts.cwd ?? process.cwd(), opts.destination);
  mkdirSync(destination, { recursive: true });

  const grouped = new Map<string, { repo: string; rev: string; suites: string[] }>();
  for (const suite of gitSuites) {
    const key = `${suite.repo}\0${suite.rev}`;
    const group = grouped.get(key);
    if (group) {
      group.suites.push(suite.name);
    } else {
      grouped.set(key, { repo: suite.repo, rev: suite.rev, suites: [suite.name] });
    }
  }

  const usedNames = new Set<string>();
  const checkouts: RecipeEvalCloneCheckout[] = [];
  for (const group of grouped.values()) {
    let dirName = checkoutDirName(group.repo);
    if (usedNames.has(dirName)) {
      dirName = `${dirName}-${shortHash(`${group.repo}\0${group.rev}`)}`;
    }
    usedNames.add(dirName);

    const path = join(destination, dirName);
    const existed = existsSync(path);
    if (existed && !opts.force) {
      throw new Error(`Eval checkout already exists: ${path}. Use --force to replace it.`);
    }
    if (existed) rmSync(path, { recursive: true, force: true });

    try {
      await execFileAsync("git", ["clone", group.repo, path], {
        maxBuffer: 10 * 1024 * 1024,
      });
      await execFileAsync("git", ["-C", path, "checkout", "--detach", group.rev], {
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err) {
      rmSync(path, { recursive: true, force: true });
      throw err;
    }

    checkouts.push({
      repo: group.repo,
      rev: group.rev,
      path,
      suites: group.suites,
      overwritten: existed,
    });
  }

  return {
    recipe: manifest.name,
    destination,
    checkouts,
  };
}

function absolutizeRegistryTaskPaths(registryPath: string, checkoutDir: string): void {
  const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as unknown;
  const datasets = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { datasets?: unknown }).datasets)
      ? (parsed as { datasets: unknown[] }).datasets
      : undefined;
  if (!datasets) return;

  for (const rawDataset of datasets) {
    if (!rawDataset || typeof rawDataset !== "object") continue;
    const tasks = (rawDataset as { tasks?: unknown }).tasks;
    if (!Array.isArray(tasks)) continue;
    for (const rawTask of tasks) {
      if (!rawTask || typeof rawTask !== "object") continue;
      const task = rawTask as { path?: unknown };
      if (typeof task.path === "string" && !isAbsolute(task.path)) {
        task.path = join(checkoutDir, task.path);
      }
    }
  }

  writeFileSync(registryPath, `${JSON.stringify(datasets, null, 2)}\n`);
}

async function materializeGitRegistry(
  invocation: RecipeEvalInvocation
): Promise<{ invocation: RecipeEvalInvocation; cleanup: () => void }> {
  if (!invocation.gitRegistry) {
    return { invocation, cleanup: () => {} };
  }

  const checkoutDir = mkdtempSync(join(tmpdir(), "pi-recipe-evals-"));
  try {
    await execFileAsync("git", ["clone", invocation.gitRegistry.repo, checkoutDir], {
      maxBuffer: 1024 * 1024,
    });
    await execFileAsync(
      "git",
      ["-C", checkoutDir, "checkout", "--detach", invocation.gitRegistry.rev],
      { maxBuffer: 1024 * 1024 }
    );
  } catch (err) {
    rmSync(checkoutDir, { recursive: true, force: true });
    throw err;
  }

  const registryPath = join(checkoutDir, "registry.json");
  absolutizeRegistryTaskPaths(registryPath, checkoutDir);
  const command = invocation.command.map((arg) =>
    arg === invocation.gitRegistry?.placeholderPath ? registryPath : arg
  );
  const prepared = {
    ...invocation,
    command,
    displayCommand: commandDisplay(command, invocation.env),
  };
  return {
    invocation: prepared,
    cleanup: () => rmSync(checkoutDir, { recursive: true, force: true }),
  };
}

async function preparePiRuntime(): Promise<{ path: string; cleanup: () => void }> {
  const runtimeRoot = join(homedir(), ".cache", "pi-recipes", "eval-runtimes");
  mkdirSync(runtimeRoot, { recursive: true });
  const runtimeDir = mkdtempSync(join(runtimeRoot, "runtime-"));
  const root = packageRootFromModule();
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", root, "--pack-destination", runtimeDir, "--json"],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    const packed = JSON.parse(stdout) as Array<{ filename?: string }>;
    const tarball = packed[0]?.filename;
    if (!tarball) throw new Error("npm pack did not report a tarball filename");
    writeFileSync(
      join(runtimeDir, "package.json"),
      `${JSON.stringify({
        private: true,
        dependencies: {
          "@introspection-ai/pi-recipes": `file:./${basename(tarball)}`,
          "@earendil-works/pi-agent-core": "0.80.3",
          "@earendil-works/pi-ai": "0.80.3",
          "@earendil-works/pi-coding-agent": "0.80.3",
          "@earendil-works/pi-tui": "0.80.3",
          typebox: "^1.0.56",
        },
      }, null, 2)}\n`
    );
    await execFileAsync("npm", ["install", "--ignore-scripts"], {
      cwd: runtimeDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      path: runtimeDir,
      cleanup: () => rmSync(runtimeDir, { recursive: true, force: true }),
    };
  } catch (err) {
    rmSync(runtimeDir, { recursive: true, force: true });
    throw err;
  }
}

async function runInvocation(
  invocation: RecipeEvalInvocation,
  baseEnv: NodeJS.ProcessEnv
): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const [bin, ...args] = invocation.command;
    const child = spawn(bin!, args, {
      cwd: existsSync(invocation.cwd) ? invocation.cwd : undefined,
      env: { ...baseEnv, ...invocation.env },
      stdio: "inherit",
    });
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolveRun();
      } else if (signal) {
        rejectRun(new Error(`${invocation.command.join(" ")} terminated by signal ${signal}`));
      } else {
        rejectRun(new Error(`${invocation.command.join(" ")} exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

export async function runRecipeEvals(
  manifest: RecipePackageManifest,
  opts: RecipeEvalsOptions = {}
): Promise<RecipeEvalsResult> {
  let invocations = buildRecipeEvalInvocations(manifest, opts);
  if (opts.dryRun) {
    return {
      recipe: manifest.name,
      dryRun: true,
      invocations,
    };
  }

  await requireHarbor(opts.harborBin ?? "harbor");
  const runtime = await preparePiRuntime();
  try {
    invocations = buildRecipeEvalInvocations(manifest, {
      ...opts,
      runtimeSource: runtime.path,
    });
    for (const invocation of invocations) {
      const preparedRegistry = await materializeGitRegistry(invocation);
      try {
        await runInvocation(preparedRegistry.invocation, opts.env ?? process.env);
        const index = invocations.indexOf(invocation);
        if (index >= 0) invocations[index] = preparedRegistry.invocation;
      } finally {
        preparedRegistry.cleanup();
      }
    }
  } finally {
    runtime.cleanup();
  }
  return {
    recipe: manifest.name,
    dryRun: false,
    invocations,
  };
}
