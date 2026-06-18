import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export interface RecipeSystemInstructions {
  mode: "append" | "replace";
  content: string;
}

export interface RecipeAgentDefinition {
  name: string;
  description?: string;
  model?: {
    name?: string;
    thinkingLevel?: string;
  };
  tools: string[];
  skills: string[];
  subagents: string[];
  systemInstructions?: RecipeSystemInstructions;
}

export interface RecipeProfileDefinition {
  name: string;
  entrypoint: string;
  model?: {
    name?: string;
    thinkingLevel?: string;
  };
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
  const content = typeof raw.content === "string" ? raw.content.trim() : "";
  if (!content) return undefined;
  const mode = raw.mode === "replace" ? "replace" : "append";
  return { mode, content };
}

function readYaml(path: string): Record<string, unknown> {
  return asRecord(parse(readFileSync(path, "utf8")));
}

export function loadRecipeAgentDefinitions(
  recipeDir: string
): Map<string, RecipeAgentDefinition> {
  const agentsDir = join(recipeDir, "agents");
  const definitions = new Map<string, RecipeAgentDefinition>();
  if (!existsSync(agentsDir)) return definitions;

  for (const entry of readdirSync(agentsDir)) {
    if (!/\.ya?ml$/i.test(entry)) continue;
    const path = join(agentsDir, entry);
    const data = readYaml(path);
    const fallbackName = entry.replace(/\.ya?ml$/i, "");
    const name =
      typeof data.name === "string" && data.name.trim()
        ? data.name.trim()
        : fallbackName;
    const definition: RecipeAgentDefinition = {
      name,
      description:
        typeof data.description === "string" ? data.description : undefined,
      model: parseModel(data),
      tools: stringArray(data.tools),
      skills: stringArray(data.skills),
      subagents: stringArray(data.subagents),
      systemInstructions: parseSystemInstructions(data),
    };
    definitions.set(name, definition);
    if (fallbackName !== name) definitions.set(fallbackName, definition);
  }

  return definitions;
}

export function loadRecipeProfile(
  recipeDir: string,
  profileName?: string
): RecipeProfileDefinition | null {
  const name = profileName?.trim();
  if (!name) return null;
  const path = join(recipeDir, "profiles", `${name}.yaml`);
  if (!existsSync(path)) return null;
  const data = readYaml(path);
  const entrypoint =
    typeof data.entrypoint === "string" && data.entrypoint.trim()
      ? data.entrypoint.trim()
      : "agent";
  return {
    name:
      typeof data.name === "string" && data.name.trim()
        ? data.name.trim()
        : name,
    entrypoint,
    model: parseModel(data),
  };
}

export function resolveRecipeAgentName(opts: {
  recipeDir: string;
  profileName?: string;
  agentName?: string;
}): string {
  const profile = loadRecipeProfile(opts.recipeDir, opts.profileName);
  if (profile?.entrypoint) return profile.entrypoint;
  if (opts.agentName?.trim()) return opts.agentName.trim();
  const definitions = loadRecipeAgentDefinitions(opts.recipeDir);
  if (definitions.has("agent")) return "agent";
  const uniqueNames = [
    ...new Set([...definitions.values()].map((definition) => definition.name)),
  ];
  if (uniqueNames.length === 1) return uniqueNames[0]!;
  if (uniqueNames.length === 0) return "agent";
  throw new Error(
    "Recipe has multiple agents and no default entrypoint; add agents/agent.yaml, select a profile, or set PI_AGENT_NAME"
  );
}

export function resolveRecipeAgentDefinition(opts: {
  recipeDir: string;
  profileName?: string;
  agentName?: string;
}): {
  agentName: string;
  agent: RecipeAgentDefinition | null;
  profile: RecipeProfileDefinition | null;
} {
  const profile = loadRecipeProfile(opts.recipeDir, opts.profileName);
  const agentName = resolveRecipeAgentName(opts);
  const agent = loadRecipeAgentDefinitions(opts.recipeDir).get(agentName) ?? null;
  return { agentName, agent, profile };
}

export function loadRecipeSystemPrompt(recipeDir: string): string | undefined {
  const path = join(recipeDir, "SYSTEM.md");
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, "utf8").trim();
  return content || undefined;
}
