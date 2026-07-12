import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import {
  mergeRecipeAgentModelConfig,
  parseRecipeAgentModelConfig,
  RecipeModelConfigError,
  type RecipeAgentModelConfig,
} from "./recipe-model.js";
import {
  isValidRecipeMcpToolSelection,
  packageResourcePaths,
  readPiPackageManifest,
  RecipePackageError,
} from "./recipe-package.js";
import {
  mcpSelectionAllowsTool,
  normalizeMcpServerId,
} from "./mcp.js";

export interface RecipeSystemInstructions {
  mode: "append" | "replace";
  content: string;
}

export interface RecipeAgentExtensions {
  include?: string[];
  exclude?: string[];
}

export interface RecipeAgentMcpServer {
  /** Exact tool names or the reserved whole-toolset `*` sentinel. */
  include?: string[];
  /** Exact tool names removed after inclusion. */
  exclude?: string[];
}

export type RecipeAgentMcp = Record<string, RecipeAgentMcpServer>;

/**
 * Per-connector selectors declared on an agent — the connector analogue of
 * `RecipeAgentMcp`. `subject` is whose authority the token carries (app | user |
 * person); `scopes` narrows to a subset of the connector's scopes; the optional
 * `approvalPolicy` is a tighten-only override of the org connector default.
 */
export interface RecipeAgentConnectorSelectors {
  subject?: string;
  scopes?: string[];
  approvalPolicy?: string;
}

export type RecipeAgentConnectors = Record<
  string,
  RecipeAgentConnectorSelectors
>;

export interface RecipeAgentDefinition {
  name: string;
  from?: string;
  description?: string;
  model?: {
    name?: string;
    thinkingLevel?: string;
  };
  /**
   * The full validated `model:` block (stream options, provider routing),
   * merged along the `from:` chain. `model` is its `{name, thinkingLevel}`
   * projection, kept for callers that only route on the spec.
   */
  modelConfig?: RecipeAgentModelConfig;
  tools: string[];
  /** MCP tool selection, separate from the exact Pi/extension tool allowlist. */
  mcp?: RecipeAgentMcp;
  /**
   * Connectors this agent may use (docs/design/connectors-aauth-b2b2c.md §18).
   * The connector *definition* (endpoints/creds/Person Server/approval policy)
   * lives org-side in the CP; the recipe only references + scopes connectors.
   */
  connectors?: RecipeAgentConnectors;
  skills: string[];
  /** True when `skills:` was declared (directly or inherited) rather than defaulted to []. */
  skillsDeclared?: boolean;
  subagents: string[];
  subagentsDeclared?: boolean;
  extensions?: RecipeAgentExtensions;
  systemInstructions?: RecipeSystemInstructions;
}

type ParsedRecipeAgentDefinition = Omit<
  RecipeAgentDefinition,
  "tools" | "skills" | "skillsDeclared" | "subagents" | "subagentsDeclared"
> & {
  tools?: string[];
  skills?: string[];
  subagents?: string[];
};

export type RequiredResolvedRecipeAgentField =
  | "model.name"
  | "model.thinkingLevel"
  | "tools"
  | "skills"
  | "subagents"
  | "systemInstructions";

export const REQUIRED_RECIPE_AGENT_FIELDS: RequiredResolvedRecipeAgentField[] = [
  "model.name",
  "model.thinkingLevel",
  "tools",
  "skills",
  "subagents",
  "systemInstructions",
];

export interface RecipeAgentValidationFinding {
  agentName: string;
  field: "name" | "from" | "file" | "mcp" | RequiredResolvedRecipeAgentField;
  code?: string;
  severity?: "error" | "warning";
  message: string;
}

interface RecipeAgentSource {
  fallbackName: string;
  explicitName: boolean;
  definition: ParsedRecipeAgentDefinition;
}

