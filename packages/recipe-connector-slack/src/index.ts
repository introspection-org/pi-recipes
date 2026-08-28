export {
  SlackBotSession,
  type SlackApiResult,
  type SlackBotSessionOptions,
  type SlackFetch,
  type SlackHttpResponse,
  type SlackPostResult,
} from "./client.js";
export {
  SLACK_CONNECTOR_TOOL_IDS,
  slackConnectorToolName,
} from "./catalog.js";
export type { SlackConnectorToolId } from "./catalog.js";
export { MAX_SLACK_FILE_BYTES, SlackFileSession } from "./files.js";
export type {
  SlackDownloadResult,
  SlackFileSessionOptions,
  SlackFileVariant,
} from "./files.js";
export { slackMessageBody, toPlainText } from "./format.js";
export type { SlackMessageBody } from "./format.js";
export { resolveSlackOrigin, slackDownloadRoot } from "./origin.js";
export type { SlackEnv, SlackOrigin } from "./origin.js";
export { registerSlackBotTools } from "./tools.js";
export type { RegisterSlackBotToolsOptions } from "./tools.js";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import {
  SLACK_CONNECTOR_TOOL_IDS,
  type SlackConnectorToolId,
} from "./catalog.js";
import { registerSlackBotTools } from "./tools.js";

export interface SlackRecipeConnectorModuleOptions {
  tools: readonly string[];
  loadout: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

const slackToolIds = new Set<string>(SLACK_CONNECTOR_TOOL_IDS);

export const slackRecipeConnectorModule = {
  provider: "slack",
  toolIds: SLACK_CONNECTOR_TOOL_IDS,
  createExtension(
    options: SlackRecipeConnectorModuleOptions
  ): ExtensionFactory {
    const unknown = options.tools.filter((tool) => !slackToolIds.has(tool));
    if (unknown.length > 0) {
      throw new Error(`Unknown Slack connector tool(s): ${unknown.join(", ")}`);
    }
    const tools = options.tools as readonly SlackConnectorToolId[];
    return (pi) => registerSlackBotTools(pi, {
      tools,
      loadout: options.loadout,
      env: options.env,
      cwd: options.cwd,
    });
  },
};

export default slackRecipeConnectorModule;
