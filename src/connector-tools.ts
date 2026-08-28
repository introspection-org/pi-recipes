import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { RecipePackageManifest } from "./recipe-package.js";
import {
  SLACK_CONNECTOR_TOOL_IDS,
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

const slackToolIds = new Set<string>(SLACK_CONNECTOR_TOOL_IDS);

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
  options: RecipeConnectorExtensionOptions = {}
): RecipeConnectorExtension[] {
  return manifest.connectors.map((connector) => {
    if (connector.provider !== "slack") {
      throw new Error(
        `Recipe connector provider is unsupported: ${connector.provider}`
      );
    }
    const tools = connector.tools.include.filter((tool) =>
      slackToolIds.has(tool)
    ) as SlackConnectorToolId[];
    return {
      owner: `<connector:${connector.provider}>`,
      factory: (pi) => registerSlackBotTools(pi, { tools, ...options }),
    };
  });
}
