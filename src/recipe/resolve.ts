import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { basename, extname, relative, resolve } from "node:path";
import { executableRecipeToolNames } from "../mcp.js";
import {
  loadRecipeAgentDefinitions,
  loadRecipeSystemPrompt,
  validateRecipeAgentDefinitions,
  type RecipeAgentDefinition,
  type RecipeSystemInstructions,
} from "../recipe-agent.js";
import type { RecipeAgentModelConfig } from "../recipe-model.js";
import {
  packageResourcePaths,
  readPiPackageManifest,
  validatePiPackageManifest,
  type PiPackageManifest,
} from "../recipe-package.js";

export interface ResolvedRecipe {
  recipeDir: string;
  manifest: PiPackageManifest;
  agentName: string;
  agent: RecipeAgentDefinition;
  subagents: ReadonlyMap<string, RecipeAgentDefinition>;
  modelSpec: string;
  modelConfig?: RecipeAgentModelConfig;
  thinkingLevel: ThinkingLevel;
  tools: string[];
  mcp: RecipeAgentDefinition["mcp"];
  skillPaths: string[];
  promptPaths: string[];
  extensionPaths: string[];
  systemPromptOverride(base: string | undefined): string | undefined;
}

export interface ResolveRecipeOptions {
  recipeDir: string;
  agentName?: string;
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
  agentName: string,
  agent: RecipeAgentDefinition
): Map<string, RecipeAgentDefinition> {
  const unique = new Map<string, RecipeAgentDefinition>();
  for (const definition of definitions.values()) {
    unique.set(definition.name, definition);
  }
  const names = agent.subagentsDeclared
    ? agent.subagents
    : [...unique.keys()].filter((name) => name !== agentName);
  return new Map(
    names.flatMap((name) => {
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

/** Resolve recipe-owned inputs for Pi's ordinary session constructors. */
export function resolveRecipe(
  opts: ResolveRecipeOptions
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

  const agentErrors = validateRecipeAgentDefinitions(recipeDir).filter(
    (finding) => finding.severity !== "warning"
  );
  if (agentErrors.length > 0) {
    throw new RecipeResolutionError(
      [
        `Recipe "${manifest.name}" has invalid agents.`,
        ...agentErrors.map((finding) => `- ${finding.message}`),
        "Add the missing fields to each agent, even if empty.",
      ].join("\n")
    );
  }

  const agents = loadRecipeAgentDefinitions(recipeDir);
  const { agentName, agent } = selectAgent(agents, opts.agentName);
  const subagents = selectSubagents(agents, agentName, agent);
  const modelSpec = agent.model?.name;
  if (!modelSpec) {
    throw new RecipeResolutionError(
      `Recipe agent "${agentName}" must declare model.name`
    );
  }
  const recipeSystemPrompt = loadRecipeSystemPrompt(recipeDir);

  return {
    recipeDir,
    manifest,
    agentName,
    agent,
    subagents,
    modelSpec,
    ...(agent.modelConfig ? { modelConfig: agent.modelConfig } : {}),
    thinkingLevel: (agent.model?.thinkingLevel ?? "low") as ThinkingLevel,
    tools: [
      ...new Set([
        ...executableRecipeToolNames(agent.tools),
        ...(subagents.size > 0 ? ["agent"] : []),
      ]),
    ],
    mcp: agent.mcp,
    skillPaths: packageResourcePaths(manifest, "skills"),
    promptPaths: packageResourcePaths(manifest, "prompts"),
    extensionPaths: selectExtensionPaths(
      recipeDir,
      packageResourcePaths(manifest, "extensions"),
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