const AGENT_YAML_KEYS = new Set([
  "name",
  "from",
  "description",
  "model",
  "tools",
  "mcp",
  "connectors",
  "skills",
  "subagents",
  "extensions",
  "system_instructions",
  "systemInstructions",
  "prompt",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function modelProjection(config: RecipeAgentModelConfig | undefined):
  | {
      name?: string;
      thinkingLevel?: string;
    }
  | undefined {
  if (!config) return undefined;
  if (!config.name && !config.thinkingLevel) return undefined;
  return {
    ...(config.name ? { name: config.name } : {}),
    ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
  };
}

function parseSystemInstructions(
  data: Record<string, unknown>
): RecipeSystemInstructions | undefined {
  const raw = asRecord(data.system_instructions ?? data.systemInstructions);
  if (Object.hasOwn(raw, "content") && typeof raw.content === "string") {
    const mode = raw.mode === "replace" ? "replace" : "append";
    return { mode, content: raw.content.trim() };
  }
  const prompt = typeof data.prompt === "string" ? data.prompt.trim() : "";
  return prompt ? { mode: "append", content: prompt } : undefined;
}

function parseExtensions(data: Record<string, unknown>): RecipeAgentExtensions | undefined {
  const raw = asRecord(data.extensions);
  const extensions: RecipeAgentExtensions = {};
  if (Object.hasOwn(raw, "include")) extensions.include = stringArray(raw.include);
  if (Object.hasOwn(raw, "exclude")) extensions.exclude = stringArray(raw.exclude);
  return extensions.include || extensions.exclude ? extensions : undefined;
}

function parseMcp(data: Record<string, unknown>): RecipeAgentMcp | undefined {
  if (!Object.hasOwn(data, "mcp")) return undefined;
  const raw = asRecord(data.mcp);
  const mcp: RecipeAgentMcp = {};
  for (const [serverId, value] of Object.entries(raw)) {
    const selectors = asRecord(value);
    mcp[serverId] = {
      ...(Object.hasOwn(selectors, "include")
        ? { include: stringArray(selectors.include) }
        : {}),
      ...(Object.hasOwn(selectors, "exclude")
        ? { exclude: stringArray(selectors.exclude) }
        : {}),
    };
  }
  return mcp;
}

function mergeMcp(
  base: RecipeAgentMcp | undefined,
  child: RecipeAgentMcp | undefined
): RecipeAgentMcp | undefined {
  if (!base) return child;
  if (!child) return base;
  const merged: RecipeAgentMcp = { ...base };
  for (const [serverId, childServer] of Object.entries(child)) {
    const baseServer = base[serverId];
    merged[serverId] = {
      ...(baseServer?.include !== undefined ? { include: baseServer.include } : {}),
      ...(baseServer?.exclude !== undefined ? { exclude: baseServer.exclude } : {}),
      ...(childServer.include !== undefined ? { include: childServer.include } : {}),
      ...(childServer.exclude !== undefined ? { exclude: childServer.exclude } : {}),
    };
  }
  return merged;
}

function parseConnectors(
  data: Record<string, unknown>
): RecipeAgentConnectors | undefined {
  if (!Object.hasOwn(data, "connectors")) return undefined;
  const raw = asRecord(data.connectors);
  const connectors: RecipeAgentConnectors = {};
  for (const [connectorId, value] of Object.entries(raw)) {
    const selectors = asRecord(value);
    const approvalPolicy = selectors.approval_policy ?? selectors.approvalPolicy;
    connectors[connectorId] = {
      ...(typeof selectors.subject === "string"
        ? { subject: selectors.subject }
        : {}),
      ...(Object.hasOwn(selectors, "scopes")
        ? { scopes: stringArray(selectors.scopes) }
        : {}),
      ...(typeof approvalPolicy === "string" ? { approvalPolicy } : {}),
    };
  }
  return connectors;
}

function mergeConnectors(
  base: RecipeAgentConnectors | undefined,
  child: RecipeAgentConnectors | undefined
): RecipeAgentConnectors | undefined {
  if (!base) return child;
  if (!child) return base;
  const merged: RecipeAgentConnectors = { ...base };
  for (const [connectorId, childSel] of Object.entries(child)) {
    const baseSel = base[connectorId];
    merged[connectorId] = {
      ...(baseSel?.subject !== undefined ? { subject: baseSel.subject } : {}),
      ...(baseSel?.scopes !== undefined ? { scopes: baseSel.scopes } : {}),
      ...(baseSel?.approvalPolicy !== undefined
        ? { approvalPolicy: baseSel.approvalPolicy }
        : {}),
      ...(childSel.subject !== undefined ? { subject: childSel.subject } : {}),
      ...(childSel.scopes !== undefined ? { scopes: childSel.scopes } : {}),
      ...(childSel.approvalPolicy !== undefined
        ? { approvalPolicy: childSel.approvalPolicy }
        : {}),
    };
  }
  return merged;
}

function readYaml(path: string): Record<string, unknown> {
  return asRecord(parse(readFileSync(path, "utf8")));
}

function recipeManifest(recipeDir: string) {
  try {
    return readPiPackageManifest(recipeDir);
  } catch (err) {
    if (err instanceof RecipePackageError) return null;
    throw err;
  }
}

function yamlFilesFromPaths(paths: string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const stats = statSync(path);
    if (stats.isFile() && /\.ya?ml$/i.test(path)) {
      files.push(path);
      continue;
    }
    if (!stats.isDirectory()) continue;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
      files.push(join(path, entry.name));
    }
  }
  return files.sort();
}

