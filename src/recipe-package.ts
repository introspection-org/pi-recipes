import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface RecipePackageResources {
  agents: string[];
  extensions: string[];
  skills: string[];
  prompts: string[];
}

export interface RecipePackageMcpServer {
  id: string;
  required: boolean;
  tools: RecipeMcpToolSelection;
}

export interface RecipeMcpToolSelection {
  /** Exact tool names or the reserved whole-toolset `*` sentinel. Required by validation. */
  include?: string[];
  /** Exact tool names removed after inclusion. */
  exclude?: string[];
}

export interface RecipePackageMcpConfig {
  manifests: string[];
  servers: RecipePackageMcpServer[];
}

export type RecipeEvalSuite =
  | { name: string; type: "registry"; dataset: string; version: string }
  | { name: string; type: "git"; repo: string; rev: string; dataset: string };

export interface RecipeEvalsConfig {
  suites: RecipeEvalSuite[];
  raw?: unknown;
}

export interface RecipePackageManifest {
  name: string;
  version: string;
  description?: string;
  path: string;
  resources: RecipePackageResources;
  mcp: RecipePackageMcpConfig;
  evals: RecipeEvalsConfig;
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
  };
}

function emptyMcpConfig(): RecipePackageMcpConfig {
  return {
    manifests: [],
    servers: [],
  };
}

