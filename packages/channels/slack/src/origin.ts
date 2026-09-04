import { resolve } from "node:path";

export type SlackEnv = Record<string, string | undefined>;

export interface SlackOrigin {
  provider: "slack";
  channel: string;
  thread_ts: string | null;
  name?: string | null;
}

export function hasSlackChannelAccess(
  env: SlackEnv = process.env,
): boolean {
  const raw = env.INTROSPECTION_BOOTSTRAP_JSON?.trim();
  if (!raw) return false;
  try {
    const bootstrap = JSON.parse(raw) as { channel_providers?: unknown };
    return (
      Array.isArray(bootstrap.channel_providers) &&
      bootstrap.channel_providers.includes("slack")
    );
  } catch {
    return false;
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
