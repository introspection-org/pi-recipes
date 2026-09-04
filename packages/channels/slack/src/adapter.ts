import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelCapabilities,
  ChannelListEntry,
  ChannelLocalFile,
  ChannelMessage,
  ChannelPostResult,
  ChannelReactionAction,
  ChannelReadPage,
  ChannelTarget,
  FileRef,
  MessageRef,
} from "@introspection-ai/recipes/channels";

import type { SlackApiResult } from "./client.js";
import { SlackFileSession } from "./files.js";
import { markdownBlocks, toPlainText } from "./format.js";
import { resolveSlackOrigin, type SlackEnv } from "./origin.js";

/**
 * What Slack's Bot API supports through the channel tool contract.
 *
 * `attach` and `documents` are false because this package does not implement
 * them yet, not because Slack cannot: `files.uploadV2` is a three-call flow and
 * canvases are a separate surface. Declaring them false is what keeps
 * `channel_attach` and `channel_post_document` from being registered at all,
 * which is the intended shape of an unimplemented capability.
 */
export const SLACK_CHANNEL_CAPABILITIES: ChannelCapabilities = {
  targeting: true,
  list: true,
  react: true,
  edit: true,
  retract: true,
  read: "channel",
  attach: false,
  fetchFile: true,
  documents: false,
  resolveAuthors: true,
  permalinks: true,
};

const SLACK_FILE_VARIANTS = new Set(["original", "video_low"]);
const SLACK_HISTORY_PAGE_LIMIT = 15;
const SLACK_CHANNEL_LIST_PAGE_LIMIT = 200;

interface SlackConversation {
  id?: string;
  name?: string;
  is_archived?: boolean;
  is_member?: boolean;
  is_private?: boolean;
}

interface SlackHistoryMessage {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  bot_profile?: {
    id?: string;
    name?: string;
  };
  thread_ts?: string;
  reply_count?: number;
  files?: Array<{
    id?: string;
    name?: string;
    mimetype?: string;
    size?: number;
  }>;
}

/** Slack's own `:emoji:` spelling is not what its reactions API accepts. */
function reactionName(emoji: string): string {
  const name = emoji.trim().replace(/^:+|:+$/g, "");
  if (!name) {
    throw new Error(
      "Slack reaction must name an emoji, such as 'eyes' or ':eyes:'.",
    );
  }
  return name;
}

