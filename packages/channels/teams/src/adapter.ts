import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelCapabilities,
  ChannelMessage,
  ChannelPostResult,
  ChannelTarget,
  MessageRef,
} from "@introspection-ai/recipes/channels";

import { TeamsBotSession, type TeamsActivity, type TeamsEnv } from "./client.js";

/**
 * What Teams supports through the bound-conversation contract.
 *
 * The differences from Slack are the point of having a second adapter:
 *
 * - **`read` is false.** Reading a Teams conversation needs Microsoft Graph
 *   with resource-specific consent granted by the tenant admin; the Bot
 *   Connector a bot always has cannot read back. Rather than register a tool
 *   that fails against most tenants, the capability is false and
 *   `channel_read` is simply absent. The agent works from the turn it was
 *   given. A tenant-specific build can flip this once RSC is proven.
 * - **`permalinks` is false.** A Teams message link comes from the Graph
 *   `webUrl`, which is behind the same consent.
 * - **`resolveAuthors` is true and free** — Teams puts the display name on the
 *   activity, so no lookup is needed at all.
 * - **`fetchFile` is false** — inbound Teams files are Graph `hostedContents`
 *   or SharePoint links, again consent-gated, and unlike Slack there is no
 *   single bot-token download path.
 */
export const TEAMS_CHANNEL_CAPABILITIES: ChannelCapabilities = {
  react: false,
  read: false,
  attach: false,
  fetchFile: false,
  documents: false,
  resolveAuthors: true,
  permalinks: false,
};

/**
 * Microsoft Teams against the neutral channel contract.
 *
 * Teams threads a reply by posting into the conversation the activity came
 * from; the conversation id is the binding, and `replyToId` keeps the reply
 * under the right root. As with Slack, none of that is reachable from model
 * input.
 */
export class TeamsChannelAdapter implements ChannelAdapter {
  readonly provider = "teams";
  readonly capabilities = TEAMS_CHANNEL_CAPABILITIES;

  constructor(readonly session: TeamsBotSession) {}

  private activitiesUrl(conversation: string): string {
    return `${this.session.serviceUrl()}/v3/conversations/${encodeURIComponent(conversation)}/activities`;
  }

  async reply(
    ctx: ChannelAdapterContext,
    input: { text: string },
  ): Promise<ChannelPostResult> {
    const thread = ctx.target.thread ?? undefined;
    const activity = (await this.session.call(
      thread
        ? `${this.activitiesUrl(ctx.target.conversation)}/${encodeURIComponent(thread)}`
        : this.activitiesUrl(ctx.target.conversation),
      {
        method: "POST",
        body: {
          type: "message",
          // Teams renders a subset of Markdown natively, which is why the
          // neutral content type is Markdown rather than a block vocabulary
          // that would have to be translated per provider.
          textFormat: "markdown",
          text: input.text,
          ...(thread ? { replyToId: thread } : {}),
        },
        signal: ctx.signal,
      },
    )) as { id?: string };
    if (!activity.id) {
      throw new Error("Teams returned no activity id for the posted message");
    }
    const ref = ctx.refs.message({
      conversation: ctx.target.conversation,
      id: activity.id,
      thread: thread ?? activity.id,
    });

    let bridgeRecorded = false;
    let bridgeError: string | undefined;
    try {
      bridgeRecorded = await this.session.recordPosted(
        {
          provider: "teams",
          channel: ctx.target.conversation,
          ts: activity.id,
          thread_ts: thread ?? activity.id,
        },
        ctx.signal,
      );
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      bridgeError = error instanceof Error ? error.message : String(error);
    }
    return {
      ref,
      bridge_recorded: bridgeRecorded,
      ...(bridgeError ? { bridge_error: bridgeError } : {}),
    };
  }

}

/** Shape an inbound activity into the neutral message form, for host use. */
export function teamsActivityMessage(
  activity: TeamsActivity,
  ref: MessageRef,
): ChannelMessage {
  return {
    ref,
    author: {
      id: activity.from?.id ?? "unknown",
      ...(activity.from?.name ? { display_name: activity.from.name } : {}),
    },
    text: activity.text ?? "",
    ...(activity.timestamp ? { timestamp: activity.timestamp } : {}),
    // Teams attachments are Graph hosted content or SharePoint links. Do not
    // expose those URLs as file references. This adapter declares fetchFile as
    // unsupported, so attachments stay absent until it can mint and resolve an
    // opaque reference backed by a real download path.
  };
}

export function teamsChannelTarget(env: TeamsEnv): ChannelTarget {
  const conversation =
    env.INTROSPECTION_TASK_CHANNEL_ID?.trim() || env.TEAMS_CONVERSATION_ID?.trim();
  const provider = env.INTROSPECTION_TASK_CHANNEL_PROVIDER?.trim();
  if (provider && provider !== "teams") {
    throw new Error(
      `This task's channel origin is '${provider}', not Teams. A Recipe declares one channel provider per task origin.`,
    );
  }
  if (!conversation) {
    throw new Error(
      "No Teams conversation is configured. Cloud tasks supply one automatically. For a local run, set TEAMS_CONVERSATION_ID and TEAMS_SERVICE_URL.",
    );
  }
  return {
    provider: "teams",
    conversation,
    thread:
      env.INTROSPECTION_TASK_THREAD_ID?.trim() ||
      env.TEAMS_ACTIVITY_ID?.trim() ||
      null,
  };
}

export function createTeamsChannelSession(options: {
  env?: TeamsEnv;
  session?: TeamsBotSession;
}): { adapter: TeamsChannelAdapter; target: () => ChannelTarget } {
  const env = options.env ?? process.env;
  const session = options.session ?? new TeamsBotSession({ env });
  return {
    adapter: new TeamsChannelAdapter(session),
    target: () => teamsChannelTarget(env),
  };
}
