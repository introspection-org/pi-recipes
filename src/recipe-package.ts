import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PiPackageResources {
  agents: string[];
  profiles: string[];
  extensions: string[];
  skills: string[];
  prompts: string[];
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
  };
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
    resources[key] = stringArray(raw.pi?.[key]).map((glob) =>
      glob.replace(/^\.\//, "")
    );
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
