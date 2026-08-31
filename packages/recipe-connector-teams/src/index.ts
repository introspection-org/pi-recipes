import { createChannelConnectorModule } from "@introspection-ai/recipes/channels";

import {
  TEAMS_CHANNEL_CAPABILITIES,
  TeamsChannelAdapter,
  createTeamsChannelSession,
  teamsActivityMessage,
  teamsChannelTarget,
} from "./adapter.js";

export { TeamsBotSession } from "./client.js";
export type {
  TeamsActivity,
  TeamsBotSessionOptions,
  TeamsEnv,
  TeamsFetch,
  TeamsHttpResponse,
} from "./client.js";
export {
  TEAMS_CHANNEL_CAPABILITIES,
  TeamsChannelAdapter,
  createTeamsChannelSession,
  teamsActivityMessage,
  teamsChannelTarget,
};

/**
 * Microsoft Teams as a channel connector.
 *
 * The agent-facing surface is the same vocabulary Slack registers, minus what
 * Teams cannot do without tenant-granted Graph consent: there is no
 * `channel_read`, no `channel_react`, and no `channel_fetch_file`, because
 * those tools would fail against most tenants and a tool that reliably fails
 * is worse than one that is absent.
 *
 * A Recipe written against `channel_reply` runs on both providers unchanged.
 * A Recipe that also wants to read earlier messages will find the tool missing
 * on Teams rather than discovering the gap at runtime.
 */
export const teamsRecipeConnectorModule = createChannelConnectorModule({
  provider: "teams",
  capabilities: TEAMS_CHANNEL_CAPABILITIES,
  createSession: ({ env }) => createTeamsChannelSession({ env }),
});

export default teamsRecipeConnectorModule;
