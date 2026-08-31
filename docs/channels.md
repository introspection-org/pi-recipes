# Channel tools

A Recipe that answers a chat message declares a **channel connector**. The host
then registers a fixed set of `channel_*` tools, named and shaped identically
for every provider, and bound to the one conversation the task came from.

Two properties follow from that, and both are structural rather than
conventional:

- **The agent cannot address anything else.** No `channel_*` tool takes a
  channel, thread, workspace, or user argument. The conversation is closed over
  by the host from the task origin, so a compromised prompt has no vocabulary
  for "post this somewhere else". The invariant is asserted by a test that
  walks every registered tool's input schema.
- **A tool that the provider cannot support is absent, not failing.** Each
  adapter declares a capability descriptor, and registration filters on it. A
  Recipe run on Microsoft Teams simply has no `channel_read`; it does not
  have one that answers "unsupported" after burning a turn.

Before the first model call, the channel extension adds origin metadata to the
system prompt. The metadata contains the provider, the conversation name and
permalink when the adapter can resolve them, whether the origin is a thread,
and the available channel tools. It contains no provider conversation IDs and
no messages.
`channel_read` remains the only way to fetch earlier messages when the
provider supports it.

## The tools

| Tool | Model arguments | Requires |
| --- | --- | --- |
| `channel_reply` | `text` (Markdown) | always |
| `channel_read` | `limit?`, `cursor?` | `read` |
| `channel_react` | `message`, `emoji` | `react` |
| `channel_attach` | `path`, `title?`, `comment?` | `attach` |
| `channel_fetch_file` | `file` (a `file_…` handle), `variant?` | `fetch_file` |
| `channel_post_document` | `title`, `markdown` | `documents` |

`channel_reply`, `channel_read`, and `channel_react` are active by default when
the provider supports them. The other selected tools start inactive, and the
model can find them through `tool_search`.

Reply content is **Markdown**. Each adapter renders it in the provider's own
format. Slack posts a `markdown` block, and Teams sets `textFormat: "markdown"`. There is
no raw block passthrough: a provider-specific payload is not portable, and
interactive elements inside one have no routing back to the task.

### Message and file references

`channel_react` takes a `message`, which is an opaque handle minted by the host
for the current session. It is not a Slack timestamp or a Teams activity ID.
Handles come back from `channel_reply` and `channel_read`, so the model can only
react to a message that a channel tool returned.

`channel_fetch_file` works the same way. Attachments returned by `channel_read`
carry a `file_…` handle, and that is the only value the tool accepts. A bot can
usually read files from every conversation it belongs to, so accepting a raw
provider file ID would let the model reach files outside the bound conversation.

### Enrichment, not lookup tools

Author names and permalinks are resolved by the adapter in trusted code and
attached to what the agent is already reading: `channel_read` rows carry
`author.display_name`, and `channel_reply` returns a `permalink` where the
provider has one. There is no `resolve_user` or `get_permalink` tool, because
each would require another model turn. Each lookup would also take an
addressing argument.

### Unsupported operations

Workspace search, channel listing and joining, directory lookup, and posting to
another conversation are unsupported. The proposal does not choose an API or
access model for those operations. A separate proposal can define them when a
concrete use case requires them.

Typing indicators and presence are runtime effects rather than model decisions.
Streaming controls how a reply is delivered. The runtime derives idempotency
keys, and the webhook already removes duplicate inbound events.

## Declare a channel connector

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

The connector declaration enables the provider package and its supported tool
catalog. The agent YAML file is the only place that narrows the catalog:

```yaml
tools: [channel_reply, channel_read, channel_react, channel_fetch_file]
```

The host fails when an agent selects a tool that the provider does not support.

Because the vocabulary is neutral, the same declaration and the same agent
prompt work against another provider by changing the dependency and `provider`.
The capability table below shows which tools each provider supplies.

## Capabilities by provider

| Capability | Slack | Teams |
| --- | --- | --- |
| `reply` | yes | yes |
| `react` | yes | no |
| `read` | channel and thread | no |
| `fetch_file` | yes | no |
| `attach` | not yet implemented | no |
| `documents` | not yet implemented | no |
| author display names | resolved via `users.info` | on the activity |
| permalinks | yes | no |

Teams' gaps are not oversights. Reading a Teams conversation, reacting to a
message, and downloading an attachment all require Microsoft Graph with
resource-specific consent granted by the tenant administrator; the Bot
Connector credential every bot has cannot do them. A tenant that has granted
consent can flip the capability in a build of the adapter.

## Write an adapter

An adapter supplies transport and a capability descriptor. It writes no tool
schemas. The shared schema keeps providers from defining different forms of
the same operation, and it prevents a provider from adding an addressing
argument.

```ts
import {
  createChannelConnectorModule,
  type ChannelAdapter,
} from "@introspection-ai/recipes/channels";

const capabilities = {
  react: false, read: false, attach: false, fetchFile: false,
  documents: false, resolveAuthors: true, permalinks: false,
};

class MyAdapter implements ChannelAdapter {
  readonly provider = "my-channel";
  readonly capabilities = capabilities;
  async reply(ctx, { text }) { /* post into ctx.target */ }
}

export default createChannelConnectorModule({
  provider: "my-channel",
  capabilities,
  createSession: ({ env }) => ({
    adapter: new MyAdapter(/* client from env */),
    // A function, so a task with no channel origin still starts: the tools
    // fail when called, the session does not fail to open.
    target: () => resolveTargetFrom(env),
  }),
});
```

Registration checks that the adapter implements every method its capabilities
claim, so a descriptor cannot promise a tool the adapter does not have.

The result is an ordinary `RecipeConnectorModule`. Manifest validation, agent
tool selection, and `tool_search` work without provider-specific code in the
Recipe.

## Provider pages

- [Slack](slack.md)
- [Teams](teams.md)
