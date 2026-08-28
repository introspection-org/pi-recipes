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

export const SLACK_DEFAULT_TOOL_IDS: readonly SlackConnectorToolId[] = [
  "origin",
  "read_thread",
  "send_message",
];

export function slackConnectorToolName(tool: SlackConnectorToolId): string {
  return `slack_${tool}`;
}

const slackDefaultToolIds = new Set<string>(SLACK_DEFAULT_TOOL_IDS);

export const SLACK_CONNECTOR_TOOLS = SLACK_CONNECTOR_TOOL_IDS.map((id) => ({
  id,
  name: slackConnectorToolName(id),
  defaultActive: slackDefaultToolIds.has(id),
}));
