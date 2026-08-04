import { spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RecipeCheckDiagnostic {
  code: string;
  path: string;
  span?: { line: number; column: number };
  message: string;
  help?: string;
}

export interface RecipeCheckReport {
  valid: boolean;
  diagnostics: RecipeCheckDiagnostic[];
  resources?: Record<string, number>;
}

// Skip large generated trees unless package.json explicitly declares a
// resource inside them. Explicit declarations are part of the Recipe and must
// remain visible to the checker exactly as they are to the runtime resolver.
const BLOCKED_GENERATED_DIRS = new Set([
  ".git",
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
  return process.platform === "win32" ? "introspection-recipe-check.exe" : "introspection-recipe-check";
}

function packagedPlatformIds(): string[] {
  const generic = `${process.platform}-${process.arch}`;
  if (process.platform !== "linux") return [generic];
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  const header = report?.header;
  return header?.glibcVersionRuntime
    ? [generic]
    : [`linux-${process.arch}-musl`, generic];
}

function executablePath(path: string): string {
  if (process.platform === "win32") return path;
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    // npm preserves executable mode only for package.json#bin entries. Recipes
    // intentionally exposes no CLI, so a packed native helper arrives as 0644.
  }
  try {
    chmodSync(path, 0o755);
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    // Some package stores are immutable. Materialize the private helper in a
    // process-owned temporary directory rather than requiring an install hook.
    const directory = mkdtempSync(join(tmpdir(), "recipe-check-"));
    const target = join(directory, executableName());
    copyFileSync(path, target);
    chmodSync(target, 0o755);
    return target;
  }
}

function validatorCommand(env: NodeJS.ProcessEnv): {
  command: string;
  args: string[];
} {
  if (env.INTROSPECTION_RECIPE_CHECK_BIN) {
    return { command: executablePath(env.INTROSPECTION_RECIPE_CHECK_BIN), args: [] };
  }
  const root = packageRoot();
  for (const platformId of packagedPlatformIds()) {
    const packaged = resolve(
      root,
      "vendor",
      "introspection-recipe-check",
      platformId,
      executableName()
    );
    if (existsSync(packaged)) {
      return { command: executablePath(packaged), args: [] };
    }
  }

  for (const profile of ["release", "debug"]) {
    const candidate = resolve(root, "target", profile, executableName());
    if (existsSync(candidate)) {
      return { command: executablePath(candidate), args: [] };
    }
  }
  const manifest = resolve(root, "crates", "introspection-recipe-check", "Cargo.toml");
  if (existsSync(manifest)) {
    return {
      command: "cargo",
      args: [
        "run",
        "--quiet",
        "--manifest-path",
        manifest,
        "--bin",
        "introspection-recipe-check",
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
    path === "SKILL.md" ||
    path.endsWith("/SKILL.md") ||
    path.endsWith(".yaml") ||
    path.endsWith(".yml")
  );
}

function declaredResourcePatterns(recipeDir: string): string[] {
  try {
    const raw = JSON.parse(
      readFileSync(join(recipeDir, "package.json"), "utf8")
    ) as { pi?: Record<string, unknown> };
    if (!raw.pi || typeof raw.pi !== "object" || Array.isArray(raw.pi)) {
      return [];
    }
    return ["agents", "extensions", "skills", "prompts"].flatMap((key) => {
      const value = raw.pi?.[key];
      if (!Array.isArray(value)) return [];
      return value
        .filter((item): item is string => typeof item === "string")
        .map((item) =>
          item.trim().replaceAll("\\", "/").replace(/^\.\/+/, "")
        );
    });
  } catch {
    // The checker reports malformed or unreadable package.json itself.
    return [];
  }
}

function containsDeclaredResource(
  directoryPath: string,
  patterns: readonly string[]
): boolean {
  return patterns.some(
    (pattern) =>
      pattern === directoryPath ||
      pattern.startsWith(`${directoryPath}/`) ||
      globCanMatchDescendant(pattern, directoryPath)
  );
}

function globCanMatchDescendant(pattern: string, directoryPath: string): boolean {
  if (!/[?*]/.test(pattern)) return false;
  const patternParts = pattern.split("/").filter(Boolean);
  const directoryParts = directoryPath.split("/").filter(Boolean);
  const segmentMatches = (glob: string, value: string): boolean => {
    let source = "^";
    for (const character of glob) {
      if (character === "*") source += ".*";
      else if (character === "?") source += ".";
      else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
    return new RegExp(`${source}$`).test(value);
  };
  const canMatchPrefix = (patternIndex: number, pathIndex: number): boolean => {
    if (pathIndex === directoryParts.length) return true;
    if (patternIndex === patternParts.length) return false;
    if (patternParts[patternIndex] === "**") {
      return (
        canMatchPrefix(patternIndex + 1, pathIndex) ||
        canMatchPrefix(patternIndex, pathIndex + 1)
      );
    }
    return (
      segmentMatches(patternParts[patternIndex]!, directoryParts[pathIndex]!) &&
      canMatchPrefix(patternIndex + 1, pathIndex + 1)
    );
  };
  return canMatchPrefix(0, 0);
}

function snapshot(recipeDir: string): {
  files: Array<{ path: string; content?: string }>;
  directories: string[];
} {
  const files: Array<{ path: string; content?: string }> = [];
  const directories: string[] = [];
  const resourcePatterns = declaredResourcePatterns(recipeDir);
  const visit = (directory: string, ancestors: ReadonlySet<string>): void => {
    const realDirectory = realpathSync(directory);
    if (ancestors.has(realDirectory)) return;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(realDirectory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(recipeDir, absolute).replaceAll("\\", "/");
      if (path === ".pi/mcp.local.json") continue;
      let target: {
        isDirectory(): boolean;
        isFile(): boolean;
      } = entry;
      if (entry.isSymbolicLink()) {
        try {
          target = statSync(absolute);
        } catch {
          // A dangling or inaccessible link is not authored Recipe content.
          // Keep the pre-symlink behavior and let explicit references surface
          // as normal missing-resource diagnostics from the shared checker.
          continue;
        }
      }
      if (target.isDirectory()) {
        if (
          BLOCKED_GENERATED_DIRS.has(entry.name) &&
          !containsDeclaredResource(path, resourcePatterns)
        ) {
          continue;
        }
        directories.push(path);
        visit(absolute, nextAncestors);
      } else if (target.isFile()) {
        files.push({
          path,
          ...(needsContent(path)
            ? { content: readFileSync(absolute, "utf8") }
            : {}),
        });
      }
    }
  };
  visit(recipeDir, new Set());
  directories.sort();
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, directories };
}

export async function checkRecipeAtLoad(
  recipeDir: string,
  env: NodeJS.ProcessEnv
): Promise<RecipeCheckReport> {
  const base = validatorCommand(env);
  const args = base.args;
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
      return `error [${diagnostic.code}] ${diagnostic.path}${location}: ${diagnostic.message}${help}`;
    })
    .join("\n");
}