function emptyEvalsConfig(): RecipeEvalsConfig {
  return {
    suites: [],
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

function parseMcpConfig(value: unknown): RecipePackageMcpConfig {
  if (typeof value === "string") {
    return { ...emptyMcpConfig(), manifests: stringArray([value]).map(normalizeResourcePath) };
  }
  if (Array.isArray(value)) {
    return { ...emptyMcpConfig(), manifests: stringArray(value).map(normalizeResourcePath) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyMcpConfig();

  const data = value as Record<string, unknown>;
  const manifests = [
    ...(stringValue(data.manifest) ? [stringValue(data.manifest)!] : []),
    ...stringArray(data.manifests),
  ].map(normalizeResourcePath);

  const seen = new Set<string>();
  const servers: RecipePackageMcpServer[] = [];
  for (const raw of Array.isArray(data.servers) ? data.servers : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const server = raw as Record<string, unknown>;
    const id = stringValue(server.id);
    if (!id || seen.has(id)) continue;
    const tools = asRecord(server.tools);
    const include = Object.hasOwn(tools, "include")
      ? stringArray(tools.include)
      : Object.hasOwn(tools, "allow")
        ? stringArray(tools.allow)
        : undefined;
    const exclude = Object.hasOwn(tools, "exclude")
      ? stringArray(tools.exclude)
      : undefined;
    seen.add(id);
    servers.push({
      id,
      required: server.required === true,
      tools: {
        ...(include !== undefined ? { include } : {}),
        ...(exclude !== undefined ? { exclude } : {}),
      },
    });
  }

  return { manifests, servers };
}

function withRawEvalsConfig(
  config: RecipeEvalsConfig,
  raw: unknown
): RecipeEvalsConfig {
  Object.defineProperty(config, "raw", {
    value: raw,
    enumerable: false,
    configurable: false,
  });
  return config;
}

export function parseEvalsConfig(
  value: unknown,
  present = value !== undefined
): RecipeEvalsConfig {
  if (!present) return emptyEvalsConfig();
  const data = asRecord(value);
  const rawSuites = Array.isArray(data.suites) ? data.suites : [];
  const suites: RecipeEvalSuite[] = [];

  for (const raw of rawSuites) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const suite = raw as Record<string, unknown>;
    const name = stringValue(suite.name);
    const type = stringValue(suite.type);
    if (!name) continue;

    if (type === "registry") {
      const dataset = stringValue(suite.dataset);
      const version = stringValue(suite.version);
      if (!dataset || !version) continue;
      suites.push({ name, type, dataset, version });
    } else if (type === "git") {
      const repo = stringValue(suite.repo);
      const rev = stringValue(suite.rev);
      const dataset = stringValue(suite.dataset);
      if (!repo || !rev || !dataset) continue;
      suites.push({
        name,
        type,
        repo,
        rev,
        dataset,
      });
    }
  }

  return withRawEvalsConfig({ suites }, value);
}

function fixedRegistryTag(value: string): boolean {
  const tag = value.trim();
  if (!tag || tag.toLowerCase() === "latest") return false;
  if (/\s/.test(tag) || /[\^~<>=*|]/.test(tag)) return false;
  return !/(^|[._-])x($|[._-])/i.test(tag);
}

function fixedGitRev(value: string): boolean {
  return /^[0-9a-fA-F]{7,40}$/.test(value);
}

export function validateRecipeEvalsConfig(
  evals: RecipeEvalsConfig,
  packageName?: string
): RecipeValidationReport {
  const findings: RecipeValidationFinding[] = [];
  const raw = evals.raw;
  const data = raw === undefined ? { suites: evals.suites } : asRecord(raw);
  const rawSuites = Array.isArray(data.suites) ? data.suites : [];

  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
    findings.push(
      finding(
        "error",
        "evals.suite_invalid",
        "pi.evals must be an object with a suites array",
        packageName
      )
    );
    return { valid: false, findings };
  }

  if (data.suites !== undefined && !Array.isArray(data.suites)) {
    findings.push(
      finding(
        "error",
        "evals.suite_invalid",
        "pi.evals.suites must be an array",
        packageName
      )
    );
    return { valid: false, findings };
  }

  const seenNames = new Map<string, number>();
  for (const [index, rawSuite] of rawSuites.entries()) {
    const label = `pi.evals.suites[${index}]`;
    if (!rawSuite || typeof rawSuite !== "object" || Array.isArray(rawSuite)) {
      findings.push(
        finding("error", "evals.suite_invalid", `${label} must be an object`, packageName)
      );
      continue;
    }

    const suite = rawSuite as Record<string, unknown>;
    const name = stringValue(suite.name);
    const type = stringValue(suite.type);
    if (!name) {
      findings.push(
        finding(
          "error",
          "evals.suite_invalid",
          `${label} must declare a non-empty name`,
          packageName
        )
      );
    } else {
      const firstIndex = seenNames.get(name);
      if (firstIndex !== undefined) {
        findings.push(
          finding(
            "error",
            "evals.name_duplicate",
            `${label} reuses suite name "${name}" already declared at pi.evals.suites[${firstIndex}]`,
            packageName
          )
        );
      } else {
        seenNames.set(name, index);
      }
    }

    if (type !== "registry" && type !== "git") {
      findings.push(
        finding(
          "error",
          "evals.suite_invalid",
          `${label} must use type "registry" or "git"`,
          packageName
        )
      );
      continue;
    }

    if (type === "registry") {
      if (!stringValue(suite.dataset)) {
        findings.push(
          finding(
            "error",
            "evals.suite_invalid",
            `${label} registry suite must declare dataset`,
            packageName
          )
        );
      }
      const version = stringValue(suite.version);
      if (!version) {
        findings.push(
          finding(
            "error",
            "evals.suite_invalid",
            `${label} registry suite must declare version`,
            packageName
          )
        );
      } else if (!fixedRegistryTag(version)) {
        findings.push(
          finding(
            "error",
            "evals.pin_mutable",
            `${label} registry version must be an explicit Harbor registry tag, not a mutable alias or range: ${version}`,
            packageName
          )
        );
      }
    } else {
      if (!stringValue(suite.repo)) {
        findings.push(
          finding(
            "error",
            "evals.suite_invalid",
            `${label} git suite must declare repo`,
            packageName
          )
        );
      }
      const rev = stringValue(suite.rev);
      if (!rev) {
        findings.push(
          finding(
            "error",
            "evals.suite_invalid",
            `${label} git suite must declare rev`,
            packageName
          )
        );
      } else if (!fixedGitRev(rev)) {
        findings.push(
          finding(
            "error",
            "evals.pin_mutable",
            `${label} git rev must be a 7-40 character hex commit SHA: ${rev}`,
            packageName
          )
        );
      }
      if (!stringValue(suite.dataset)) {
        findings.push(
          finding(
            "error",
            "evals.suite_invalid",
            `${label} git suite must declare dataset`,
            packageName
          )
        );
      }
    }
  }

  return {
    valid: findings.every((item) => item.severity !== "error"),
    findings,
  };
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
    name: stringValue(raw.name) ?? "",
    version: stringValue(raw.version) ?? "0.0.0",
    ...(stringValue(raw.description) ? { description: stringValue(raw.description) } : {}),
    path: packageDir,
    resources,
    mcp: parseMcpConfig(pi.mcp),
    evals: parseEvalsConfig(
      pi.evals,
      Object.prototype.hasOwnProperty.call(pi, "evals")
    ),
  };
}

export function resolvePiPackageMcpManifestPaths(
  pkg: RecipePackageManifest,
  opts: { allowEmptyGlobMatches?: boolean } = {}
): string[] {
  const globs = pkg.mcp.manifests;
  const resolved = new Set<string>();
  const entries = globs.some(hasGlob) ? listPackageEntries(pkg.path) : [];

  for (const glob of globs) {
    if (!glob.trim()) continue;
    if (isAbsolute(glob) || hasTraversalSegment(glob)) {
      throw new RecipePackageError(
        `Recipe ${pkg.name} declares mcp manifest outside the package: ${glob}`
      );
    }
    const target = resolve(pkg.path, glob);
    const relativePath = relative(resolve(pkg.path), target);
    if (
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      relativePath.startsWith("..\\") ||
      isAbsolute(relativePath)
    ) {
      throw new RecipePackageError(
        `Recipe ${pkg.name} declares mcp manifest outside the package: ${glob}`
      );
    }
    if (!hasGlob(glob)) {
      if (!existsSync(target)) {
        throw new RecipePackageError(
          `Recipe ${pkg.name} declares missing mcp manifest: ${glob}`
        );
      }
      resolved.add(target);
      continue;
    }

    const matcher = globToRegExp(glob);
    const matches = entries
      .filter((entry) => matcher.test(normalizeResourcePath(entry)))
      .map((entry) => resolve(pkg.path, entry));
    if (matches.length === 0) {
      if (opts.allowEmptyGlobMatches) continue;
      throw new RecipePackageError(
        `Recipe ${pkg.name} declares mcp manifest glob with no matches: ${glob}`
      );
    }
    for (const match of matches) resolved.add(match);
  }

  return [...resolved].sort();
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
        key === "prompts",
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
  for (const server of pkg.mcp.servers) {
    if (server.tools.include === undefined) {
      findings.push(
        finding(
          "error",
          "pi.mcp_include_missing",
          `MCP server "${server.id}" must declare tools.include; use ["*"] for all tools or [] for none`,
          pkg.name
        )
      );
    }
    for (const [list, selectors] of [
      ["include", server.tools.include],
      ["exclude", server.tools.exclude],
    ] as const) {
      for (const selector of selectors ?? []) {
        const trimmed = selector.trim();
        const valid = list === "include"
          ? Boolean(trimmed) && (trimmed === "*" || !trimmed.includes("*"))
          : Boolean(trimmed) && !trimmed.includes("*");
        if (valid) continue;
        findings.push(
          finding(
            "error",
            "pi.mcp_selector_invalid",
            `MCP server "${server.id}" tools.${list} entry "${selector}" must be ${list === "include" ? 'an exact tool name or "*"' : "an exact tool name"}`,
            pkg.name
          )
        );
      }
    }
  }
  findings.push(...validateRecipeEvalsConfig(pkg.evals, pkg.name).findings);

  return {
    valid: findings.every((item) => item.severity !== "error"),
    findings,
  };
}
