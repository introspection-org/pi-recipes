import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { realpathSync, statSync } from "node:fs";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { executableRecipeToolNames } from "../mcp-policy.js";
import {
  loadValidatedRecipeAgentDefinitions,
  loadRecipeSystemPrompt,
  type RecipeAgentDefinition,
  type RecipeAgentMcp,
  type RecipeAgentMcpMode,
  type RecipeSystemInstructions,
} from "../recipe-agent.js";
import type { RecipeAgentModelConfig } from "../recipe-model.js";
import { resolveAgentSkillPaths } from "../recipe-skills.js";
import {
  packageResourcePaths,
  readPiPackageManifest,
  validatePiPackageManifest,
  type PiPackageManifest,
} from "../recipe-package.js";

export type { RecipePackageManifest } from "../recipe-package.js";
export type { RecipeAgentMcp } from "../recipe-agent.js";

export interface ResolvedRecipeAgentMcp
  extends Omit<RecipeAgentMcp, "mode"> {
  mode: RecipeAgentMcpMode;
}

export interface ResolvedRecipeAgent {
  readonly recipeDir: string;
  readonly manifest: PiPackageManifest;
  readonly name: string;
  readonly definition: RecipeAgentDefinition;
  readonly subagents: ReadonlyMap<string, RecipeAgentDefinition>;
  readonly modelSpec: string;
  readonly modelConfig?: RecipeAgentModelConfig;
  readonly thinkingLevel?: ThinkingLevel;
  readonly tools: readonly string[];
  readonly mcp?: ResolvedRecipeAgentMcp;
  readonly skillPaths: readonly string[];
  readonly promptPaths: readonly string[];
  readonly extensionPaths: readonly string[];
  systemPromptOverride(base: string | undefined): string | undefined;
}

export interface ResolveRecipeAgentOptions {
  recipeDir: string;
  agentName?: string;
}

/**
 * One parsed Recipe package with every agent compiled into an executable plan.
 *
 * Hosts should keep this snapshot for the lifetime of a materialized Recipe and
 * select root/child sessions from it instead of reparsing YAML per session.
 */
export interface ResolvedRecipe {
  readonly recipeDir: string;
  readonly manifest: PiPackageManifest;
  /** Stable authored names are the only agent identifiers. */
  readonly agents: ReadonlyMap<string, ResolvedRecipeAgent>;
  selectAgent(agentName?: string): ResolvedRecipeAgent;
}

export class RecipeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeResolutionError";
  }
}

const LOADABLE_EXTENSION_SUFFIXES = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

