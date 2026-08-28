import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  SLACK_CONNECTOR_TOOL_IDS,
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
}

/**
 * Host methods used by the Slack tools. The register argument stays opaque so
 * supported Pi versions do not expose different TypeBox copies at this package
 * boundary.
 */
export interface SlackToolHost {
  registerTool(...args: never[]): unknown;
}

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
  const host = pi as unknown as ExtensionAPI;
  const session =
    options.session ??
    new SlackFileSession({
      env: options.env ?? process.env,
      cwd: options.cwd ?? process.cwd(),
    });
  const enabled = new Set(
    (options.tools ?? SLACK_CONNECTOR_TOOL_IDS).map(slackConnectorToolName)
  );
  const register = (tool: SlackConnectorToolId, add: () => void) => {
    if (enabled.has(slackConnectorToolName(tool))) add();
  };

  register("origin", () => host.registerTool({
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

  register("send_message", () => host.registerTool({
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

  register("react", () => host.registerTool({
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

  register("read_thread", () => host.registerTool({
    name: "slack_read_thread",
    label: "Read Slack thread",
    description:
      "Read a Slack thread. Channel and thread default to this task's origin.",
    parameters: Type.Object(
      {
        channel: Type.Optional(Type.String({ minLength: 1 })),
        thread_ts: Type.Optional(Type.String({ minLength: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        cursor: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const origin =
        params.channel && params.thread_ts ? null : session.origin();
      const channel = params.channel ?? origin?.channel;
      const threadTs = params.thread_ts ?? origin?.thread_ts;
      if (!threadTs) {
        throw new Error(
          "This Slack origin has no thread timestamp. Use slack_read_history for this conversation.",
        );
      }
      return toolResult(
        await session.call("conversations.replies", {
          channel,
          ts: threadTs,
          limit: params.limit ?? 50,
          ...(params.cursor ? { cursor: params.cursor } : {}),
        }),
      );
    },
  }));

  register("read_history", () => host.registerTool({
    name: "slack_read_history",
    label: "Read Slack history",
    description:
      "Read recent messages from a channel the bot can access. The channel defaults to this task's origin.",
    parameters: Type.Object(
      {
        channel: Type.Optional(Type.String({ minLength: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        oldest: Type.Optional(Type.String({ minLength: 1 })),
        cursor: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const channel = params.channel ?? session.origin().channel;
      return toolResult(
        await session.call("conversations.history", {
          channel,
          limit: params.limit ?? 50,
          ...(params.oldest ? { oldest: params.oldest } : {}),
          ...(params.cursor ? { cursor: params.cursor } : {}),
        }),
      );
    },
  }));

  register("list_channels", () => host.registerTool({
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

  register("join_channel", () => host.registerTool({
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

  register("resolve_user", () => host.registerTool({
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

  register("get_permalink", () => host.registerTool({
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
      const channel = params.channel ?? session.origin().channel;
      return toolResult(
        await session.call("chat.getPermalink", {
          channel,
          message_ts: params.message_ts,
        }),
      );
    },
  }));

  register("download_file", () => host.registerTool({
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
