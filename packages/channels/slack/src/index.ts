import { createChannelConnectorModule } from "@introspection-ai/recipes/channels";

import {
  SLACK_CHANNEL_CAPABILITIES,
  SlackChannelAdapter,
  createSlackChannelSession,
  slackChannelTarget,
} from "./adapter.js";

export {
  SlackBotSession,
  type SlackApiResult,
  type SlackBotSessionOptions,
  type SlackFetch,
  type SlackHttpResponse,
  type SlackPostResult,
} from "./client.js";
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
export {
  SLACK_CHANNEL_CAPABILITIES,
  SlackChannelAdapter,
  createSlackChannelSession,
  slackChannelTarget,
};

/**
 * Slack as a channel connector.
 *
 * The package supplies transport and a capability descriptor; the tool names,
 * schemas, and opaque message handles come from
 * `@introspection-ai/recipes/channels`, so Slack cannot drift from any other
 * channel and cannot grow an addressing argument of its own.
 *
 * Recipes declare the neutral operation ids:
 *
 * ```json
 * { "pi": { "connectors": [{
 *   "provider": "slack",
 *   "package": "@introspection-ai/recipe-connector-slack",
 *   "tools": { "include": ["info", "reply", "history", "react", "fetch_file"] }
 * }]}}
 * ```
 *
 * Workspace-wide operations — search, directory lookups, posting to another
 * conversation — are deliberately absent. They do not correspond across
 * providers, so a neutral name would buy nothing, and they need a broader
 * grant than a task bound to one thread should carry. A Recipe that needs them
 * declares Slack's hosted MCP server under `pi.mcp.servers`, where the wider
 * reach is visible in the manifest and separately granted.
 */
export const slackRecipeConnectorModule = createChannelConnectorModule({
  provider: "slack",
  capabilities: SLACK_CHANNEL_CAPABILITIES,
  createSession: ({ env, cwd }) => createSlackChannelSession({ env, cwd }),
});

export default slackRecipeConnectorModule;
