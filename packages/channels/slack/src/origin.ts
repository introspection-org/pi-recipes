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

function isScheduledTask(env: SlackEnv): boolean {
  const raw = env.INTROSPECTION_TASK_METADATA_JSON?.trim();
  if (!raw) return false;
  try {
    const metadata = JSON.parse(raw) as { trigger_source?: unknown };
    return metadata.trigger_source === "scheduled";
  } catch {
    return false;
  }
}

export function resolveSlackNotificationTarget(
  env: SlackEnv = process.env,
): SlackOrigin | null {
  if (!isScheduledTask(env)) return null;
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
  if (cloudChannel) {
    const provider = env.INTROSPECTION_TASK_CHANNEL_PROVIDER?.trim() || "slack";
    if (provider !== "slack") return null;
    return {
      provider: "slack",
      channel: cloudChannel,
      thread_ts: env.INTROSPECTION_TASK_THREAD_ID?.trim() || null,
    };
  }

  const localChannel = env.SLACK_CHANNEL_ID?.trim();
  if (!localChannel) return null;
  return {
    provider: "slack",
    channel: localChannel,
    thread_ts: env.SLACK_THREAD_TS?.trim() || null,
  };
}

export function slackDownloadRoot(
  env: SlackEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const runtimeFiles = env.INTROSPECTION_RUNTIME_FILES_DIR?.trim();
  return resolve(runtimeFiles || resolve(cwd, "files"), "slack");
}
