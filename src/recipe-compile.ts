import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  loadRecipeAgentDefinitions,
  loadRecipeSystemPrompt,
  validateRecipeAgentDefinitions,
  type RecipeAgentDefinition,
  type RecipeAgentValidationFinding,
} from "./recipe-agent.js";
import { executableRecipeToolNames, normalizeMcpServerId } from "./mcp.js";
import {
  packageResourcePaths,
  readPiPackageManifest,
  resolvePiPackageMcpManifestPaths,
  validatePiPackageManifest,
  type RecipeEvalSuite,
  type RecipePackageMcpConfig,
  type RecipePackageResources,
  type RecipeValidationFinding,
} from "./recipe-package.js";

export const COMPILED_RECIPE_FORMAT = "introspection.pi-recipe" as const;
export const COMPILED_RECIPE_VERSION = 1 as const;

const COMPILED_RESOURCE_KEYS: Array<
  keyof RecipePackageResources | "mcpManifests"
> = ["agents", "extensions", "skills", "prompts", "mcpManifests"];
const COMPILED_FILE_KINDS = new Set<CompiledRecipeResourceKind>([
  ...COMPILED_RESOURCE_KEYS,
  "package",
  "systemPrompt",
]);

export type CompiledRecipeResourceKind =
  | keyof RecipePackageResources
  | "mcpManifests"
  | "package"
  | "systemPrompt";

export interface CompiledRecipeFile {
  path: string;
  kinds: CompiledRecipeResourceKind[];
  size: number;
  sha256: string;
}

export interface CompiledRecipeAgent {
  name: string;
  aliases: string[];
  definition: RecipeAgentDefinition;
  executableTools: string[];
  extensionPaths: string[];
}

export interface CompiledRecipeToolCollision {
  agent: string;
  kind: "tool" | "mcp_server";
  normalizedName: string;
  declarations: string[];
}

export interface CompiledRecipeArtifact {
  format: typeof COMPILED_RECIPE_FORMAT;
  version: typeof COMPILED_RECIPE_VERSION;
  digest: string;
  package: {
    name: string;
    version: string;
    description?: string;
  };
  entrypoint: string | null;
  agents: CompiledRecipeAgent[];
  resources: Record<keyof RecipePackageResources | "mcpManifests", string[]>;
  files: CompiledRecipeFile[];
  mcp: RecipePackageMcpConfig;
  evals: RecipeEvalSuite[];
  systemPrompt?: string;
  diagnostics: {
    toolCollisions: CompiledRecipeToolCollision[];
  };
}

export interface CompileRecipeOptions {
  recipeDir: string;
}

export type RecipeCompileFinding =
  | ({ source: "package" } & RecipeValidationFinding)
  | ({ source: "agent" } & RecipeAgentValidationFinding);

export class RecipeCompileError extends Error {
  readonly findings: RecipeCompileFinding[];