function slackTimestamp(ts: string): string | undefined {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/**
 * Slack against the neutral channel contract.
 *
 * One adapter belongs to one credential session. The neutral tool layer
 * resolves the origin or explicit destination into `ctx.target`.
 *
 * User ids and permalinks are resolved here rather than exposed as lookup
 * tools: an agent that needs "who said this" wants a name in the message it is
 * already reading, not a second round trip it has to know to make.
 */
export class SlackChannelAdapter implements ChannelAdapter {
  readonly provider = "slack";
  readonly capabilities = SLACK_CHANNEL_CAPABILITIES;

  private readonly authors = new Map<string, string | undefined>();
  private readonly targets = new Map<string, ChannelTarget>();

  constructor(readonly session: SlackFileSession) {}

  async enrichTarget(ctx: ChannelAdapterContext): Promise<ChannelTarget> {
    const key = JSON.stringify([ctx.target.conversation, ctx.target.thread ?? null]);
    const cached = this.targets.get(key);
    if (cached) return cached;
    const target = {
      ...ctx.target,
      name: ctx.target.name ?? await this.channelName(ctx.target.conversation, ctx.signal),
      permalink: ctx.target.thread ? await this.permalink(ctx.target.conversation, ctx.target.thread, ctx.signal) : null,
    };
    this.targets.set(key, target);
    return target;
  }

  async reply(
    ctx: ChannelAdapterContext,
    input: { text: string },
  ): Promise<ChannelPostResult> {
    return this.post(ctx, input, true);
  }

  async send(ctx: ChannelAdapterContext, input: { text: string }): Promise<ChannelPostResult> {
    // Explicit sends do not claim platform follow-up routing. The existing
    // bridge is origin-bound and must be refactored separately.
    return this.post(ctx, input, false);
  }

  private async post(ctx: ChannelAdapterContext, input: { text: string }, recordBridge: boolean): Promise<ChannelPostResult> {
    const posted = await this.session.sendMessage(
      {
        text: input.text,
        record_bridge: recordBridge,
        // The trusted context, not the session's own view of the origin: the
        // two agree under the connector module, and where they would not, the
        // context is the one every other tool acted on.
        to: { channel: ctx.target.conversation, thread_ts: ctx.target.thread },
      },
      ctx.signal,
    );
    let permalink: string | null = null;
    try {
      permalink = await this.permalink(posted.channel, posted.ts, ctx.signal);
    } catch {
      // Posting is irreversible. Cancellation during this optional lookup must
      // not report the post as failed and invite the caller to send it again.
    }
    const ref = ctx.refs.message({
      conversation: posted.channel,
      id: posted.ts,
      thread: posted.thread_ts,
      authoredByAgent: true,
      ...(permalink ? { permalink } : {}),
    });
    return {
      ref,
      target: { provider: this.provider, conversation: posted.channel, thread: posted.thread_ts },
      ...(permalink ? { permalink } : {}),
      bridge_recorded: posted.bridge_recorded,
      ...(posted.bridge_error ? { bridge_error: posted.bridge_error } : {}),
    };
  }

  async react(
    ctx: ChannelAdapterContext,
    input: {
      ref: MessageRef;
      emoji: string;
      action: ChannelReactionAction;
    },
  ): Promise<void> {
    const message = ctx.refs.resolveMessage(input.ref);
    await this.session.call(
      input.action === "remove" ? "reactions.remove" : "reactions.add",
      {
        channel: message.conversation,
        timestamp: message.id,
        name: reactionName(input.emoji),
      },
      "form",
      ctx.signal,
    );
  }

  async edit(
    ctx: ChannelAdapterContext,
    input: { ref: MessageRef; text: string },
  ): Promise<ChannelPostResult> {
    const message = ctx.refs.resolveAuthored(input.ref);
    await this.session.call(
      "chat.update",
      {
        channel: message.conversation,
        ts: message.id,
        text: toPlainText(input.text),
        blocks: markdownBlocks(input.text),
      },
      "json",
      ctx.signal,
    );
    return {
      ref: input.ref,
      ...(message.permalink ? { permalink: message.permalink } : {}),
    };
  }

  async retract(
    ctx: ChannelAdapterContext,
    input: { ref: MessageRef },
  ): Promise<void> {
    const message = ctx.refs.resolveAuthored(input.ref);
    await this.session.call(
      "chat.delete",
      { channel: message.conversation, ts: message.id },
      "form",
      ctx.signal,
    );
  }

  async list(signal?: AbortSignal): Promise<readonly ChannelListEntry[]> {
    const channels: ChannelListEntry[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    do {
      const payload = await this.session.call(
        "conversations.list",
        {
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: SLACK_CHANNEL_LIST_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        },
        "form",
        signal,
      );
      const conversations = Array.isArray(payload.channels)
        ? (payload.channels as SlackConversation[])
        : [];
      for (const conversation of conversations) {
        if (
          typeof conversation.id !== "string" ||
          typeof conversation.name !== "string" ||
          conversation.is_archived === true ||
          conversation.is_member !== true ||
          seenIds.has(conversation.id)
        ) {
          continue;
        }
        seenIds.add(conversation.id);
        channels.push({
          id: conversation.id,
          name: conversation.name,
          kind: conversation.is_private
            ? "private_channel"
            : "public_channel",
        });
      }

      const next = nextCursor(payload);
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    } while (cursor);

    return channels;
  }

  async read(
    ctx: ChannelAdapterContext,
    input: { limit?: number; cursor?: string },
  ): Promise<ChannelReadPage> {
    const thread = ctx.target.thread;
    const limit = Math.min(
      input.limit ?? SLACK_HISTORY_PAGE_LIMIT,
      SLACK_HISTORY_PAGE_LIMIT,
    );
    // Exactly one history request per page. Threads page forward; channel
    // timelines page backward. Never scan a whole thread for a small read.
    const payload = await this.session.call(
      thread ? "conversations.replies" : "conversations.history",
      {
        channel: ctx.target.conversation,
        ...(thread ? { ts: thread } : {}),
        limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      "form",
      ctx.signal,
    );
    const raw = messagesFrom(payload);
    if (!thread) raw.reverse();
    const next = nextCursor(payload);
    // `conversations.replies` returns oldest-first, `conversations.history`
    // newest-first. The tool promises one order for both, so the unthreaded
    // arm is reversed here rather than left for the model to notice — a
    // silently backwards transcript reads as a plausible conversation and
    // inverts every summary drawn from it.
    const messages: ChannelMessage[] = [];
    for (const message of raw) {
      if (!message.ts) continue;
      const permalink = await this.permalink(
        ctx.target.conversation,
        message.ts,
        ctx.signal,
      );
      messages.push({
        ref: ctx.refs.message({
          conversation: ctx.target.conversation,
          id: message.ts,
          thread: message.thread_ts ?? thread ?? message.ts,
        }),
        author: {
          id:
            message.user ??
            message.bot_profile?.id ??
            message.bot_id ??
            "unknown",
          ...(message.user
            ? { display_name: await this.authorName(message.user, ctx.signal) }
            : message.bot_profile?.name?.trim()
              ? { display_name: message.bot_profile.name.trim() }
              : {}),
        },
        text: message.text ?? "",
        thread_id: message.thread_ts ?? thread ?? message.ts,
        ...(typeof message.reply_count === "number" ? { reply_count: message.reply_count } : {}),
        ...(slackTimestamp(message.ts)
          ? { timestamp: slackTimestamp(message.ts) }
          : {}),
        ...(permalink ? { permalink } : {}),
        ...(message.files?.length
          ? {
              attachments: message.files
                .filter((file) => file.id)
                .map((file) => ({
                  // Minted, not passed through: `channel_fetch_file` resolves
                  // this handle back to the provider id, so a file id the
                  // model invents (or reads out of injected content) names
                  // nothing observed through this credential session.
                  id: ctx.refs.file({
                    conversation: ctx.target.conversation,
                    thread: ctx.target.thread,
                    id: file.id!,
                  }),
                  ...(file.name ? { name: file.name } : {}),
                  ...(file.mimetype ? { mime_type: file.mimetype } : {}),
                  ...(typeof file.size === "number" ? { size: file.size } : {}),
                })),
            }
          : {}),
      });
    }
    return {
      messages,
      target: ctx.target,
      next_direction: thread ? "newer" : "older",
      ...(next ? { cursor: ctx.refs.cursor(next) } : {}),
    };
  }

  async fetchFile(
    ctx: ChannelAdapterContext,
    input: { file: FileRef; variant?: string },
  ): Promise<ChannelLocalFile> {
    if (input.variant && !SLACK_FILE_VARIANTS.has(input.variant)) {
      throw new Error(
        `Unknown Slack file variant '${input.variant}'. Use 'original' or 'video_low'.`,
      );
    }
    // Only files previously observed in this credential session resolve.
    const file = ctx.refs.resolveFile(input.file);
    return await this.session.downloadFile(
      {
        file_id: file.id,
        variant: input.variant as "original" | "video_low" | undefined,
      },
      ctx.signal,
    );
  }

  /** Best effort: a missing permalink is worth less than a failed tool call. */
  private async permalink(
    channel: string,
    ts: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    try {
      const payload = await this.session.call(
        "chat.getPermalink",
        { channel, message_ts: ts },
        "form",
        signal,
      );
      const link = payload.permalink;
      return typeof link === "string" ? link : null;
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  }

  private async authorName(
    user: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (this.authors.has(user)) return this.authors.get(user);
    let name: string | undefined;
    try {
      const payload = await this.session.call(
        "users.info",
        { user },
        "form",
        signal,
      );
      const profile = payload.user as
        | { real_name?: string; name?: string; profile?: { display_name?: string } }
        | undefined;
      name =
        profile?.profile?.display_name?.trim() ||
        profile?.real_name?.trim() ||
        profile?.name?.trim() ||
        undefined;
    } catch (error) {
      if (signal?.aborted) throw error;
      name = undefined;
    }
    this.authors.set(user, name);
    return name;
  }

  private async channelName(
    channel: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    try {
      const payload = await this.session.call(
        "conversations.info",
        { channel },
        "form",
        signal,
      );
      const conversation = payload.channel as
        | { name?: string; name_normalized?: string }
        | undefined;
      return (
        conversation?.name?.trim() ||
        conversation?.name_normalized?.trim() ||
        null
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  }
}

function nextCursor(payload: SlackApiResult): string | undefined {
  const metadata = payload.response_metadata as
    | { next_cursor?: string }
    | undefined;
  const cursor = metadata?.next_cursor?.trim();
  return cursor ? cursor : undefined;
}

function messagesFrom(payload: SlackApiResult): SlackHistoryMessage[] {
  return Array.isArray(payload.messages)
    ? (payload.messages as SlackHistoryMessage[])
    : [];
}

/** Resolve the bound conversation for a session, or explain why there is none. */
export function slackChannelTarget(env: SlackEnv): ChannelTarget {
  const origin = resolveSlackOrigin(env);
  if (!origin) {
    throw new Error(
      "No Slack origin is configured. Cloud tasks supply one automatically. For introspection local, set SLACK_CHANNEL_ID and optionally SLACK_THREAD_TS.",
    );
  }
  return {
    provider: "slack",
    conversation: origin.channel,
    thread: origin.thread_ts,
  };
}

export function createSlackChannelSession(options: {
  env?: SlackEnv;
  cwd?: string;
  session?: SlackFileSession;
}): { adapter: SlackChannelAdapter; target: () => ChannelTarget } {
  const env = options.env ?? process.env;
  const session =
    options.session ??
    new SlackFileSession({ env, cwd: options.cwd ?? process.cwd() });
  return {
    adapter: new SlackChannelAdapter(session),
    // Resolved per call: a Recipe that declares Slack can still run from an
    // automation trigger, where the tools error rather than the session.
    target: () => slackChannelTarget(env),
  };
}
