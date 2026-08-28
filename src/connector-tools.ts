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

export interface RecipeConnectorToolReference {
  readonly provider: "slack";
  readonly name: string;
  readonly id?: SlackConnectorToolId;
}

const slackToolIds = new Set<string>(SLACK_CONNECTOR_TOOL_IDS);
const connectorToolsByName = new Map<string, RecipeConnectorToolReference>([
  ...SLACK_CONNECTOR_TOOL_IDS.map((id) => {
    const name = slackConnectorToolName(id);
    return [name, { provider: "slack" as const, id, name }] as const;
  }),
  [
    SLACK_LOAD_TOOLS_NAME,
    { provider: "slack" as const, name: SLACK_LOAD_TOOLS_NAME },
  ],
]);

export function recipeConnectorToolReference(
  name: string
): RecipeConnectorToolReference | undefined {
  return connectorToolsByName.get(name);
}

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
