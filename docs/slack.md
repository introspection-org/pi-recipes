# Slack Bot API tools

Recipes can declare Slack tools in `package.json`. The standard Recipes host
then loads the Slack adapter and calls the Slack Web API with the bot that
received the task. Recipe authors do not need to write a Slack extension. The
cloud host supplies the task origin, the installed bot credential at the egress
boundary, and task event handling.

The module does not use Slack's hosted MCP server, Socket Mode, WebSockets, or
a streamed tool protocol. Slack sends inbound events to the existing Events API
webhook. Recipe tools make ordinary HTTP requests to the Slack Web API.

## Declare the tools

Add the Slack connector package and declaration to `package.json`:

```json
{
  "dependencies": {
    "@introspection-ai/recipe-connector-slack": "^0.1.0"
  },
  "pi": {
    "connectors": [
      {
        "provider": "slack",
        "package": "@introspection-ai/recipe-connector-slack",
        "tools": {
          "include": [
            "origin",
            "read_thread",
            "react",
            "get_permalink",
            "download_file",
            "send_message"
          ]
        }
      }
    ]
  }
}
```

Commit the package manager lockfile. The host loads the Slack package only for
a Recipe that declares the Slack connector.

The package declaration sets the maximum Slack tool set for the Recipe. Each
agent must also list the exact `slack_*` tools it may call. The host registers
the package tool set, and the agent tool list narrows the model's access.

The model initially sees `slack_origin`, `slack_read_thread`, and
`slack_send_message` when the agent is allowed to use them. Other allowed Slack
tools start inactive. Recipes adds the generic `tool_search` tool when any
connector or MCP tools are inactive. The model can search for a capability such
as adding a reaction, and Recipes enables the best matching allowed tools for
the next model request. Recipe authors do not configure eager or deferred lists.

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
The read tools keep the old server behavior. They default to the origin,
but a Recipe can pass another channel that the installed bot can access.
`slack_list_channels` and `slack_join_channel` are workspace operations. A
Recipe that does not need them should leave them out of the agent tool list.

## Cloud access

The Recipe never receives the Slack bot token. The Slack adapter sends the task
locator to `INTROSPECTION_EGRESS_URL`, which is the provider proxy inside the
Introspection environment. It sets the Slack host as the proxy route. The
proxy verifies and removes the locator, checks the connector's granted scope
and allowed path, and adds the bot token before the request leaves for Slack.

The Slack adapter refuses to send a task locator when the provider proxy URL is
missing. It never falls back to sending the locator to Slack.

After `slack_send_message` succeeds in cloud, the Slack adapter posts the existing
`connector_posted` task event to the Data Plane. The Data Plane checks the
agent session, current run, provider, and origin channel before it records the
new thread root. A later Slack reply can then resume the same task.

Slack writes are attempted once. The Slack adapter does not retry
`chat.postMessage`, because Slack does not accept an idempotency key for that
method. If Slack accepts the post but task event recording fails, the tool
returns the posted message reference and a bridge error. It does not post the
message again.

## Test with introspection dev

Run `introspection dev` from the Recipe repository. A Slack event sent to the
development runtime starts a cloud sandbox with the local Recipe overlay. The
Slack adapter uses the cloud task origin and provider proxy, so no local Slack
credential is required.

Use `introspection dev --logs` when you need the Slack adapter's sandbox logs. No
local Slack MCP server or `--mcp` override is involved.

## Test with introspection local

An `introspection local` run has no inbound Slack event, cloud task origin, or
cloud credential proxy. Install the Recipe dependencies first. Then set the bot
token and a target conversation before the run:

```bash
pnpm install --frozen-lockfile
export SLACK_BOT_TOKEN='xoxb-...'
export SLACK_CHANNEL_ID='C0123456789'
export SLACK_THREAD_TS='1234567890.123456' # optional
introspection local -p 'Read the Slack origin and reply with a short test.'
```

The local tools call Slack directly with `SLACK_BOT_TOKEN`. They can read,
react, post, and download files. Local outbound posts do not create an inbound
task or a reply bridge because no Data Plane task exists.

## Direct host use

`@introspection-ai/recipe-connector-slack` exports `registerSlackBotTools` for
custom hosts and tests. A normal Recipe should use `pi.connectors` instead.

## File downloads

`slack_download_file` writes a file under the task files directory and returns
its path, media type, size, and SHA 256 digest. It accepts only
`files.slack.com` download URLs, rejects redirects, caps the body at 100 MiB,
checks the declared size, and removes partial files after a failure. The
`video_low` option uses Slack's smaller MP4 rendition when it exists.
