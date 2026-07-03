import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import {
  packageResourcePaths,
  readPiPackageManifest,
  RecipePackageError,
} from "./recipe-package.js";

export interface RecipeSystemInstructions {
  mode: "append" | "replace";
  content: string;
}

export interface RecipeAgentExtensions {
  include?: string[];
  exclude?: string[];
}

export interface RecipeAgentDefinition {
  name: string;
  from?: string;
  description?: string;
  model?: {
    name?: string;
    thinkingLevel?: string;
  };
  tools: string[];
  skills: string[];
  subagents: string[];
  subagentsDeclared?: boolean;
  extensions?: RecipeAgentExtensions;
  systemInstructions?: RecipeSystemInstructions;
}

type ParsedRecipeAgentDefinition = Omit<
  RecipeAgentDefinition,
  "tools" | "skills" | "subagents" | "subagentsDeclared"
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
  field: "name" | "from" | RequiredResolvedRecipeAgentField;
  message: string;
}

interface RecipeAgentSource {
  fallbackName: string;
  explicitName: boolean;
  definition: ParsedRecipeAgentDefinition;
}

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

function parseModel(data: Record<string, unknown>):
  | {
      name?: string;
      thinkingLevel?: string;
    }
  | undefined {
  const raw = asRecord(data.model);
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const thinkingLevel =
    typeof raw.thinking_level === "string"
      ? raw.thinking_level.trim()
      : typeof raw.thinkingLevel === "string"
        ? raw.thinkingLevel.trim()
        : "";
  if (!name && !thinkingLevel) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
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

function readRecipeAgentSources(recipeDir: string): RecipeAgentSource[] {
  const sources: RecipeAgentSource[] = [];
  for (const path of recipeAgentFiles(recipeDir)) {
    const data = readYaml(path);
    const fallbackName = basename(path).replace(/\.ya?ml$/i, "");
    const explicitName = typeof data.name === "string" && Boolean(data.name.trim());
    const name = explicitName ? (data.name as string).trim() : fallbackName;
    sources.push({
      fallbackName,
      explicitName,
      definition: {
        name,
        from: typeof data.from === "string" && data.from.trim() ? data.from.trim() : undefined,
        description:
          typeof data.description === "string" ? data.description : undefined,
        model: parseModel(data),
        tools: Object.hasOwn(data, "tools") ? stringArray(data.tools) : undefined,
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

  for (const source of readRecipeAgentSources(recipeDir)) {
    rawDefinitions.set(source.definition.name, source.definition);
    aliases.set(source.fallbackName, source.definition.name);
  }

  function resolveName(name: string): string {
    return rawDefinitions.has(name) ? name : aliases.get(name) ?? name;
  }

  function mergeModel(
    base: RecipeAgentDefinition["model"],
    child: RecipeAgentDefinition["model"]
  ): RecipeAgentDefinition["model"] {
    return base || child ? { ...base, ...child } : undefined;
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

    const definition: RecipeAgentDefinition = {
      name: raw.name,
      ...(raw.from ? { from: raw.from } : {}),
      description: raw.description ?? base?.description,
      model: mergeModel(base?.model, raw.model),
      tools: raw.tools ?? base?.tools ?? [],
      skills: raw.skills ?? base?.skills ?? [],
      subagents: raw.subagents ?? base?.subagents ?? [],
      subagentsDeclared: raw.subagents !== undefined || base?.subagentsDeclared === true,
      extensions: mergeExtensions(base?.extensions, raw.extensions),
      systemInstructions: raw.systemInstructions ?? base?.systemInstructions,
    };
    resolvedDefinitions.set(resolvedName, definition);
    return definition;
  }

  for (const name of rawDefinitions.keys()) {
    const definition = resolveDefinition(name);
    if (!definition) continue;
    definitions.set(name, definition);
  }
  for (const [alias, name] of aliases) {
    if (definitions.has(alias)) continue;
    const definition = definitions.get(name);
    if (definition) definitions.set(alias, definition);
  }

  return definitions;
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
  const sources = readRecipeAgentSources(recipeDir);
  const agentNames = [...new Set(sources.map((source) => source.definition.name))].sort();
  return [
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