function recipeAgentFiles(recipeDir: string): string[] {
  const manifest = recipeManifest(recipeDir);
  if (manifest) return yamlFilesFromPaths(packageResourcePaths(manifest, "agents"));
  return yamlFilesFromPaths([join(recipeDir, "agents")]);
}

function readRecipeAgentSources(
  recipeDir: string,
  opts: { onInvalidFile?: (path: string, error: Error) => void } = {}
): RecipeAgentSource[] {
  const sources: RecipeAgentSource[] = [];
  for (const path of recipeAgentFiles(recipeDir)) {
    const data = readYaml(path);
    const fallbackName = basename(path).replace(/\.ya?ml$/i, "");
    const explicitName = typeof data.name === "string" && Boolean(data.name.trim());
    const name = explicitName ? (data.name as string).trim() : fallbackName;

    const unknownKeys = Object.keys(data).filter((key) => !AGENT_YAML_KEYS.has(key));
    if (unknownKeys.length > 0) {
      opts.onInvalidFile?.(
        path,
        new Error(`Agent YAML at ${path} has unsupported key(s): ${unknownKeys.join(", ")}`)
      );
      continue;
    }

    let modelConfig: RecipeAgentModelConfig | undefined;
    try {
      modelConfig = parseRecipeAgentModelConfig(`Agent YAML at ${path}`, data.model);
    } catch (err) {
      if (!(err instanceof RecipeModelConfigError)) throw err;
      opts.onInvalidFile?.(path, err);
      continue;
    }

    sources.push({
      fallbackName,
      explicitName,
      definition: {
        name,
        from: typeof data.from === "string" && data.from.trim() ? data.from.trim() : undefined,
        description:
          typeof data.description === "string" ? data.description : undefined,
        model: modelProjection(modelConfig),
        modelConfig,
        tools: Object.hasOwn(data, "tools") ? stringArray(data.tools) : undefined,
        mcp: parseMcp(data),
        connectors: parseConnectors(data),
        skills: Object.hasOwn(data, "skills") ? stringArray(data.skills) : undefined,
        subagents: Object.hasOwn(data, "subagents") ? stringArray(data.subagents) : undefined,
        extensions: parseExtensions(data),
        systemInstructions: parseSystemInstructions(data),
      },
    });
  }
  return sources;
}

