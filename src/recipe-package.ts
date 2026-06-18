import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface PiPackageResources {
  agents: string[];
  profiles: string[];
  extensions: string[];
  skills: string[];
  prompts: string[];
  themes: string[];
}

export interface PiPackageManifest {
  name: string;
  version: string;
  path: string;
  resources: PiPackageResources;
}

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
  pi?: Partial<Record<keyof PiPackageResources, unknown>>;
};

const RESOURCE_KEYS: Array<keyof PiPackageResources> = [
  "agents",
  "profiles",
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

function emptyResources(): PiPackageResources {
  return {
    agents: [],
    profiles: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  };
}

function normalizeResourcePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
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

export function readPiPackageManifest(packageDir: string): PiPackageManifest {
  const packagePath = join(packageDir, "package.json");
  if (!existsSync(packagePath)) {
    throw new RecipePackageError(
      `Pi package at ${packageDir} is missing package.json`
    );
  }

  let raw: PackageJson;
  try {
    raw = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
  } catch (err) {
    throw new RecipePackageError(
      `Pi package at ${packageDir} has invalid package.json: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const resources = emptyResources();
  for (const key of RESOURCE_KEYS) {
    resources[key] = stringArray(raw.pi?.[key]).map(normalizeResourcePath);
  }

  return {
    name:
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : "local",
    version:
      typeof raw.version === "string" && raw.version.trim()
        ? raw.version.trim()
        : "0.0.0",
    path: packageDir,
    resources,
  };
}

export function resolvePiPackageResourcePaths(
  pkg: PiPackageManifest,
  key: keyof PiPackageResources,
  opts: { allowEmptyGlobMatches?: boolean } = {}
): string[] {
  const globs = pkg.resources[key];
  const resolved = new Set<string>();
  const entries = globs.some(hasGlob) ? listPackageEntries(pkg.path) : [];

  for (const glob of globs) {
    if (!glob.trim()) continue;
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
  pkg: PiPackageManifest,
  key: keyof PiPackageResources
): string[] {
  const defaults: Partial<Record<keyof PiPackageResources, string[]>> = {
    agents: [join(pkg.path, "agents")],
    profiles: [join(pkg.path, "profiles")],
    skills: [join(pkg.path, "skills")],
    prompts: [join(pkg.path, "prompts")],
    themes: [join(pkg.path, "themes")],
  };
  return (defaults[key] ?? []).filter((path) => existsSync(path));
}

export function packageResourcePaths(
  pkg: PiPackageManifest,
  key: keyof PiPackageResources
): string[] {
  if (pkg.resources[key].length > 0) {
    return resolvePiPackageResourcePaths(pkg, key, {
      allowEmptyGlobMatches: key === "skills" || key === "prompts" || key === "themes",
    });
  }
  return defaultPiPackageResourcePaths(pkg, key);
}

export function validatePiPackageManifest(
  pkg: PiPackageManifest
): RecipeValidationReport {
  const findings: RecipeValidationFinding[] = [];
  if (!pkg.name.trim()) {
    findings.push(
      finding("error", "package.name_missing", "Package is missing name")
    );
  }
  if (!existsSync(join(pkg.path, "package.json"))) {
    findings.push(
      finding(
        "error",
        "package.package_json_missing",
        "Package is missing package.json",
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
