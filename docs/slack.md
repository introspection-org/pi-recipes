# Slack channel connector

`@introspection-ai/recipe-channel-slack` is the Slack adapter for the
[channel tools](channels.md). It supplies Slack Web API transport and a
capability descriptor; the tool names and schemas are the neutral `channel_*`
set, so a Recipe written against it is not written against Slack.

Slack sends inbound events to the existing Events API webhook. The tools make
ordinary HTTP requests to the Slack Web API with the bot that received the
task. The package does not use Socket Mode, WebSockets, or a streamed tool
protocol.

## Declare it

```json
{
  "dependencies": {
    "@introspection-ai/recipe-channel-slack": "^0.1.0"
  },
  "pi": {
    "connectors": [
      {
        "provider": "slack"
      }
    ]
  }
}
```

Commit the package manager lockfile. The host loads the package only for a
Recipe that declares the connector.

The connector package provides the complete Slack tool catalog. Each agent
lists the exact `channel_*` tools it may call in its YAML file. `channel_reply`,
`channel_read`, and `channel_react` are active from the start. Other selected
tools are available through `tool_search`.

## What Slack registers

| Tool | Slack operation |
| --- | --- |
| `channel_reply` | `chat.postMessage` into the origin channel and thread |
| `channel_read` | `conversations.replies` in a thread, else `conversations.history` |
| `channel_react` | `reactions.add` |
| `channel_edit` | `chat.update` for a message the agent posted |
| `channel_retract` | `chat.delete` for a message the agent posted |
| `channel_fetch_file` | `files.info` plus a private file download |

Slack history returns at most 15 messages to the agent per call. For a thread,
the first call reads the thread and returns the newest messages. The adapter
keeps older messages in the current session, and the returned opaque cursor
pages backward through that cache without another `conversations.replies`
request.

The connector uses a customer owned internal Slack app. Slack gives internal
apps the larger `conversations.replies` page and rate limits needed to read a
thread before selecting its newest messages. The connector does not support a
commercially distributed Slack app outside the Slack Marketplace, because
Slack restricts those installations to 15 replies and one request per minute.

`channel_attach` and `channel_post_document` are not registered: `files.uploadV2`
and canvases are not implemented in this package yet, and the capability
descriptor says so rather than registering tools that fail.

None of these take a channel or thread argument. Every tool acts on the
conversation the task came from. Author display names (`users.info`) and
permalinks (`chat.getPermalink`) are resolved inside the adapter and attached to
message rows and reply results, so there is no user lookup or permalink tool.
Edit and retract also require an opaque reference for a message posted by this
agent. They cannot act on another author's message.

Workspace search, channel listing and joining, directory lookup, and
cross-channel posting are unsupported. Their contract and access model are
deferred to a separate proposal.

## Cloud access

The Recipe never receives the Slack bot token. The adapter sends the task
locator to `INTROSPECTION_EGRESS_URL`, the provider proxy inside the
Introspection environment, with the Slack host as the proxy route. The proxy
verifies and removes the locator, checks the connector's granted scope and
allowed path, and adds the bot token before the request leaves for Slack.

The adapter refuses to send a task locator when the provider proxy URL is
missing. It never falls back to sending the locator to Slack.

After `channel_reply` succeeds in cloud, the adapter posts the `connector_posted`
task event to the Data Plane, which checks the agent session, current run,
provider, and origin channel before recording the new thread root. A later Slack
reply then resumes the same task.

Slack writes are attempted once. The adapter does not retry `chat.postMessage`,
because Slack accepts no idempotency key for it. If Slack accepts the post but
event recording fails, the tool returns the message reference and a
`bridge_error`. It does not post again.

## Test with introspection dev

Run `introspection dev` from the Recipe repository. A Slack event sent to the
development runtime starts a cloud sandbox with the local Recipe overlay, so the
adapter uses the cloud task origin and provider proxy and needs no local Slack
credential. Use `introspection dev --logs` for sandbox logs.

## Test with introspection local

An `introspection local` run has no inbound Slack event, cloud task origin, or
credential proxy. Install dependencies, then set a bot token and a conversation:

```bash
pnpm install --frozen-lockfile
export SLACK_BOT_TOKEN='xoxb-...'
export SLACK_CHANNEL_ID='C0123456789'
export SLACK_THREAD_TS='1234567890.123456' # optional
introspection local -p 'Summarise this thread and reply.'
```

Local tools call Slack directly with `SLACK_BOT_TOKEN`. Local posts create no
inbound task or reply bridge, because no Data Plane task exists.

## File downloads

`channel_fetch_file` writes a file under the task files directory and returns its
path, media type, size, and SHA-256 digest. The bytes land in the workspace and
not in model context. It accepts only a `file_…` handle from a `channel_read`
attachment, so the bot's cross-channel file read is not reachable from model
input. On the wire it accepts only `files.slack.com` download URLs, rejects
redirects, caps the body at 100 MiB, checks the declared size, and removes
partial files after a failure. The `video_low` variant uses Slack's smaller MP4
rendition when one exists.

## Direct host use

The package exports `SlackChannelAdapter`, `createSlackChannelSession` and
`slackChannelTarget` for custom hosts and tests, alongside the default
`slackRecipeConnectorModule`. A normal Recipe uses `pi.connectors` instead.