  constructor(findings: RecipeCompileFinding[]) {
    super(
      [
        "Recipe compilation failed:",
        ...findings.map((finding) => `- ${finding.message}`),
      ].join("\n")
    );
    this.name = "RecipeCompileError";
    this.findings = findings;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPortableResourcePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return (
    Boolean(normalized) &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function relativeRecipePath(recipeDir: string, path: string): string {
  return relative(resolve(recipeDir), resolve(path)).split(sep).join("/");
}

function filesUnder(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => filesUnder(resolve(path, entry.name)));
}

function resourceFiles(
  recipeDir: string,
  resources: Array<{ kind: CompiledRecipeResourceKind; paths: string[] }>
): CompiledRecipeFile[] {
  const files = new Map<string, CompiledRecipeFile>();
  for (const resource of resources) {
    for (const resourcePath of resource.paths) {
      for (const path of filesUnder(resourcePath)) {
        const relativePath = relativeRecipePath(recipeDir, path);
        const content = readFileSync(path);
        const existing = files.get(relativePath);
        if (existing) {
          if (!existing.kinds.includes(resource.kind)) {
            existing.kinds.push(resource.kind);
            existing.kinds.sort();
          }
          continue;
        }
        files.set(relativePath, {
          path: relativePath,
          kinds: [resource.kind],
          size: content.byteLength,
          sha256: sha256(content),
        });
      }
    }
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function duplicateValues(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

function toolCollisions(agents: CompiledRecipeAgent[]): CompiledRecipeToolCollision[] {
  return agents.flatMap((agent) => {
    const toolDuplicates = duplicateValues(agent.executableTools).map((tool) => ({
      agent: agent.name,
      kind: "tool" as const,
      normalizedName: tool,
      declarations: agent.definition.tools.filter((value) => value === tool),
    }));
    const mcpDeclarations = Object.keys(agent.definition.mcp ?? {});
    const normalizedMcp = mcpDeclarations.map(normalizeMcpServerId);
    const mcpDuplicates = duplicateValues(normalizedMcp).map((serverId) => ({
      agent: agent.name,
      kind: "mcp_server" as const,
      normalizedName: serverId,
      declarations: mcpDeclarations.filter(
        (value) => normalizeMcpServerId(value) === serverId
      ),
    }));
    return [...toolDuplicates, ...mcpDuplicates];
  });
}

function entrypointFor(agents: CompiledRecipeAgent[]): string | null {
  const defaultAgent = agents.find(
    (agent) => agent.name === "agent" || agent.aliases.includes("agent")
  );
  if (defaultAgent) return defaultAgent.name;
  return agents.length === 1 ? agents[0]!.name : null;
}

function normalizeExtensionSelector(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.[^.\/]+$/, "");
}

function extensionMatches(path: string, selector: string): boolean {
  const normalized = normalizeExtensionSelector(selector.trim());
  if (!normalized) return false;
  if (normalized === "*") return true;
  const withoutExtension = normalizeExtensionSelector(path);
  const parts = withoutExtension.split("/");
  const base = parts.at(-1)!;
  const parent = parts.length > 1 ? parts.at(-2) : undefined;
  return new Set([
    path,
    withoutExtension,
    base,
    parent && base === "index" ? parent : undefined,
  ]).has(normalized);
}

function selectedExtensionPaths(
  paths: string[],
  definition: RecipeAgentDefinition
): string[] {
  const include = definition.extensions?.include;
  const exclude = definition.extensions?.exclude ?? [];
  return paths.filter((path) => {
    const included =
      include === undefined ||
      include.some((selector) => extensionMatches(path, selector));
    return included && !exclude.some((selector) => extensionMatches(path, selector));
  });
}

/**
 * Resolve and validate a recipe package into a path-independent, versioned artifact.
 * Hosts may cache the artifact by digest and materialize its relative resource paths
 * against the original recipe directory.
 */
export function compileRecipe(opts: CompileRecipeOptions): CompiledRecipeArtifact {
  const recipeDir = resolve(opts.recipeDir);
  const manifest = readPiPackageManifest(recipeDir);
  const packageFindings: RecipeCompileFinding[] = validatePiPackageManifest(manifest).findings
    .filter((finding) => finding.severity === "error")
    .map((finding) => ({ ...finding, source: "package" as const }));
  const agentFindings: RecipeCompileFinding[] = validateRecipeAgentDefinitions(recipeDir)
    .filter((finding) => finding.severity !== "warning")
    .map((finding) => ({ ...finding, source: "agent" as const }));
  const findings = [...packageFindings, ...agentFindings];
  if (findings.length > 0) throw new RecipeCompileError(findings);

  const definitions = loadRecipeAgentDefinitions(recipeDir);
  const uniqueDefinitions = new Map<string, RecipeAgentDefinition>();
  const aliases = new Map<string, string[]>();
  for (const [key, definition] of definitions) {
    uniqueDefinitions.set(definition.name, definition);
    if (key !== definition.name) {
      aliases.set(definition.name, [...(aliases.get(definition.name) ?? []), key]);
    }
  }
  const unresolvedAgents = [...uniqueDefinitions.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((definition) => ({
      name: definition.name,
      aliases: [...(aliases.get(definition.name) ?? [])].sort(),
      definition: structuredClone(definition),
      executableTools: executableRecipeToolNames(definition.tools),
    }));

  const resourcePaths = {
    agents: packageResourcePaths(manifest, "agents"),
    extensions: packageResourcePaths(manifest, "extensions"),
    skills: packageResourcePaths(manifest, "skills"),
    prompts: packageResourcePaths(manifest, "prompts"),
    mcpManifests: resolvePiPackageMcpManifestPaths(manifest),
  };
  const relativeResources = Object.fromEntries(
    Object.entries(resourcePaths).map(([kind, paths]) => [
      kind,
      paths.map((path) => relativeRecipePath(recipeDir, path)).sort(),
    ])
  ) as CompiledRecipeArtifact["resources"];
  const agents: CompiledRecipeAgent[] = unresolvedAgents.map((agent) => ({
    ...agent,
    extensionPaths: selectedExtensionPaths(
      relativeResources.extensions,
      agent.definition
    ),
  }));
  const systemPrompt = loadRecipeSystemPrompt(recipeDir);
  const systemPromptPath = resolve(recipeDir, "SYSTEM.md");
  const files = resourceFiles(recipeDir, [
    { kind: "package", paths: [resolve(recipeDir, "package.json")] },
    ...Object.entries(resourcePaths).map(([kind, paths]) => ({
      kind: kind as CompiledRecipeResourceKind,
      paths,
    })),
    ...(systemPrompt ? [{ kind: "systemPrompt" as const, paths: [systemPromptPath] }] : []),
  ]);

  const withoutDigest = {
    format: COMPILED_RECIPE_FORMAT,
    version: COMPILED_RECIPE_VERSION,
    package: {
      name: manifest.name,
      version: manifest.version,
      ...(manifest.description ? { description: manifest.description } : {}),
    },
    entrypoint: entrypointFor(agents),
    agents,
    resources: relativeResources,
    files,
    mcp: structuredClone(manifest.mcp),
    evals: structuredClone(manifest.evals.suites),
    ...(systemPrompt ? { systemPrompt } : {}),
    diagnostics: { toolCollisions: toolCollisions(agents) },
  };
  // Strip undefined object properties exactly as JSON transport will. This
  // keeps the digest stable before and after serialize/parse round trips.
  const serializable = JSON.parse(
    JSON.stringify(withoutDigest)
  ) as Omit<CompiledRecipeArtifact, "digest">;
  return {
    ...serializable,
    digest: `sha256:${sha256(canonicalJson(serializable))}`,
  };
}

export function assertCompiledRecipeArtifact(
  value: unknown
): asserts value is CompiledRecipeArtifact {
  if (!value || typeof value !== "object") {
    throw new Error("Compiled recipe artifact must be an object");
  }
  const artifact = value as Partial<CompiledRecipeArtifact>;
  if (artifact.format !== COMPILED_RECIPE_FORMAT) {
    throw new Error(`Unsupported compiled recipe format: ${String(artifact.format)}`);
  }
  if (artifact.version !== COMPILED_RECIPE_VERSION) {
    throw new Error(`Unsupported compiled recipe version: ${String(artifact.version)}`);
  }
  if (
    !isRecord(artifact.package) ||
    typeof artifact.package.name !== "string" ||
    typeof artifact.package.version !== "string" ||
    (artifact.entrypoint !== null && typeof artifact.entrypoint !== "string") ||
    !Array.isArray(artifact.agents) ||
    !artifact.agents.every(
      (agent) =>
        isRecord(agent) &&
        typeof agent.name === "string" &&
        isStringArray(agent.aliases) &&
        isRecord(agent.definition) &&
        isStringArray(agent.executableTools) &&
        isStringArray(agent.extensionPaths) &&
        agent.extensionPaths.every(isPortableResourcePath)
    ) ||
    !isRecord(artifact.resources) ||
    !COMPILED_RESOURCE_KEYS.every(
      (kind) =>
        isStringArray(artifact.resources?.[kind]) &&
        artifact.resources[kind]!.every(isPortableResourcePath)
    ) ||
    !Array.isArray(artifact.files) ||
    !artifact.files.every(
      (file) =>
        isRecord(file) &&
        typeof file.path === "string" &&
        isPortableResourcePath(file.path) &&
        isStringArray(file.kinds) &&
        file.kinds.length > 0 &&
        file.kinds.every((kind) =>
          COMPILED_FILE_KINDS.has(kind as CompiledRecipeResourceKind)
        ) &&
        typeof file.size === "number" &&
        typeof file.sha256 === "string"
    ) ||
    !isRecord(artifact.mcp) ||
    !Array.isArray(artifact.evals) ||
    !isRecord(artifact.diagnostics) ||
    typeof artifact.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.digest)
  ) {
    throw new Error("Compiled recipe artifact is malformed");
  }
  const { digest: _digest, ...withoutDigest } = artifact as CompiledRecipeArtifact;
  const expected = `sha256:${sha256(canonicalJson(withoutDigest))}`;
  if (artifact.digest !== expected) {
    throw new Error(`Compiled recipe digest mismatch: expected ${expected}`);
  }
}

export function compiledRecipeAgent(
  artifact: CompiledRecipeArtifact,
  agentName?: string
): CompiledRecipeAgent {
  assertCompiledRecipeArtifact(artifact);
  const selected = agentName?.trim() || artifact.entrypoint;
  if (!selected) {
    throw new Error(
      "Compiled recipe has multiple agents and no default entrypoint; select an agent explicitly"
    );
  }
  const agent = artifact.agents.find(
    (candidate) =>
      candidate.name === selected || candidate.aliases.includes(selected)
  );
  if (!agent) throw new Error(`Recipe agent not found: ${selected}`);
  return agent;
}

export function readCompiledRecipeArtifact(path: string): CompiledRecipeArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    throw new Error(
      `Unable to read compiled recipe artifact at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  assertCompiledRecipeArtifact(parsed);
  return parsed;
}

export async function writeCompiledRecipeArtifact(
  path: string,
  artifact: CompiledRecipeArtifact
): Promise<void> {
  assertCompiledRecipeArtifact(artifact);
  const target = resolve(path);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(artifact)}\n`, "utf8");
    await rename(temporary, target);
  } catch (err) {
    await rm(temporary, { force: true });
    throw err;
  }
}

export async function compileRecipeToFile(opts: {
  recipeDir: string;
  outputPath: string;
}): Promise<CompiledRecipeArtifact> {
  const artifact = compileRecipe({ recipeDir: opts.recipeDir });
  await writeCompiledRecipeArtifact(opts.outputPath, artifact);
  return artifact;
}
