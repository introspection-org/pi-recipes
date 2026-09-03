import { resolve } from "node:path";

export type SlackEnv = Record<string, string | undefined>;

export interface SlackOrigin {
  provider: "slack";
  channel: string;
  thread_ts: string | null;
  name?: string | null;
}

interface BootstrapChannel {
  provider?: unknown;
  conversation?: unknown;
  name?: unknown;
}

export function resolveSlackSendTarget(
  env: SlackEnv = process.env,
): SlackOrigin | null {
  const raw = env.INTROSPECTION_BOOTSTRAP_JSON?.trim();
  if (!raw) return null;
  try {
    const bootstrap = JSON.parse(raw) as { operator_channel?: BootstrapChannel };
    const target = bootstrap.operator_channel;
    if (
      target?.provider !== "slack" ||
      typeof target.conversation !== "string" ||
      !target.conversation.trim()
    ) {
      return null;
    }
    return {
      provider: "slack",
      channel: target.conversation.trim(),
      thread_ts: null,
      name: typeof target.name === "string" ? target.name : null,
    };
  } catch {
    return null;
  }
}

export function resolveSlackOrigin(
  env: SlackEnv = process.env,
): SlackOrigin | null {
  const cloudChannel = env.INTROSPECTION_TASK_CHANNEL_ID?.trim();
  if (!cloudChannel) return null;
  const provider = env.INTROSPECTION_TASK_CHANNEL_PROVIDER?.trim() || "slack";
  if (provider !== "slack") return null;
  return {
    provider: "slack",
    channel: cloudChannel,
    thread_ts: env.INTROSPECTION_TASK_THREAD_ID?.trim() || null,
  };
}

export function slackDownloadRoot(
  env: SlackEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const runtimeFiles = env.INTROSPECTION_RUNTIME_FILES_DIR?.trim();
  return resolve(runtimeFiles || resolve(cwd, "files"), "slack");
}

/**
 * The one place that decides whether this task may use Slack at all, and in
 * which mode.
 *
 * Every other decision in the package derived this independently — session
 * construction, tool registration, the prompt's `proactive` flag, and
 * `SlackBotSession.sendMessage`'s bridge check each re-read the environment and
 * re-inferred the answer. Five derivations of one fact is five chances to
 * disagree, so they all read this instead.
 *
 * `null` means the channel feature is OFF for this task: the module registers
 * no tools at all rather than tools that fail when called. That is the same
 * rule the tool catalog already follows for an unsupported capability — a tool
 * that always answers "not here" costs a model turn and teaches nothing.
 *
 * Transport is checked here, not just a destination. `SlackBotSession.request`
 * throws without `INTROSPECTION_TOKEN` and `INTROSPECTION_EGRESS_URL`, so a
 * task holding a channel id but no egress environment could previously
 * register the full tool set and then fail on the first call. Knowing a
 * destination is not the same as being able to reach it.
 */
export type SlackChannelMode =
  /** The task came from a Slack conversation; the full catalog applies. */
  | { kind: "origin"; origin: SlackOrigin }
  /**
   * No inbound conversation, but the project configured an Operator channel.
   * One top-level notification, and nothing that implies a conversation:
   * reading, reacting, editing and retracting all need a thread to act on.
   */
  | { kind: "notification"; origin: SlackOrigin };

export function resolveSlackChannelMode(
  env: SlackEnv = process.env,
): SlackChannelMode | null {
  // Transport first: without it no mode is reachable, whatever is configured.
  if (!env.INTROSPECTION_TOKEN?.trim()) return null;
  if (!env.INTROSPECTION_EGRESS_URL?.trim()) return null;

  const origin = resolveSlackOrigin(env);
  if (origin) return { kind: "origin", origin };

  const configured = resolveSlackSendTarget(env);
  if (configured) return { kind: "notification", origin: configured };

  return null;
}
