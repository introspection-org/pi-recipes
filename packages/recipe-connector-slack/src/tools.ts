import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  SLACK_CONNECTOR_TOOL_IDS,
  SLACK_DEFAULT_TOOL_IDS,
  SLACK_LOAD_TOOLS_NAME,
  slackConnectorToolName,
  type SlackConnectorToolId,
} from "./catalog.js";
import { SlackFileSession } from "./files.js";
import type { SlackEnv } from "./origin.js";

export interface RegisterSlackBotToolsOptions {
  env?: SlackEnv;
  cwd?: string;
  session?: SlackFileSession;
  tools?: readonly SlackConnectorToolId[];
  loadout?: boolean;
}

export type SlackToolHost = Pick<
  ExtensionAPI,
  "getActiveTools" | "registerTool" | "setActiveTools"
>;

function toolResult(details: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(details, null, 2) },
    ],
    details,
  };
}

export function registerSlackBotTools(
  pi: SlackToolHost,
  options: RegisterSlackBotToolsOptions = {},
): void {
  const session =
    options.session ??
    new SlackFileSession({
      env: options.env ?? process.env,
      cwd: options.cwd ?? process.cwd(),
    });
  const enabled = new Set(
    (options.tools ?? SLACK_CONNECTOR_TOOL_IDS).map(slackConnectorToolName)
  );
  const optional = [...enabled].filter(
    (name) => !SLACK_DEFAULT_TOOL_IDS.map(slackConnectorToolName).includes(name)
  );
  const register = (tool: SlackConnectorToolId, add: () => void) => {
    if (enabled.has(slackConnectorToolName(tool))) add();
  };

  if (options.loadout && optional.length > 0) {
    pi.registerTool({
      name: SLACK_LOAD_TOOLS_NAME,
      label: "Load Slack tools",
      description:
        "List and enable the optional Slack tools allowed for this agent.",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      async execute() {
        const active = new Set(pi.getActiveTools());
        for (const name of optional) active.add(name);
        pi.setActiveTools([...active]);
        return toolResult({ enabled: optional });
      },
    });
  }

  register("origin", () => pi.registerTool({
    name: "slack_origin",
    label: "Slack origin",
    description:
      "Return the Slack channel and thread that started this task. Cloud tasks provide the origin. Local runs use SLACK_CHANNEL_ID and optional SLACK_THREAD_TS.",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    async execute() {
      return toolResult(session.origin());
    },
  }));

  register("send_message", () => pi.registerTool({
    name: "slack_send_message",
    label: "Send Slack message",
    description:
      "Send a bot-authored message to this task's Slack channel. It replies in the origin thread by default. Set start_new_thread only when the recipe permits a new top-level post.",
    parameters: Type.Object(
      {
        text: Type.String({ minLength: 1 }),
        plain_text: Type.Optional(Type.String()),
        blocks: Type.Optional(Type.Array(Type.Unknown())),
        thread_ts: Type.Optional(Type.String({ minLength: 1 })),
        start_new_thread: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      return toolResult(await session.sendMessage(params));
    },
  }));

  register("react", () => pi.registerTool({
    name: "slack_react",
    label: "React in Slack",
    description:
      "Add an emoji reaction to a message in this task's Slack channel.",
    parameters: Type.Object(
      {
        message_ts: Type.String({ minLength: 1 }),
        emoji: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const origin = session.origin();
      return toolResult(
        await session.call(
          "reactions.add",
          {
            channel: origin.channel,
            timestamp: params.message_ts,
            name: params.emoji,
          },
          "json",
        ),
      );
    },
  }));

  register("read_thread", () => pi.registerTool({
    name: "slack_read_thread",
    label: "Read Slack thread",
    description:
      "Read a Slack thread. Channel and thread default to this task's origin.",
    parameters: Type.Object(
      {
        channel: Type.Optional(Type.String({ minLength: 1 })),
        thread_ts: Type.Optional(Type.String({ minLength: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const origin = session.origin();
      const threadTs = params.thread_ts || origin.thread_ts;
      if (!threadTs) {
        throw new Error(
          "This Slack origin has no thread timestamp. Use slack_read_history for this conversation.",
        );
      }
      return toolResult(
        await session.call("conversations.replies", {
          channel: params.channel || origin.channel,
          ts: threadTs,
          limit: params.limit ?? 50,
        }),
      );
    },
  }));

  register("read_history", () => pi.registerTool({
    name: "slack_read_history",
    label: "Read Slack history",
    description:
      "Read recent messages from a channel the bot can access. The channel defaults to this task's origin.",
    parameters: Type.Object(
      {
        channel: Type.Optional(Type.String({ minLength: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        oldest: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const origin = session.origin();
      return toolResult(
        await session.call("conversations.history", {
          channel: params.channel || origin.channel,
          limit: params.limit ?? 50,
          ...(params.oldest ? { oldest: params.oldest } : {}),
        }),
      );
    },
  }));

  register("list_channels", () => pi.registerTool({
    name: "slack_list_channels",
    label: "List Slack channels",
    description: "List channels visible to the installed Slack bot.",
    parameters: Type.Object(
      {
        cursor: Type.Optional(Type.String({ minLength: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      return toolResult(
        await session.call("conversations.list", {
          types: "public_channel,private_channel",
          limit: params.limit ?? 100,
          ...(params.cursor ? { cursor: params.cursor } : {}),
        }),
      );
    },
  }));

  register("join_channel", () => pi.registerTool({
    name: "slack_join_channel",
    label: "Join Slack channel",
    description: "Join a public Slack channel as the installed bot.",
    parameters: Type.Object(
      { channel: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      return toolResult(
        await session.call("conversations.join", { channel: params.channel }),
      );
    },
  }));

  register("resolve_user", () => pi.registerTool({
    name: "slack_resolve_user",
    label: "Resolve Slack user",
    description: "Read the Slack profile for one user id.",
    parameters: Type.Object(
      { user: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      return toolResult(
        await session.call("users.info", { user: params.user }),
      );
    },
  }));

  register("get_permalink", () => pi.registerTool({
    name: "slack_get_permalink",
    label: "Get Slack permalink",
    description:
      "Get a permalink for a Slack message. The channel defaults to this task's origin.",
    parameters: Type.Object(
      {
        message_ts: Type.String({ minLength: 1 }),
        channel: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const origin = session.origin();
      return toolResult(
        await session.call("chat.getPermalink", {
          channel: params.channel || origin.channel,
          message_ts: params.message_ts,
        }),
      );
    },
  }));

  register("download_file", () => pi.registerTool({
    name: "slack_download_file",
    label: "Download Slack file",
    description:
      'Download a Slack file into the task workspace. Use variant "video_low" for a smaller video rendition when Slack provides one.',
    parameters: Type.Object(
      {
        file_id: Type.String({ minLength: 1, maxLength: 100 }),
        variant: Type.Optional(
          Type.Union([Type.Literal("original"), Type.Literal("video_low")]),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      return toolResult(await session.downloadFile(params));
    },
  }));
}
