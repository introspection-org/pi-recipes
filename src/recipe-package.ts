import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface RecipePackageResources {
  agents: string[];
  extensions: string[];
  skills: string[];
  prompts: string[];
  themes: string[];
}

export interface RecipePackageManifest {
  name: string;
  version: string;
  description?: string;
  path: string;
  resources: RecipePackageResources;
}

export type PiPackageResources = RecipePackageResources;
export type PiPackageManifest = RecipePackageManifest;

export type RecipeValidationSeverity = "error" | "warning";

export interface RecipeValidationFinding {
  severity: RecipeValidationSeverity;
  code: string;
  message: string;
  packageName?: string;
}

export interface RecipeValidationReport {
  valid: boolean;
  findings: RecipeValidationFinding[];
}

type PackageJson = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  pi?: unknown;
};

const RESOURCE_KEYS: Array<keyof RecipePackageResources> = [
  "agents",
  "extensions",
  "skills",
  "prompts",
  "themes",
];

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function emptyResources(): RecipePackageResources {
  return {
    agents: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  };
}

function normalizeResourcePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function hasTraversalSegment(path: string): boolean {
  return normalizeResourcePath(path)
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function assertPackageResourcePath(
  pkg: RecipePackageManifest,
  key: keyof RecipePackageResources,
  resource: string,
  resolved: string
): void {
  if (isAbsolute(resource) || hasTraversalSegment(resource)) {
    throw new RecipePackageError(
      `Recipe ${pkg.name} declares ${key} resource outside the package: ${resource}`
    );
  }
  const relativePath = relative(resolve(pkg.path), resolved);
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath)
  ) {
    throw new RecipePackageError(
      `Recipe ${pkg.name} declares ${key} resource outside the package: ${resource}`
    );
  }
}

function hasGlob(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizeResourcePath(glob);
  let pattern = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      const after = normalized[index + 2];
      if (after === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegExp(char);
    }
  }
  pattern += "$";
  return new RegExp(pattern);
}

function listPackageEntries(root: string): string[] {
  const entries: string[] = [];
  function visit(dir: string, relativeDir = ""): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const fullPath = join(dir, entry.name);
      entries.push(relative);
      if (entry.isDirectory()) visit(fullPath, relative);
    }
  }
  visit(root);
  return entries;
}

function finding(
  severity: RecipeValidationSeverity,
  code: string,
  message: string,
  packageName?: string
): RecipeValidationFinding {
  return {
    severity,
    code,
    message,
    packageName,
  };
}

export class RecipePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipePackageError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readJsonFile(path: string): PackageJson {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as PackageJson)
      : {};
  } catch (err) {
    throw new RecipePackageError(
      `Recipe package at ${path} has invalid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function packageJsonPath(packageDir: string): string | undefined {
  const packagePath = join(packageDir, "package.json");
  return existsSync(packagePath) ? packagePath : undefined;
}

function piPackageManifestBlock(raw: PackageJson): Record<string, unknown> | undefined {
  const pi = asRecord(raw.pi);
  return Object.keys(pi).length > 0 ? pi : undefined;
}

function piPackageManifestPath(packageDir: string): string | undefined {
  const manifestPath = packageJsonPath(packageDir);
  if (!manifestPath) return undefined;
  const raw = readJsonFile(manifestPath);
  return piPackageManifestBlock(raw) ? manifestPath : undefined;
}

export function readPiPackageManifest(packageDir: string): RecipePackageManifest {
  const packagePath = packageJsonPath(packageDir);
  if (!packagePath) {
    throw new RecipePackageError(
      `Recipe package at ${packageDir} is missing package.json with a pi manifest`
    );
  }

  const raw = readJsonFile(packagePath);
  const pi = piPackageManifestBlock(raw);
  if (!pi) {
    throw new RecipePackageError(
      `Recipe package at ${packageDir} is missing package.json pi manifest`
    );
  }

  const resources = emptyResources();
  for (const key of RESOURCE_KEYS) {
    resources[key] = stringArray(pi[key]).map(normalizeResourcePath);
  }

  return {
    name: stringValue(raw.name) ?? "local",
    version: stringValue(raw.version) ?? "0.0.0",
    ...(stringValue(raw.description) ? { description: stringValue(raw.description) } : {}),
    path: packageDir,
    resources,
  };
}

export function resolvePiPackageResourcePaths(
  pkg: RecipePackageManifest,
  key: keyof RecipePackageResources,
  opts: { allowEmptyGlobMatches?: boolean } = {}
): string[] {
  const globs = pkg.resources[key];
  const resolved = new Set<string>();
  const entries = globs.some(hasGlob) ? listPackageEntries(pkg.path) : [];

  for (const glob of globs) {
    if (!glob.trim()) continue;
    assertPackageResourcePath(pkg, key, glob, resolve(pkg.path, glob));
    if (!hasGlob(glob)) {
      const direct = resolve(pkg.path, glob);
      if (!existsSync(direct)) {
        throw new RecipePackageError(
          `Recipe ${pkg.name} declares missing ${key} resource: ${glob}`
        );
      }
      resolved.add(direct);
      continue;
    }

    const matcher = globToRegExp(glob);
    const matches = entries
      .filter((entry) => matcher.test(normalizeResourcePath(entry)))
      .map((entry) => resolve(pkg.path, entry));
    if (matches.length === 0) {
      if (opts.allowEmptyGlobMatches) continue;
      throw new RecipePackageError(
        `Recipe ${pkg.name} declares ${key} glob with no matches: ${glob}`
      );
    }
    for (const match of matches) resolved.add(match);
  }

  return [...resolved].sort();
}

export function defaultPiPackageResourcePaths(
  pkg: RecipePackageManifest,
  key: keyof RecipePackageResources
): string[] {
  const defaults: Partial<Record<keyof RecipePackageResources, string[]>> = {
    agents: [join(pkg.path, "agents")],
    skills: [join(pkg.path, "skills")],
    prompts: [join(pkg.path, "prompts")],
    themes: [join(pkg.path, "themes")],
  };
  return (defaults[key] ?? []).filter((path) => existsSync(path));
}

export function packageResourcePaths(
  pkg: RecipePackageManifest,
  key: keyof RecipePackageResources
): string[] {
  if (pkg.resources[key].length > 0) {
    return resolvePiPackageResourcePaths(pkg, key, {
      allowEmptyGlobMatches:
        key === "extensions" ||
        key === "skills" ||
        key === "prompts" ||
        key === "themes",
    });
  }
  return defaultPiPackageResourcePaths(pkg, key);
}

export function validatePiPackageManifest(
  pkg: RecipePackageManifest
): RecipeValidationReport {
  const findings: RecipeValidationFinding[] = [];
  if (!pkg.name.trim()) {
    findings.push(
      finding("error", "package.name_missing", "Package is missing name")
    );
  }
  if (!piPackageManifestPath(pkg.path)) {
    findings.push(
      finding(
        "error",
        "package.manifest_missing",
        "Package is missing package.json with a pi manifest",
        pkg.name
      )
    );
  }
  if (
    pkg.resources.agents.length === 0 &&
    !existsSync(join(pkg.path, "agents"))
  ) {
    findings.push(
      finding(
        "warning",
        "package.no_agents",
        "Package declares no agents and has no agents directory",
        pkg.name
      )
    );
  }

  return {
    valid: findings.every((item) => item.severity !== "error"),
    findings,
  };
}
