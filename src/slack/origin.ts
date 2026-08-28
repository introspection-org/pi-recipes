import { resolve } from "node:path";

export type SlackEnv = Record<string, string | undefined>;

/** The Slack conversation a session answers. */
export interface SlackOrigin {
  provider: string;
  channel: string;
  /** Null for a non-threaded conversation lane. */
  thread_ts: string | null;
}

/**
 * The Slack conversation this session answers, from wherever the host put it.
 *
 * Cloud sandboxes carry the task origin as INTROSPECTION_TASK_CHANNEL_* env;
 * a local run names its target with SLACK_CHANNEL_ID / SLACK_THREAD_TS. One
 * resolver serves both so the recipe can map one origin onto the exact fields
 * exposed by its active Slack MCP server.
 */
export function resolveSlackOrigin(env: SlackEnv = process.env): SlackOrigin | null {
  const cloudChannel = env.INTROSPECTION_TASK_CHANNEL_ID?.trim();
  if (cloudChannel) {
    return {
      provider: env.INTROSPECTION_TASK_CHANNEL_PROVIDER?.trim() || "slack",
      channel: cloudChannel,
      thread_ts: env.INTROSPECTION_TASK_THREAD_ID?.trim() || null,
    };
  }
  const localChannel = env.SLACK_CHANNEL_ID?.trim();
  if (localChannel) {
    return {
      provider: "slack",
      channel: localChannel,
      thread_ts: env.SLACK_THREAD_TS?.trim() || null,
    };
  }
  return null;
}

/**
 * Where downloaded Slack files land.
 *
 * The cloud runtime names the task files tree via
 * INTROSPECTION_RUNTIME_FILES_DIR; without it (a local run, or the cloud
 * default where the workspace is the cwd) the tree is ./files under the
 * session workspace — the same location either way, since the cloud cwd is
 * the workspace root.
 */
export function slackDownloadRoot(env: SlackEnv = process.env, cwd: string = process.cwd()): string {
  const runtimeFiles = env.INTROSPECTION_RUNTIME_FILES_DIR?.trim();
  if (runtimeFiles) return resolve(runtimeFiles, "slack");
  return resolve(cwd, "files", "slack");
}
