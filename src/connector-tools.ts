import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { RecipePackageManifest } from "./recipe-package.js";
import {
  SLACK_CONNECTOR_TOOL_IDS,
  SLACK_DEFAULT_TOOL_IDS,
  SLACK_LOAD_TOOLS_NAME,
  slackConnectorToolName,
  type SlackConnectorToolId,
} from "./slack/catalog.js";
import { registerSlackBotTools } from "./slack/tools.js";

export interface RecipeConnectorExtension {
  owner: string;
  factory: ExtensionFactory;
}

export interface RecipeConnectorExtensionOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RecipeConnectorToolLoadout {
  toolNames: string[];
  initialActiveToolNames: string[];
  loadToolName?: string;
}

const slackToolIds = new Set<string>(SLACK_CONNECTOR_TOOL_IDS);

function selectedSlackToolIds(
  manifest: RecipePackageManifest,
  agentTools: readonly string[]
): SlackConnectorToolId[] {
  const connector = manifest.connectors.find(
    (entry) => entry.provider === "slack"
  );
  return (connector?.tools.include ?? []).filter(
    (tool): tool is SlackConnectorToolId =>
      slackToolIds.has(tool) &&
      agentTools.includes(slackConnectorToolName(tool as SlackConnectorToolId))
  );
}

export function declaredRecipeConnectorToolNames(
  manifest: RecipePackageManifest
): ReadonlySet<string> {
  return new Set(
    manifest.connectors.flatMap((connector) =>
      connector.provider === "slack"
        ? connector.tools.include
            .filter((tool) => slackToolIds.has(tool))
            .map((tool) => slackConnectorToolName(tool as SlackConnectorToolId))
        : []
    )
  );
}

export function recipeConnectorExtensions(
  manifest: RecipePackageManifest,
  agentTools: readonly string[],
  options: RecipeConnectorExtensionOptions = {}
): RecipeConnectorExtension[] {
  return manifest.connectors.flatMap((connector) => {
    if (connector.provider !== "slack") {
      throw new Error(
        `Recipe connector provider is unsupported: ${connector.provider}`
      );
    }
    const tools = selectedSlackToolIds(manifest, agentTools);
    return [{
      owner: `<connector:${connector.provider}>`,
      factory: (pi) => registerSlackBotTools(pi, {
        tools,
        loadout: true,
        ...options,
      }),
    }];
  });
}

export function recipeConnectorToolLoadout(
  manifest: RecipePackageManifest,
  agentTools: readonly string[]
): RecipeConnectorToolLoadout {
  const toolNames = selectedSlackToolIds(manifest, agentTools).map(
    slackConnectorToolName
  );
  const initialActiveToolNames = SLACK_DEFAULT_TOOL_IDS
    .map(slackConnectorToolName)
    .filter((name) => toolNames.includes(name));
  const hasOptional = toolNames.some(
    (name) => !initialActiveToolNames.includes(name)
  );
  return {
    toolNames,
    initialActiveToolNames,
    ...(hasOptional ? { loadToolName: SLACK_LOAD_TOOLS_NAME } : {}),
  };
}