function validatePackageExtensionPaths(
  recipeDir: string,
  paths: readonly string[]
): void {
  const realRecipeDir = realpathSync(recipeDir);
  for (const path of paths) {
    const realPath = realpathSync(path);
    const relativePath = relative(realRecipeDir, realPath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new RecipeResolutionError(
        `Recipe extension resolves outside the package: ${path}`
      );
    }
    if (!statSync(realPath).isFile()) {
      throw new RecipeResolutionError(
        `Recipe extension is not a file: ${path}`
      );
    }
    if (
      !LOADABLE_EXTENSION_SUFFIXES.some((suffix) =>
        realPath.toLowerCase().endsWith(suffix)
      )
    ) {
      throw new RecipeResolutionError(
        `Recipe extension is not a loadable module: ${path}`
      );
    }
  }
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }
  const object = value as object;
  if (seen.has(object) || object instanceof Map || object instanceof Set) {
    return value;
  }
  seen.add(object);
  for (const child of Object.values(object)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function readonlyMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const map = new Map(source);
  let facade: ReadonlyMap<K, V>;
  facade = new Proxy(map, {
    get(target, property) {
      if (
        property === "set" ||
        property === "delete" ||
        property === "clear"
      ) {
        return () => {
          throw new TypeError("Resolved Recipe maps are immutable");
        };
      }
      if (property === "forEach") {
        return (
          callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
          thisArg?: unknown
        ) => {
          target.forEach((value, key) =>
            callback.call(thisArg, value, key, facade)
          );
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ReadonlyMap<K, V>;
  return facade;
}

function applySystemInstructions(
  base: string | undefined,
  instructions: RecipeSystemInstructions | undefined
): string | undefined {
  if (!instructions) return base;
  if (instructions.mode === "replace") return instructions.content;
  return [base, instructions.content].filter(Boolean).join("\n\n");
}

function selectAgent(
  definitions: ReadonlyMap<string, RecipeAgentDefinition>,
  requestedName: string | undefined
): { agentName: string; agent: RecipeAgentDefinition } {
  const selectedName = requestedName?.trim();
  if (selectedName) {
    const agent = definitions.get(selectedName);
    if (agent) return { agentName: agent.name, agent };
    throw new RecipeResolutionError(
      `Recipe agent "${selectedName}" was not found`
    );
  }

  const defaultAgent = definitions.get("agent");
  if (defaultAgent) return { agentName: defaultAgent.name, agent: defaultAgent };

  const uniqueAgents = new Map<string, RecipeAgentDefinition>();
  for (const definition of definitions.values()) {
    uniqueAgents.set(definition.name, definition);
  }
  if (uniqueAgents.size === 1) {
    const agent = uniqueAgents.values().next().value!;
    return { agentName: agent.name, agent };
  }
  if (uniqueAgents.size === 0) {
    throw new RecipeResolutionError("Recipe has no agents");
  }
  throw new RecipeResolutionError(
    'Recipe has multiple agents and no default entrypoint; declare an agent named "agent" or select one explicitly'
  );
}

function selectSubagents(
  definitions: ReadonlyMap<string, RecipeAgentDefinition>,
  agent: RecipeAgentDefinition
): Map<string, RecipeAgentDefinition> {
  const selected = new Map<string, RecipeAgentDefinition>();
  for (const name of agent.subagents) {
    const definition = definitions.get(name);
    if (!definition) {
      throw new RecipeResolutionError(
        `Recipe agent "${agent.name}" references missing subagent "${name}"`
      );
    }
    selected.set(definition.name, definition);
  }
  return selected;
}

function buildResolvedRecipeAgent(
  recipeDir: string,
  manifest: PiPackageManifest,
  definitions: ReadonlyMap<string, RecipeAgentDefinition>,
  agent: RecipeAgentDefinition,
  recipeSystemPrompt: string | undefined,
  skillResourcePaths: string[],
  promptPaths: string[],
  extensionPaths: string[]
): ResolvedRecipeAgent {
  const agentName = agent.name;
  const subagents = readonlyMap(selectSubagents(definitions, agent));
  const modelSpec = agent.model?.name;
  if (!modelSpec) {
    throw new RecipeResolutionError(
      `Recipe agent "${agentName}" must declare model.name`
    );
  }

  const skillPaths = resolveAgentSkillPaths(
    recipeDir,
    skillResourcePaths,
    agent.skills
  );
  for (const skill of agent.skills) {
    const matches = resolveAgentSkillPaths(recipeDir, skillResourcePaths, [
      skill,
    ]);
    if (matches.length === 0) {
      throw new RecipeResolutionError(
        `Recipe agent "${agentName}" references missing packaged skill "${skill}"`
      );
    }
    if (matches.length > 1) {
      throw new RecipeResolutionError(
        `Recipe agent "${agentName}" skill "${skill}" resolves to multiple packaged SKILL.md files`
      );
    }
  }

  return deepFreeze({
    recipeDir,
    manifest,
    name: agentName,
    definition: agent,
    subagents,
    modelSpec,
    ...(agent.modelConfig ? { modelConfig: agent.modelConfig } : {}),
    ...(agent.model?.thinkingLevel
      ? { thinkingLevel: agent.model.thinkingLevel as ThinkingLevel }
      : {}),
    tools: [
      ...new Set(executableRecipeToolNames(agent.tools)),
    ],
    ...(agent.mcp
      ? { mcp: { ...agent.mcp, mode: agent.mcp.mode ?? "cli" } }
      : {}),
    skillPaths,
    promptPaths,
    extensionPaths: [...extensionPaths],
    systemPromptOverride(base) {
      return applySystemInstructions(
        recipeSystemPrompt ?? base,
        agent.systemInstructions
      );
    },
  });
}

/** Parse and resolve every agent in a Recipe package exactly once. */
export function resolveRecipe(
  opts: Pick<ResolveRecipeAgentOptions, "recipeDir">
): ResolvedRecipe {
  const recipeDir = resolve(opts.recipeDir);
  const manifest = deepFreeze(readPiPackageManifest(recipeDir));
  const packageErrors = validatePiPackageManifest(manifest).findings;
  if (packageErrors.length > 0) {
    throw new RecipeResolutionError(
      packageErrors.map((finding) => finding.message).join("\n")
    );
  }

  const resolvedAgents = loadValidatedRecipeAgentDefinitions(recipeDir);
  const agentErrors = resolvedAgents.findings;
  if (agentErrors.length > 0) {
    throw new RecipeResolutionError(
      [
        `Recipe "${manifest.name}" has invalid agents.`,
        ...agentErrors.map((finding) => `- ${finding.message}`),
        "Fix the invalid agent definitions.",
      ].join("\n")
    );
  }

  const definitions = resolvedAgents.definitions;
  if (definitions.size === 0) {
    throw new RecipeResolutionError(
      `Recipe "${manifest.name}" does not define any agents`
    );
  }
  for (const definition of definitions.values()) {
    deepFreeze(definition);
  }
  const recipeSystemPrompt = loadRecipeSystemPrompt(recipeDir);
  const skillResourcePaths = packageResourcePaths(manifest, "skills");
  const promptPaths = packageResourcePaths(manifest, "prompts");
  const extensionPaths = packageResourcePaths(manifest, "extensions");
  validatePackageExtensionPaths(recipeDir, extensionPaths);
  const canonical = new Map<string, ResolvedRecipeAgent>();
  const agents = new Map<string, ResolvedRecipeAgent>();
  for (const [key, definition] of definitions) {
    let resolvedAgent = canonical.get(definition.name);
    if (!resolvedAgent) {
      resolvedAgent = buildResolvedRecipeAgent(
        recipeDir,
        manifest,
        definitions,
        definition,
        recipeSystemPrompt,
        skillResourcePaths,
        promptPaths,
        extensionPaths
      );
      canonical.set(definition.name, resolvedAgent);
    }
    agents.set(key, resolvedAgent);
    agents.set(definition.name, resolvedAgent);
  }

  const readonlyAgents = readonlyMap(agents);
  return deepFreeze({
    recipeDir,
    manifest,
    agents: readonlyAgents,
    selectAgent(agentName) {
      const selected = selectAgent(definitions, agentName);
      return agents.get(selected.agentName)!;
    },
  });
}

/** Resolve recipe-owned inputs for one Pi session. */
export function resolveRecipeAgent(
  opts: ResolveRecipeAgentOptions
): ResolvedRecipeAgent {
  return resolveRecipe({ recipeDir: opts.recipeDir }).selectAgent(opts.agentName);
}