export function loadRecipeAgentDefinitions(
  recipeDir: string
): Map<string, RecipeAgentDefinition> {
  const rawDefinitions = new Map<string, ParsedRecipeAgentDefinition>();
  const aliases = new Map<string, string>();
  const resolvedDefinitions = new Map<string, RecipeAgentDefinition>();
  const definitions = new Map<string, RecipeAgentDefinition>();

  const sources = readRecipeAgentSources(recipeDir, {
    onInvalidFile: (path, error) => {
      console.warn(`[pi-recipes] skipping ${path}: ${error.message}`);
    },
  });
  for (const source of sources) {
    rawDefinitions.set(source.definition.name, source.definition);
    aliases.set(source.fallbackName, source.definition.name);
  }

  function resolveName(name: string): string {
    return rawDefinitions.has(name) ? name : aliases.get(name) ?? name;
  }

  function mergeExtensions(
    base: RecipeAgentExtensions | undefined,
    child: RecipeAgentExtensions | undefined
  ): RecipeAgentExtensions | undefined {
    if (!base) return child;
    if (!child) return base;
    return {
      ...(base.include ? { include: base.include } : {}),
      ...(base.exclude ? { exclude: base.exclude } : {}),
      ...(child.include ? { include: child.include } : {}),
      ...(child.exclude ? { exclude: child.exclude } : {}),
    };
  }

  function resolveDefinition(
    name: string,
    stack: string[] = []
  ): RecipeAgentDefinition | undefined {
    const resolvedName = resolveName(name);
    if (resolvedDefinitions.has(resolvedName)) return resolvedDefinitions.get(resolvedName);
    if (stack.includes(resolvedName)) return undefined;
    const raw = rawDefinitions.get(resolvedName);
    if (!raw) return undefined;

    const base = raw.from
      ? resolveDefinition(raw.from, [...stack, resolvedName])
      : undefined;
    if (raw.from && !base) return undefined;

    const modelConfig = mergeRecipeAgentModelConfig(
      base?.modelConfig,
      raw.modelConfig
    );
    const definition: RecipeAgentDefinition = {
      name: raw.name,
      ...(raw.from ? { from: raw.from } : {}),
      description: raw.description ?? base?.description,
      model: modelProjection(modelConfig),
      ...(modelConfig ? { modelConfig } : {}),
      tools: raw.tools ?? base?.tools ?? [],
      mcp: mergeMcp(base?.mcp, raw.mcp),
      connectors: mergeConnectors(base?.connectors, raw.connectors),
      skills: raw.skills ?? base?.skills ?? [],
      subagents: raw.subagents ?? base?.subagents ?? [],
      skillsDeclared: raw.skills !== undefined || base?.skillsDeclared === true,
      subagentsDeclared: raw.subagents !== undefined || base?.subagentsDeclared === true,
      extensions: mergeExtensions(base?.extensions, raw.extensions),
      systemInstructions: raw.systemInstructions ?? base?.systemInstructions,
    };
    resolvedDefinitions.set(resolvedName, definition);
    return definition;
  }

  for (const name of rawDefinitions.keys()) {
    const definition = resolveDefinition(name);
    if (!definition) {
      console.warn(
        `[pi-recipes] skipping agent "${name}": ${fromChainSkipReason(
          name,
          rawDefinitions,
          resolveName
        )}`
      );
      continue;
    }
    definitions.set(name, definition);
  }
  for (const [alias, name] of aliases) {
    if (definitions.has(alias)) continue;
    const definition = definitions.get(name);
    if (definition) definitions.set(alias, definition);
  }

  return definitions;
}

/** Explain why an agent's from: chain failed to resolve (cycle or missing base). */
function fromChainSkipReason(
  name: string,
  rawDefinitions: Map<string, ParsedRecipeAgentDefinition>,
  resolveName: (name: string) => string
): string {
  const stack: string[] = [];
  let current = resolveName(name);
  for (;;) {
    const raw = rawDefinitions.get(current);
    if (!raw?.from) return "from: chain failed to resolve";
    const next = resolveName(raw.from);
    if (!rawDefinitions.has(next)) {
      return `from: "${raw.from}" does not exist in the recipe`;
    }
    if (stack.includes(next) || next === current) {
      return `from: cycle detected (${[...stack, current, next].join(" -> ")})`;
    }
    stack.push(current);
    current = next;
  }
}

function recipeAgentFieldProvided(
  definition: ParsedRecipeAgentDefinition,
  field: RequiredResolvedRecipeAgentField
): boolean {
  if (field === "model.name") return Boolean(definition.model?.name);
  if (field === "model.thinkingLevel") return Boolean(definition.model?.thinkingLevel);
  if (field === "tools") return definition.tools !== undefined;
  if (field === "skills") return definition.skills !== undefined;
  if (field === "subagents") return definition.subagents !== undefined;
  return definition.systemInstructions !== undefined;
}

