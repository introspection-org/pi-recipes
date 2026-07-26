import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { basename, extname, relative, resolve } from "node:path";
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
  recipeDir: string;
  manifest: PiPackageManifest;
  name: string;
  definition: RecipeAgentDefinition;
  subagents: ReadonlyMap<string, RecipeAgentDefinition>;
  modelSpec: string;
  modelConfig?: RecipeAgentModelConfig;
  thinkingLevel?: ThinkingLevel;
  tools: string[];
  mcp?: ResolvedRecipeAgentMcp;
  skillPaths: string[];
  promptPaths: string[];
  extensionPaths: string[];
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
  recipeDir: string;
  manifest: PiPackageManifest;
  /** Canonical names and authored aliases both resolve to the same plan. */
  agents: ReadonlyMap<string, ResolvedRecipeAgent>;
  selectAgent(agentName?: string): ResolvedRecipeAgent;
}

export class RecipeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeResolutionError";
  }
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
    "Recipe has multiple agents and no default entrypoint; add agents/agent.yaml or select an agent"
  );
}

function selectSubagents(
  definitions: ReadonlyMap<string, RecipeAgentDefinition>,
  agent: RecipeAgentDefinition
): Map<string, RecipeAgentDefinition> {
  return new Map(
    agent.subagents.flatMap((name) => {
      const definition = definitions.get(name);
      return definition ? [[definition.name, definition] as const] : [];
    })
  );
}

function normalizeSelector(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.[^/.]+$/, "");
}

function extensionSelectorSet(
  recipeDir: string,
  extensionPath: string
): Set<string> {
  const relativePath = relative(recipeDir, extensionPath).replace(/\\/g, "/");
  const withoutExtension = normalizeSelector(relativePath);
  const base = basename(extensionPath, extname(extensionPath));
  const parts = withoutExtension.split("/");
  const parent = parts.length > 1 ? parts.at(-2) : undefined;
  return new Set(
    [
      relativePath,
      withoutExtension,
      base,
      parent && base === "index" ? parent : undefined,
    ].filter((value): value is string => Boolean(value))
  );
}

function extensionSelectorMatches(
  recipeDir: string,
  extensionPath: string,
  selector: string
): boolean {
  const normalized = normalizeSelector(selector.trim());
  if (!normalized) return false;
  return normalized === "*" || extensionSelectorSet(recipeDir, extensionPath).has(normalized);
}

function selectExtensionPaths(
  recipeDir: string,
  extensionPaths: string[],
  agent: RecipeAgentDefinition
): string[] {
  const include = agent.extensions?.include;
  const exclude = agent.extensions?.exclude ?? [];
  return extensionPaths.filter((extensionPath) => {
    const included =
      include === undefined ||
      include.some((selector) =>
        extensionSelectorMatches(recipeDir, extensionPath, selector)
      );
    return (
      included &&
      !exclude.some((selector) =>
        extensionSelectorMatches(recipeDir, extensionPath, selector)
      )
    );
  });
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
  const subagents = selectSubagents(definitions, agent);
  const modelSpec = agent.model?.name;
  if (!modelSpec) {
    throw new RecipeResolutionError(
      `Recipe agent "${agentName}" must declare model.name`
    );
  }

  return {
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
      ...new Set([
        ...executableRecipeToolNames(agent.tools),
        ...(subagents.size > 0 ? ["agent"] : []),
      ]),
    ],
    ...(agent.mcp
      ? { mcp: { ...agent.mcp, mode: agent.mcp.mode ?? "cli" } }
      : {}),
    skillPaths: resolveAgentSkillPaths(
      recipeDir,
      skillResourcePaths,
      agent.skills
    ),
    promptPaths,
    extensionPaths: selectExtensionPaths(
      recipeDir,
      extensionPaths,
      agent
    ),
    systemPromptOverride(base) {
      return applySystemInstructions(
        recipeSystemPrompt ?? base,
        agent.systemInstructions
      );
    },
  };
}

/** Parse and resolve every agent in a Recipe package exactly once. */
export function resolveRecipe(
  opts: Pick<ResolveRecipeAgentOptions, "recipeDir">
): ResolvedRecipe {
  const recipeDir = resolve(opts.recipeDir);
  const manifest = readPiPackageManifest(recipeDir);
  const packageErrors = validatePiPackageManifest(manifest).findings.filter(
    (finding) => finding.severity === "error"
  );
  if (packageErrors.length > 0) {
    throw new RecipeResolutionError(
      packageErrors.map((finding) => finding.message).join("\n")
    );
  }

  const resolvedAgents = loadValidatedRecipeAgentDefinitions(recipeDir);
  const agentErrors = resolvedAgents.findings.filter(
    (finding) => finding.severity !== "warning"
  );
  if (agentErrors.length > 0) {
    throw new RecipeResolutionError(
      [
        `Recipe "${manifest.name}" has invalid agents.`,
        ...agentErrors.map((finding) => `- ${finding.message}`),
        "Add the missing required fields to each agent.",
      ].join("\n")
    );
  }

  const definitions = resolvedAgents.definitions;
  const recipeSystemPrompt = loadRecipeSystemPrompt(recipeDir);
  const skillResourcePaths = packageResourcePaths(manifest, "skills");
  const promptPaths = packageResourcePaths(manifest, "prompts");
  const extensionPaths = packageResourcePaths(manifest, "extensions");
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

  return {
    recipeDir,
    manifest,
    agents,
    selectAgent(agentName) {
      const selected = selectAgent(definitions, agentName);
      return agents.get(selected.agentName)!;
    },
  };
}

/** Resolve recipe-owned inputs for one Pi session. */
export function resolveRecipeAgent(
  opts: ResolveRecipeAgentOptions
): ResolvedRecipeAgent {
  return resolveRecipe({ recipeDir: opts.recipeDir }).selectAgent(opts.agentName);
}
