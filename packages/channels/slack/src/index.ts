import { createChannelConnectorModule } from "@introspection-ai/recipes/channels";

import {
  SLACK_CHANNEL_CAPABILITIES,
  SlackChannelAdapter,
  createSlackChannelSession,
  slackChannelTarget,
  slackSendTarget,
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
export {
  resolveSlackOrigin,
  resolveSlackSendTarget,
  slackDownloadRoot,
} from "./origin.js";
export type { SlackEnv, SlackOrigin } from "./origin.js";
export {
  SLACK_CHANNEL_CAPABILITIES,
  SlackChannelAdapter,
  createSlackChannelSession,
  slackChannelTarget,
  slackSendTarget,
};

/**
 * Slack as a channel connector.
 *
 * The package supplies transport and a capability descriptor; the tool names,
 * schemas, and opaque message handles come from
 * `@introspection-ai/recipes/channels`, so Slack cannot drift from any other
 * channel and cannot grow an addressing argument of its own.
 *
 * Recipes declare the provider. Each agent then selects complete tool names in
 * its YAML file.
 *
 * ```json
 * { "pi": { "connectors": [{ "provider": "slack" }] } }
 * ```
 *
 * ```yaml
 * tools: [channel_reply, channel_read, channel_react, channel_fetch_file]
 * ```
 *
 * Operations outside the bound inbound and proactive targets, including
 * workspace search, directory lookups, and arbitrary cross-channel posting,
 * are unsupported.
 * A separate proposal can define their contract and access model.
 */
export const slackRecipeConnectorModule = createChannelConnectorModule({
  provider: "slack",
  capabilities: SLACK_CHANNEL_CAPABILITIES,
  createSession: ({ env, cwd }) => createSlackChannelSession({ env, cwd }),
});

export default slackRecipeConnectorModule;