export function validateResolvedRecipeAgentDefinition(opts: {
  recipeDir: string;
  agentName: string;
  requireExplicitName?: boolean;
  requiredFields?: RequiredResolvedRecipeAgentField[];
}): RecipeAgentValidationFinding[] {
  const rawDefinitions = new Map<string, ParsedRecipeAgentDefinition>();
  const aliases = new Map<string, string>();
  const explicitNames = new Map<string, boolean>();
  for (const source of readRecipeAgentSources(opts.recipeDir)) {
    rawDefinitions.set(source.definition.name, source.definition);
    aliases.set(source.fallbackName, source.definition.name);
    explicitNames.set(source.definition.name, source.explicitName);
  }

  function resolveName(name: string): string {
    return rawDefinitions.has(name) ? name : aliases.get(name) ?? name;
  }

  function inheritanceFinding(
    name: string,
    stack: string[] = []
  ): RecipeAgentValidationFinding | undefined {
    const resolvedName = resolveName(name);
    const definition = rawDefinitions.get(resolvedName);
    if (!definition) {
      return {
        agentName: resolvedName,
        field: "from",
        message: `Recipe agent "${resolvedName}" was not found`,
      };
    }
    if (!definition.from) return undefined;

    const resolvedFrom = resolveName(definition.from);
    if (stack.includes(resolvedFrom)) {
      return {
        agentName: resolvedName,
        field: "from",
        message: `Recipe agent "${resolvedName}" has cyclic from chain: ${[
          ...stack,
          resolvedName,
          resolvedFrom,
        ].join(" -> ")}`,
      };
    }
    if (!rawDefinitions.has(resolvedFrom)) {
      return {
        agentName: resolvedName,
        field: "from",
        message: `Recipe agent "${resolvedName}" inherits from missing agent "${definition.from}"`,
      };
    }
    return inheritanceFinding(definition.from, [...stack, resolvedName]);
  }

  function resolvedFieldProvided(
    name: string,
    field: RequiredResolvedRecipeAgentField,
    stack: string[] = []
  ): boolean {
    const resolvedName = resolveName(name);
    if (stack.includes(resolvedName)) return false;
    const definition = rawDefinitions.get(resolvedName);
    if (!definition) return false;
    if (recipeAgentFieldProvided(definition, field)) return true;
    return definition.from
      ? resolvedFieldProvided(definition.from, field, [...stack, resolvedName])
      : false;
  }

  function resolvedTools(
    name: string,
    stack: string[] = []
  ): string[] | undefined {
    const resolvedName = resolveName(name);
    if (stack.includes(resolvedName)) return undefined;
    const definition = rawDefinitions.get(resolvedName);
    if (!definition) return undefined;
    if (definition.tools !== undefined) return definition.tools;
    return definition.from
      ? resolvedTools(definition.from, [...stack, resolvedName])
      : undefined;
  }

  function resolvedMcp(
    name: string,
    stack: string[] = []
  ): RecipeAgentMcp | undefined {
    const resolvedName = resolveName(name);
    if (stack.includes(resolvedName)) return undefined;
    const definition = rawDefinitions.get(resolvedName);
    if (!definition) return undefined;
    const base = definition.from
      ? resolvedMcp(definition.from, [...stack, resolvedName])
      : undefined;
    return mergeMcp(base, definition.mcp);
  }

  const agentName = resolveName(opts.agentName);
  const findings: RecipeAgentValidationFinding[] = [];
  if (opts.requireExplicitName && explicitNames.get(agentName) !== true) {
    findings.push({
      agentName,
      field: "name",
      message: `Recipe agent "${agentName}" must declare name`,
    });
  }

  const inheritance = inheritanceFinding(agentName);
  if (inheritance) findings.push(inheritance);

  for (const field of opts.requiredFields ?? []) {
    if (resolvedFieldProvided(agentName, field)) continue;
    findings.push({
      agentName,
      field,
      message: `Recipe agent "${agentName}" must declare ${field} directly or inherit it with from`,
    });
  }

  const mcp = resolvedMcp(agentName);
  const manifest = recipeManifest(opts.recipeDir);
  const packageMcpServers = manifest
    ? new Map(
        manifest.mcp.servers.map((server) => [
          normalizeMcpServerId(server.id),
          server.tools,
        ])
      )
    : undefined;
  const rawMcp = rawDefinitions.get(agentName)?.mcp;
  const invalidMcpPolicy = Boolean(rawMcp && Object.keys(rawMcp).length === 0) ||
    Object.entries(mcp ?? {}).some(([serverId, selection]) => {
      if (!serverId.trim() || !isValidRecipeMcpToolSelection(selection)) {
        return true;
      }
      if (!packageMcpServers) return false;
      const packageSelection = packageMcpServers.get(normalizeMcpServerId(serverId));
      if (!packageSelection) return true;
      return (selection.include ?? []).some((toolName) => {
        const value = toolName.trim();
        return value !== "*" && !mcpSelectionAllowsTool(packageSelection, value);
      });
    });
  if (invalidMcpPolicy) {
    findings.push({
      agentName,
      field: "mcp",
      code: "mcp_invalid",
      message: `Recipe agent "${agentName}" has an invalid MCP policy; run recipes check for details`,
    });
  }

  return findings;
}

