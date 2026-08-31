import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { loadRecipeModule } from "./recipe-extensions.js";
import type {
  RecipePackageConnector,
  RecipePackageManifest,
} from "./recipe-package.js";

export interface RecipeConnectorToolDefinition {
  readonly id: string;
  readonly name: string;
  readonly defaultActive: boolean;
}

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
  deferredToolNames: string[];
}

export interface RecipeConnectorModuleOptions {
  tools: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RecipeConnectorModule {
  readonly provider: string;
  readonly tools: readonly RecipeConnectorToolDefinition[];
  createExtension(options: RecipeConnectorModuleOptions): ExtensionFactory;
}

export interface LoadedRecipeConnectors {
  extensions: RecipeConnectorExtension[];
  loadout: RecipeConnectorToolLoadout;
}

function connectorModuleError(
  connector: RecipePackageConnector,
  detail: string
): Error {
  return new Error(
    `Recipe connector package ${connector.package} ${detail}`
  );
}

function isConnectorToolDefinition(
  value: unknown
): value is RecipeConnectorToolDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const tool = value as Partial<RecipeConnectorToolDefinition>;
  return (
    typeof tool.id === "string" &&
    Boolean(tool.id.trim()) &&
    typeof tool.name === "string" &&
    Boolean(tool.name.trim()) &&
    typeof tool.defaultActive === "boolean"
  );
}

function parseRecipeConnectorModule(
  value: unknown,
  connector: RecipePackageConnector
): RecipeConnectorModule {
  if (!value || typeof value !== "object") {
    throw connectorModuleError(connector, "does not export a module");
  }
  const module = value as Partial<RecipeConnectorModule>;
  if (
    module.provider !== connector.provider ||
    !Array.isArray(module.tools) ||
    module.tools.length === 0 ||
    module.tools.some((tool) => !isConnectorToolDefinition(tool)) ||
    typeof module.createExtension !== "function"
  ) {
    throw connectorModuleError(connector, "has an invalid module contract");
  }
  const tools = module.tools as readonly RecipeConnectorToolDefinition[];
  const ids = tools.map((tool) => tool.id);
  const names = tools.map((tool) => tool.name);
  if (
    new Set(ids).size !== ids.length ||
    new Set(names).size !== names.length
  ) {
    throw connectorModuleError(
      connector,
      "has duplicate or conflicting tool names"
    );
  }
  return module as RecipeConnectorModule;
}

async function loadRecipeConnectorModule(
  recipeDir: string,
  connector: RecipePackageConnector
): Promise<RecipeConnectorModule> {
  let imported: unknown;
  try {
    imported = await loadRecipeModule(recipeDir, connector.package);
  } catch (error) {
    throw new Error(
      `Recipe connector '${connector.provider}' requires ${connector.package} in the Recipe dependencies`,
      { cause: error }
    );
  }
  const connectorModule =
    imported &&
    typeof imported === "object" &&
    "default" in imported
      ? imported.default
      : imported;
  return parseRecipeConnectorModule(connectorModule, connector);
}

export async function loadRecipeConnectors(
  manifest: RecipePackageManifest,
  agentTools: readonly string[],
  options: RecipeConnectorExtensionOptions
): Promise<LoadedRecipeConnectors> {
  const loaded = await Promise.all(
    (manifest.connectors ?? []).map(async (connector) => {
      const module = await loadRecipeConnectorModule(options.recipeDir, connector);
      const toolsById = new Map(
        module.tools.map((tool) => [tool.id, tool] as const)
      );
      const unsupported = connector.tools.include.filter(
        (id) => !toolsById.has(id)
      );
      if (unsupported.length > 0) {
        throw connectorModuleError(
          connector,
          `does not support declared tool(s): ${unsupported.join(", ")}`
        );
      }
      const declaredTools = connector.tools.include.map(
        (id) => toolsById.get(id)!
      );
      const declaredNames = new Set(declaredTools.map((tool) => tool.name));
      const undeclared = module.tools
        .filter(
          (tool) =>
            agentTools.includes(tool.name) && !declaredNames.has(tool.name)
        )
        .map((tool) => tool.name);
      if (undeclared.length > 0) {
        throw new Error(
          `Recipe agent selects ${connector.provider} connector tool(s) that package.json#pi.connectors does not declare: ${undeclared.join(", ")}`
        );
      }
      const selected = declaredTools.filter((tool) =>
        agentTools.includes(tool.name)
      );
      return {
        extension: {
          owner: `<connector:${connector.provider}>`,
          factory: module.createExtension({
            tools: selected.map((tool) => tool.id),
            env: options.env,
            cwd: options.cwd,
          }),
        },
        selected,
      };
    })
  );
  const selected = loaded.flatMap((connector) => connector.selected);
  const registeredNames = selected.map((tool) => tool.name);
  if (new Set(registeredNames).size !== registeredNames.length) {
    throw new Error("Recipe connector packages register duplicate tool names");
  }
  return {
    extensions: loaded.map((connector) => connector.extension),
    loadout: {
      toolNames: selected.map((tool) => tool.name),
      initialActiveToolNames: selected
        .filter((tool) => tool.defaultActive)
        .map((tool) => tool.name),
      deferredToolNames: selected
        .filter((tool) => !tool.defaultActive)
        .map((tool) => tool.name),
    },
  };
}
