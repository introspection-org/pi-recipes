# Slack helpers

`@introspection-ai/recipes/slack` is an opt-in helper module for recipes that
answer Slack conversations through Slack's hosted MCP server
(`https://mcp.slack.com/mcp`). It covers the three things the hosted server
cannot: knowing *which* conversation this session answers, moving file bytes
into the task workspace instead of model context, and formatting a message
body with a plain-text fallback.

Nothing here registers itself. A recipe wires the tools up from its own
extension file and lists them in its agent's `tools:` — the library never
adds provider behavior to a session that did not ask for it.

## Wiring the tools into a recipe

`extensions/slack-tools.mjs`:

```js
import { registerSlackTools } from "@introspection-ai/recipes/slack";

export default (pi) => registerSlackTools(pi);
```

`agents/agent.yaml`:

```yaml
tools:
  - bash
  - slack_origin
  - slack_workspace_download_file
```

Declare the dependency in the recipe's `package.json` and commit a lockfile.
At runtime the import resolves to the host's own `@introspection-ai/recipes`
instance, so the module must exist in the host's installed version.

## The tools

### `slack_origin`

Returns `{provider, channel, thread_ts}` — the conversation this session
answers. `thread_ts` is `null` for a top-level message. The agent calls it
first and passes `channel` / `thread_ts` explicitly to every Slack MCP call;
the hosted server has no implicit origin.

Resolution order:

1. **Cloud**: the Introspection runtime's task origin env
   (`INTROSPECTION_TASK_CHANNEL_PROVIDER`, `INTROSPECTION_TASK_CHANNEL_ID`,
   `INTROSPECTION_TASK_THREAD_ID`).
2. **Local**: `SLACK_CHANNEL_ID` and optionally `SLACK_THREAD_TS`.
3. Neither → the tool call errors, naming the variables to set.

### `slack_workspace_download_file`

Downloads one Slack file into the task workspace and returns
`{id, name, path, mime_type, size, sha256}`. The hosted MCP server returns
file content into model context, which is exactly wrong for large or private
files — these bytes belong on disk, referenced by path.

- `file_id` (required), `variant` (`"original"` default, or `"video_low"`
  for a video's smaller mp4 rendition when `files.info` reports `mp4_low`).
- Files land under `INTROSPECTION_RUNTIME_FILES_DIR/slack` when the runtime
  names a files tree, else `./files/slack` under the session workspace.
- The download URL is host-pinned to `files.slack.com`, capped at 100 MiB,
  streamed to a private partial file, hashed, size-verified, then renamed
  into place. A failure removes the partial.

**Auth** is a plain bearer on both requests:

- In an Introspection cloud sandbox the bearer is the session locator
  (`INTROSPECTION_TOKEN`) — the egress proxy verifies the locator and swaps
  the header for the workspace bot token. The swap is keyed on that
  verified locator, so an empty or arbitrary bearer is never credentialed.
- Locally, set `SLACK_BOT_TOKEN` (a bot token with `files:read`); it takes
  precedence when both are present. Holding neither is a typed error before
  any network call.

## Formatting helpers

Pure functions, no I/O:

- `toPlainText(markdown)` — strip Markdown to readable plain text for the
  surfaces that render no markup (push notifications, screen readers).
  Deliberately one-directional: it removes markers rather than translating
  them, so it can only ever render plainly, never wrongly.
- `slackMessageBody(markdown, {plainText?})` — `{text, blocks}` where
  `blocks` carries the Markdown as a Block Kit `markdown` block and `text`
  is the plain fallback (caller-supplied, else derived).

## Library API

Everything the tools are built from is exported for recipes that need finer
control: `resolveSlackOrigin(env?)`, `slackDownloadRoot(env?, cwd?)`,
`SlackFileSession` (constructor takes `{env, fetchImpl, cwd}` for testing),
`MAX_SLACK_FILE_BYTES`, and `registerSlackTools(pi, {env?, session?})`.
