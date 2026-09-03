import { resolve } from "node:path";

import type {
  ChannelConfig,
  ChannelEnvironment,
} from "@introspection-ai/recipes/channels";

/** Compatibility for local Slack configuration only, never task routing. */
export function localSlackChannelConfig(
  env: ChannelEnvironment,
): ChannelConfig | null {
  if (
    env.INTROSPECTION_TASK_ID?.trim() ||
    env.INTROSPECTION_EGRESS_URL?.trim() ||
    env.INTROSPECTION_TASK_CHANNEL_PROVIDER?.trim() ||
    env.INTROSPECTION_TASK_CHANNEL_ID?.trim() ||
    env.INTROSPECTION_TASK_THREAD_ID?.trim()
  ) {
    return null;
  }
  const channel = env.SLACK_CHANNEL_ID?.trim();
  if (!channel) return null;
  return {
    provider: "slack",
    channel_ref: channel,
    thread_ref: env.SLACK_THREAD_TS?.trim() || null,
  };
}

export function slackDownloadRoot(
  env: ChannelEnvironment = process.env,
  cwd: string = process.cwd(),
): string {
  const runtimeFiles = env.INTROSPECTION_RUNTIME_FILES_DIR?.trim();
  return resolve(runtimeFiles || resolve(cwd, "files"), "slack");
}
