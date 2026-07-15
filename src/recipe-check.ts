import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RecipeCheckProfile = "local" | "ci" | "publish";

export interface RecipeCheckOptions {
  json?: boolean;
  profile?: RecipeCheckProfile;
  env?: NodeJS.ProcessEnv;
}

export interface RecipeCheckSpan {
  line: number;
  column: number;
}

export interface RecipeCheckDiagnostic {
  severity: "error" | "warning";
  code: string;
  path: string;
  span?: RecipeCheckSpan;
  message: string;
  help?: string;
}

export interface RecipeCheckReport {
  valid: boolean;
  profile: RecipeCheckProfile;
  recipe_dir: string;
  package_name?: string;
  diagnostics: RecipeCheckDiagnostic[];
  resources: Record<string, number>;
}

interface RecipeCheckCommand {
  command: string;
  args: string[];
}

function recipeCheckEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return env ? { ...process.env, ...env } : process.env;
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function executableName(): string {
  return process.platform === "win32" ? "recipe-check.exe" : "recipe-check";
}

function platformPackageId(): string {
  return `${process.platform}-${process.arch}`;
}

function recipeCheckCommand(env: NodeJS.ProcessEnv): RecipeCheckCommand {
  if (env.PI_RECIPE_CHECK_BIN) {
    return { command: env.PI_RECIPE_CHECK_BIN, args: [] };
  }

  const root = packageRoot();
  const packaged = resolve(
    root,
    "vendor",
    "recipe-check",
    platformPackageId(),
    executableName()
  );
  if (existsSync(packaged)) return { command: packaged, args: [] };

  const crateDir = resolve(root, "crates", "pi-recipe-check");
  for (const targetRoot of [resolve(root, "target"), resolve(crateDir, "target")]) {
    for (const profile of ["release", "debug"]) {
      const candidate = resolve(targetRoot, profile, executableName());
      if (existsSync(candidate)) return { command: candidate, args: [] };
    }
  }

  const manifest = resolve(crateDir, "Cargo.toml");
  if (existsSync(manifest)) {
    return {
      command: "cargo",
      args: ["run", "--quiet", "--manifest-path", manifest, "--"],
    };
  }

  throw new Error(
    [
      `recipe-check binary is not available for ${platformPackageId()}.`,
      `Expected packaged binary at ${packaged}.`,
      "Reinstall @introspection-ai/pi-recipes or set PI_RECIPE_CHECK_BIN to a compatible recipe-check binary.",
    ].join("\n")
  );
}

export async function runRecipeCheck(
  recipeDir: string,
  opts: RecipeCheckOptions = {}
): Promise<number> {
  const env = recipeCheckEnv(opts.env);
  const base = recipeCheckCommand(env);
  const args = [
    ...base.args,
    recipeDir,
    "--profile",
    opts.profile ?? "local",
    ...(opts.json ? ["--json"] : []),
  ];

  return await new Promise<number>((resolveRun, rejectRun) => {
    const child = spawn(base.command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      if (stdout.length > 0) process.stdout.write(Buffer.concat(stdout));
      if (stderr.length > 0) process.stderr.write(Buffer.concat(stderr));
      if (signal) {
        rejectRun(new Error(`recipe-check terminated by signal ${signal}`));
        return;
      }
      resolveRun(code ?? 1);
    });
  });
}

export async function readRecipeCheckReport(
  recipeDir: string,
  opts: Omit<RecipeCheckOptions, "json"> = {}
): Promise<RecipeCheckReport> {
  const env = recipeCheckEnv(opts.env);
  const base = recipeCheckCommand(env);
  const args = [
    ...base.args,
    recipeDir,
    "--profile",
    opts.profile ?? "local",
    "--json",
  ];

  return await new Promise<RecipeCheckReport>((resolveRun, rejectRun) => {
    const child = spawn(base.command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", rejectRun);
    child.on("close", (_code, signal) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (signal) {
        rejectRun(new Error(`recipe-check terminated by signal ${signal}`));
        return;
      }
      try {
        resolveRun(JSON.parse(output) as RecipeCheckReport);
      } catch (err) {
        rejectRun(
          new Error(
            [
              "recipe-check did not return a JSON report.",
              errorOutput,
              err instanceof Error ? err.message : String(err),
            ].filter(Boolean).join("\n")
          )
        );
      }
    });
  });
}