function isValidRecipeModelSpec(spec: string): boolean {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return false;
  const provider = spec.slice(0, slash);
  return !/[\s:]/.test(provider);
}

function validateRecipeAgentModelSpecs(
  sources: RecipeAgentSource[]
): RecipeAgentValidationFinding[] {
  const findings: RecipeAgentValidationFinding[] = [];
  for (const source of sources) {
    const spec = source.definition.model?.name;
    if (!spec || isValidRecipeModelSpec(spec)) continue;
    findings.push({
      agentName: source.definition.name,
      field: "model.name",
      message: `Recipe agent "${source.definition.name}" has invalid model.name "${spec}" - expected "<provider>/<model_id>"`,
    });
  }
  return findings;
}

function validateRecipeAgentNames(
  sources: RecipeAgentSource[]
): RecipeAgentValidationFinding[] {
  const findings: RecipeAgentValidationFinding[] = [];
  const explicitNameCounts = new Map<string, number>();
  const explicitNames = new Set<string>();

  for (const source of sources) {
    if (!source.explicitName) continue;
    explicitNames.add(source.definition.name);
    explicitNameCounts.set(
      source.definition.name,
      (explicitNameCounts.get(source.definition.name) ?? 0) + 1
    );
  }

  for (const [name, count] of explicitNameCounts) {
    if (count <= 1) continue;
    findings.push({
      agentName: name,
      field: "name",
      message: `Recipe agent name "${name}" is declared by multiple files`,
    });
  }

  for (const source of sources) {
    if (
      source.fallbackName === source.definition.name ||
      !explicitNames.has(source.fallbackName)
    ) {
      continue;
    }
    findings.push({
      agentName: source.definition.name,
      field: "name",
      message: `Recipe agent file alias "${source.fallbackName}" conflicts with an explicit agent name`,
    });
  }

  return findings;
}

export function validateRecipeAgentDefinitions(recipeDir: string): RecipeAgentValidationFinding[] {
  const invalidFileFindings: RecipeAgentValidationFinding[] = [];
  const sources = readRecipeAgentSources(recipeDir, {
    onInvalidFile: (path, error) => {
      invalidFileFindings.push({
        agentName: basename(path).replace(/\.ya?ml$/i, ""),
        field: "file",
        message: error.message,
      });
    },
  });
  const agentNames = [...new Set(sources.map((source) => source.definition.name))].sort();
  return [
    ...invalidFileFindings,
    ...validateRecipeAgentNames(sources),
    ...validateRecipeAgentModelSpecs(sources),
    ...agentNames.flatMap((agentName) =>
      validateResolvedRecipeAgentDefinition({
        recipeDir,
        agentName,
        requireExplicitName: true,
        requiredFields: REQUIRED_RECIPE_AGENT_FIELDS,
      })
    ),
  ];
}

export function resolveRecipeAgentName(opts: {
  recipeDir: string;
  agentName?: string;
}): string {
  if (opts.agentName?.trim()) return opts.agentName.trim();
  const definitions = loadRecipeAgentDefinitions(opts.recipeDir);
  const defaultAgent = definitions.get("agent");
  if (defaultAgent) return defaultAgent.name;
  const uniqueNames = [
    ...new Set([...definitions.values()].map((definition) => definition.name)),
  ];
  if (uniqueNames.length === 1) return uniqueNames[0]!;
  if (uniqueNames.length === 0) return "agent";
  throw new Error(
    "Recipe has multiple agents and no default entrypoint; add agents/agent.yaml or set PI_AGENT_NAME"
  );
}

export function resolveRecipeAgentDefinition(opts: {
  recipeDir: string;
  agentName?: string;
}): {
  agentName: string;
  agent: RecipeAgentDefinition | null;
} {
  const agentName = resolveRecipeAgentName(opts);
  const agent = loadRecipeAgentDefinitions(opts.recipeDir).get(agentName) ?? null;
  return { agentName, agent };
}

export function loadRecipeSystemPrompt(recipeDir: string): string | undefined {
  const path = join(recipeDir, "SYSTEM.md");
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, "utf8").trim();
  return content || undefined;
}
