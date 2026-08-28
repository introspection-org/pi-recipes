# Slack Bot API tools

`@introspection-ai/recipes/slack` lets a Recipe call the Slack Web API with the
bot that received the task. Slack behavior stays in Recipe code. The cloud host
only supplies the task origin, the installed bot credential at the egress
boundary, and task event handling.

The module does not use Slack's hosted MCP server, Socket Mode, WebSockets, or
a streamed tool protocol. Slack sends inbound events to the existing Events API
webhook. Recipe tools make ordinary HTTP requests to the Slack Web API.

## Register the tools

Add one Recipe extension:

```js
import { registerSlackBotTools } from "@introspection-ai/recipes/slack";

export default function slackTools(pi) {
  registerSlackBotTools(pi);
}
```

The Recipe package must declare the extension. Each agent must also list the
exact Slack tools it may call. Registration makes the tools available to the
Recipe. The agent tool list sets the model's access.

The module registers these tools:

| Tool                  | Slack operation                                  |
| --------------------- | ------------------------------------------------ |
| `slack_send_message`  | `chat.postMessage`                               |
| `slack_react`         | `reactions.add`                                  |
| `slack_read_thread`   | `conversations.replies`                          |
| `slack_read_history`  | `conversations.history`                          |
| `slack_list_channels` | `conversations.list`                             |
| `slack_join_channel`  | `conversations.join`                             |
| `slack_resolve_user`  | `users.info`                                     |
| `slack_get_permalink` | `chat.getPermalink`                              |
| `slack_download_file` | `files.info` and a private file download         |
| `slack_origin`        | Read the current task's Slack channel and thread |

`slack_send_message` and `slack_react` always use the task's origin channel.
The read tools keep the old in pod server behavior. They default to the origin,
but a Recipe can pass another channel that the installed bot can access.
`slack_list_channels` and `slack_join_channel` are workspace operations. A
Recipe that does not need them should leave them out of the agent tool list.

## Cloud access

The Recipe never receives the Slack bot token. The extension sends the task
locator to `INTROSPECTION_EGRESS_URL`, which is the provider proxy inside the
Introspection environment. It sets the Slack host as the proxy route. The
proxy verifies and removes the locator, checks the connector's granted scope
and allowed path, and adds the bot token before the request leaves for Slack.

The extension refuses to send a task locator when the provider proxy URL is
missing. It never falls back to sending the locator to Slack.

After `slack_send_message` succeeds in cloud, the extension posts the existing
`connector_posted` task event to the Data Plane. The Data Plane checks the
agent session, current run, provider, and origin channel before it records the
new thread root. A later Slack reply can then resume the same task.

Slack writes are attempted once. The extension does not retry
`chat.postMessage`, because Slack does not accept an idempotency key for that
method. If Slack accepts the post but task event recording fails, the tool
returns the posted message reference and a bridge error. It does not post the
message again.

## Test with introspection dev

Run `introspection dev` from the Recipe repository. A Slack event sent to the
development runtime starts a cloud sandbox with the local Recipe overlay. The
extension uses the cloud task origin and provider proxy, so no local Slack
credential is required.

Use `introspection dev --logs` when you need the extension's sandbox logs. No
local Slack MCP server or `--mcp` override is involved.

## Test with introspection local

An `introspection local` run has no inbound Slack event, cloud task origin, or
cloud credential proxy. Set the bot token and a target conversation before the
run:

```bash
export SLACK_BOT_TOKEN='xoxb-...'
export SLACK_CHANNEL_ID='C0123456789'
export SLACK_THREAD_TS='1234567890.123456' # optional
introspection local -p 'Read the Slack origin and reply with a short test.'
```

The local tools call Slack directly with `SLACK_BOT_TOKEN`. They can read,
react, post, and download files. Local outbound posts do not create an inbound
task or a reply bridge because no Data Plane task exists.

## File downloads

`slack_download_file` writes a file under the task files directory and returns
its path, media type, size, and SHA 256 digest. It accepts only
`files.slack.com` download URLs, rejects redirects, caps the body at 100 MiB,
checks the declared size, and removes partial files after a failure. The
`video_low` option uses Slack's smaller MP4 rendition when it exists.
