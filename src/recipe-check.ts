import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RecipeCheckDiagnostic {
  severity: "error" | "warning";
  code: string;
  path: string;
  span?: { line: number; column: number };
  message: string;
  help?: string;
}

export interface RecipeCheckReport {
  valid: boolean;
  profile: "local" | "ci" | "publish";
  diagnostics: RecipeCheckDiagnostic[];
}

// Keep Pi startup snapshots aligned with `introspection check`: generated
// dependency/build trees are not authored Recipe source.
const BLOCKED_GENERATED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  "out",
  "coverage",
  "htmlcov",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "venv",
]);

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function executableName(): string {
  return process.platform === "win32" ? "recipe-check.exe" : "recipe-check";
}

function validatorCommand(env: NodeJS.ProcessEnv): {
  command: string;
  args: string[];
} {
  if (env.PI_RECIPE_CHECK_BIN) {
    return { command: env.PI_RECIPE_CHECK_BIN, args: [] };
  }
  const root = packageRoot();
  const packaged = resolve(
    root,
    "vendor",
    "recipe-check",
    `${process.platform}-${process.arch}`,
    executableName()
  );
  if (existsSync(packaged)) return { command: packaged, args: [] };

  for (const profile of ["release", "debug"]) {
    const candidate = resolve(root, "target", profile, executableName());
    if (existsSync(candidate)) return { command: candidate, args: [] };
  }
  const manifest = resolve(root, "crates", "pi-recipe-check", "Cargo.toml");
  if (existsSync(manifest)) {
    return {
      command: "cargo",
      args: [
        "run",
        "--quiet",
        "--manifest-path",
        manifest,
        "--bin",
        "recipe-check",
        "--",
      ],
    };
  }
  throw new Error(
    `Recipe validator is unavailable for ${process.platform}-${process.arch}; reinstall @introspection-ai/recipes`
  );
}

function needsContent(path: string): boolean {
  return (
    path === "package.json" ||
    path === "package-lock.json" ||
    path === "npm-shrinkwrap.json" ||
    path === ".pi/mcp.local.example.json" ||
    path.endsWith(".yaml") ||
    path.endsWith(".yml")
  );
}

function snapshot(recipeDir: string): {
  files: Array<{ path: string; content?: string }>;
  directories: string[];
} {
  const files: Array<{ path: string; content?: string }> = [];
  const directories: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(recipeDir, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (entry.name === ".git" || BLOCKED_GENERATED_DIRS.has(entry.name)) {
          continue;
        }
        directories.push(path);
        visit(absolute);
      } else if (entry.isFile()) {
        files.push({
          path,
          ...(needsContent(path)
            ? { content: readFileSync(absolute, "utf8") }
            : {}),
        });
      }
    }
  };
  visit(recipeDir);
  directories.sort();
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, directories };
}

export async function checkRecipeAtLoad(
  recipeDir: string,
  env: NodeJS.ProcessEnv
): Promise<RecipeCheckReport> {
  const base = validatorCommand(env);
  const args = [
    ...base.args,
    "--snapshot",
    "-",
    "--profile",
    "local",
    "--json",
  ];
  const input = JSON.stringify(snapshot(recipeDir));
  return await new Promise((resolveReport, rejectReport) => {
    const child = spawn(base.command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", rejectReport);
    child.stdin.on("error", rejectReport);
    child.on("close", (code, signal) => {
      const error = Buffer.concat(stderr).toString("utf8").trim();
      if (signal || (code !== 0 && code !== 1)) {
        rejectReport(
          new Error(
            signal
              ? `Recipe validator terminated by signal ${signal}`
              : `Recipe validator failed with exit code ${code}: ${error}`
          )
        );
        return;
      }
      try {
        resolveReport(
          JSON.parse(Buffer.concat(stdout).toString("utf8")) as RecipeCheckReport
        );
      } catch (parseError) {
        rejectReport(
          new Error(
            `Recipe validator returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}${error ? `\n${error}` : ""}`
          )
        );
      }
    });
    child.stdin.end(input);
  });
}

export function formatRecipeDiagnostics(
  diagnostics: readonly RecipeCheckDiagnostic[]
): string {
  return diagnostics
    .map((diagnostic) => {
      const location = diagnostic.span
        ? `:${diagnostic.span.line}:${diagnostic.span.column}`
        : "";
      const help = diagnostic.help ? `\n  help: ${diagnostic.help}` : "";
      return `${diagnostic.severity} [${diagnostic.code}] ${diagnostic.path}${location}: ${diagnostic.message}${help}`;
    })
    .join("\n");
}
