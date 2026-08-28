import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import {
  recipeConnectorDefinition,
  recipeConnectorToolDefinition,
  type RecipeConnectorDefinition,
} from "./connector-catalog.js";
import type { RecipePackageManifest } from "./recipe-package.js";

export interface RecipeConnectorExtension {
  owner: string;
  factory: ExtensionFactory;
}

export interface RecipeConnectorExtensionOptions {
  recipeDir: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RecipeConnectorToolLoadout {
  toolNames: string[];
  initialActiveToolNames: string[];
  loadToolNames: string[];
}

export interface RecipeConnectorModuleOptions {
  tools: readonly string[];
  loadout: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RecipeConnectorModule {
  readonly provider: string;
  readonly toolIds: readonly string[];
  createExtension(options: RecipeConnectorModuleOptions): ExtensionFactory;
}

export function recipeConnectorToolReference(name: string) {
  return recipeConnectorToolDefinition(name);
}

function selectedConnectorToolIds(
  manifest: RecipePackageManifest,
  agentTools: readonly string[],
  definition: RecipeConnectorDefinition
): string[] {
  const connector = manifest.connectors.find(
    (entry) => entry.provider === definition.provider
  );
  const toolsById = new Map(
    definition.tools.map((tool) => [tool.id, tool] as const)
  );
  return (connector?.tools.include ?? []).filter((id) => {
    const tool = toolsById.get(id);
    return tool !== undefined && agentTools.includes(tool.name);
  });
}

export function declaredRecipeConnectorToolNames(
  manifest: RecipePackageManifest
): ReadonlySet<string> {
  return new Set(
    manifest.connectors.flatMap((connector) => {
      const definition = recipeConnectorDefinition(connector.provider);
      if (!definition) return [];
      const toolsById = new Map(
        definition.tools.map((tool) => [tool.id, tool] as const)
      );
      return connector.tools.include.flatMap((id) => {
        const tool = toolsById.get(id);
        return tool ? [tool.name] : [];
      });
    })
  );
}

function parseRecipeConnectorModule(
  value: unknown,
  definition: RecipeConnectorDefinition
): RecipeConnectorModule {
  if (!value || typeof value !== "object") {
    throw new Error(
      `Recipe connector package ${definition.packageName} does not export a module`
    );
  }
  const module = value as Partial<RecipeConnectorModule>;
  if (
    module.provider !== definition.provider ||
    !Array.isArray(module.toolIds) ||
    module.toolIds.some((tool) => typeof tool !== "string") ||
    typeof module.createExtension !== "function"
  ) {
    throw new Error(
      `Recipe connector package ${definition.packageName} has an invalid module contract`
    );
  }
  const expected = definition.tools.map((tool) => tool.id).sort();
  const actual = [...module.toolIds].sort();
  if (
    expected.length !== actual.length ||
    expected.some((tool, index) => tool !== actual[index])
  ) {
    throw new Error(
      `Recipe connector package ${definition.packageName} does not match the ${definition.provider} tool catalog`
    );
  }
  return module as RecipeConnectorModule;
}

async function loadRecipeConnectorModule(
  recipeDir: string,
  definition: RecipeConnectorDefinition
): Promise<RecipeConnectorModule> {
  const recipeRequire = createRequire(join(recipeDir, "package.json"));
  let entry: string;
  try {
    entry = recipeRequire.resolve(definition.packageName);
  } catch (error) {
    throw new Error(
      `Recipe connector '${definition.provider}' requires ${definition.packageName} in the Recipe dependencies`,
      { cause: error }
    );
  }
  const imported = await import(pathToFileURL(entry).href);
  return parseRecipeConnectorModule(imported.default, definition);
}

export async function recipeConnectorExtensions(
  manifest: RecipePackageManifest,
  agentTools: readonly string[],
  options: RecipeConnectorExtensionOptions
): Promise<RecipeConnectorExtension[]> {
  return Promise.all(
    manifest.connectors.map(async (connector) => {
      const definition = recipeConnectorDefinition(connector.provider);
      if (!definition) {
        throw new Error(
          `Recipe connector provider is unsupported: ${connector.provider}`
        );
      }
      const module = await loadRecipeConnectorModule(
        options.recipeDir,
        definition
      );
      const tools = selectedConnectorToolIds(
        manifest,
        agentTools,
        definition
      );
      return {
        owner: `<connector:${connector.provider}>`,
        factory: module.createExtension({
          tools,
          loadout: true,
          env: options.env,
          cwd: options.cwd,
        }),
      };
    })
  );
}

export function recipeConnectorToolLoadout(
  manifest: RecipePackageManifest,
  agentTools: readonly string[]
): RecipeConnectorToolLoadout {
  const selected = manifest.connectors.flatMap((connector) => {
    const definition = recipeConnectorDefinition(connector.provider);
    if (!definition) return [];
    const selectedIds = new Set(
      selectedConnectorToolIds(manifest, agentTools, definition)
    );
    return definition.tools
      .filter((tool) => selectedIds.has(tool.id))
      .map((tool) => ({ provider: definition.provider, tool }));
  });
  const loadToolNames = manifest.connectors.flatMap((connector) => {
    const definition = recipeConnectorDefinition(connector.provider);
    if (!definition?.loadToolName) return [];
    const hasOptional = selected.some(
      (entry) =>
        entry.provider === definition.provider && !entry.tool.defaultActive
    );
    return hasOptional ? [definition.loadToolName] : [];
  });
  return {
    toolNames: selected.map((entry) => entry.tool.name),
    initialActiveToolNames: selected
      .filter((entry) => entry.tool.defaultActive)
      .map((entry) => entry.tool.name),
    loadToolNames,
  };
}
