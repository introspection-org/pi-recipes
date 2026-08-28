export const SLACK_CONNECTOR_TOOL_IDS = [
  "origin",
  "send_message",
  "react",
  "read_thread",
  "read_history",
  "list_channels",
  "join_channel",
  "resolve_user",
  "get_permalink",
  "download_file",
] as const;

export type SlackConnectorToolId =
  (typeof SLACK_CONNECTOR_TOOL_IDS)[number];

export function slackConnectorToolName(tool: SlackConnectorToolId): string {
  return `slack_${tool}`;
}
