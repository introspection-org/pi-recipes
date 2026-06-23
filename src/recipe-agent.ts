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
  if (!content) {
    const prompt = typeof data.prompt === "string" ? data.prompt.trim() : "";
    return prompt ? { mode: "append", content: prompt } : undefined;
  }
  const mode = raw.mode === "replace" ? "replace" : "append";
  return { mode, content };
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

export function loadRecipeAgentDefinitions(
  recipeDir: string
): Map<string, RecipeAgentDefinition> {
  const definitions = new Map<string, RecipeAgentDefinition>();

  for (const path of recipeAgentFiles(recipeDir)) {
    const data = readYaml(path);
    const fallbackName = basename(path).replace(/\.ya?ml$/i, "");
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

export function resolveRecipeAgentName(opts: {
  recipeDir: string;
  agentName?: string;
}): string {
  if (opts.agentName?.trim()) return opts.agentName.trim();
  const manifest = recipeManifest(opts.recipeDir);
  if (manifest?.entrypoint) return manifest.entrypoint;
  const definitions = loadRecipeAgentDefinitions(opts.recipeDir);
  if (definitions.has("agent")) return "agent";
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
