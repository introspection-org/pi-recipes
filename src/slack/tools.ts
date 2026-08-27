import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { SlackFileSession } from "./files.js";
import { resolveSlackOrigin, type SlackEnv } from "./origin.js";

export interface RegisterSlackToolsOptions {
  /** Injectable for tests; defaults to process.env. */
  env?: SlackEnv;
  /** Injectable for tests; defaults to a session over `env` / cwd. */
  session?: SlackFileSession;
}

/**
 * Register the recipe-side Slack tools: `slack_origin` (the conversation this
 * session answers) and `slack_workspace_download_file` (Slack file bytes into
 * the task workspace, never into model context).
 *
 * Opt-in — a recipe wires this up from its own extension file and lists the
 * tool names in its agent's `tools:`:
 *
 * ```js
 * import { registerSlackTools } from "@introspection-ai/recipes/slack";
 * export default (pi) => registerSlackTools(pi);
 * ```
 *
 * Failures throw; the Pi runtime renders a thrown error as the tool call's
 * error result.
 */
export function registerSlackTools(pi: ExtensionAPI, options: RegisterSlackToolsOptions = {}): void {
  const env = options.env ?? process.env;
  const files = options.session ?? new SlackFileSession({ env });

  pi.registerTool({
    name: "slack_origin",
    label: "Slack origin",
    description:
      "The Slack conversation this session answers: provider, channel, and thread_ts (null for a top-level message). Call this first and pass its channel and thread_ts explicitly to every Slack MCP call.",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    async execute() {
      const origin = resolveSlackOrigin(env);
      if (!origin) {
        throw new Error(
          "No Slack origin is configured. In the Introspection runtime the task origin supplies it; for a local run set SLACK_CHANNEL_ID (and optionally SLACK_THREAD_TS)."
        );
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(origin, null, 2) }],
        details: origin,
      };
    },
  });

  pi.registerTool({
    name: "slack_workspace_download_file",
    label: "Download Slack file",
    description:
      'Download one Slack file into the task workspace and return its local path, size, and sha256. Pass variant "video_low" for a video\'s smaller mp4 rendition when files.info reports mp4_low.',
    parameters: Type.Object(
      {
        file_id: Type.String({ minLength: 1, maxLength: 100 }),
        variant: Type.Optional(
          Type.Union([Type.Literal("original"), Type.Literal("video_low")])
        ),
      },
      { additionalProperties: false }
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const result = await files.downloadFile(params);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
