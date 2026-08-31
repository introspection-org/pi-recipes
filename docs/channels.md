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
  Recipe run on Microsoft Teams simply has no `channel_history`; it does not
  have one that answers "unsupported" after burning a turn.

Before the first model call, the channel extension adds origin metadata to the
system prompt. The metadata contains the provider, the conversation name when
the adapter can resolve one, whether the origin is a thread, and the available
channel tools. It contains no provider conversation IDs and no messages.
`channel_history` remains the only way to fetch earlier messages when the
provider supports it.

## The tools

| Tool | Model arguments | Requires |
| --- | --- | --- |
| `channel_info` | none | always |
| `channel_reply` | `text` (Markdown) | always |
| `channel_history` | `limit?`, `cursor?` | `history` |
| `channel_react` | `message`, `emoji` | `react` |
| `channel_edit` | `message`, `text` | `edit` |
| `channel_retract` | `message` | `retract` |
| `channel_attach` | `path`, `title?`, `comment?` | `attach` |
| `channel_fetch_file` | `file` (a `file_…` handle), `variant?` | `fetch_file` |
| `channel_post_document` | `title`, `markdown` | `documents` |

`channel_info`, `channel_reply` and `channel_history` are active by default
where supported; the rest start inactive and the model reaches them through
`tool_search`.

Reply content is **Markdown**. Each adapter renders it the provider's own way —
Slack posts a `markdown` block, Teams sets `textFormat: "markdown"`. There is
no raw block passthrough: a provider-specific payload is not portable, and
interactive elements inside one have no routing back to the task.

### Message and file references

`channel_react`, `channel_edit` and `channel_retract` take a `message`, which is
an opaque per-session handle (`msg_…`) minted by the host — never a Slack
timestamp or a Teams activity id. Handles come back from `channel_reply` and
from `channel_history` rows, so the model can only act on messages it has
actually seen through a tool.

`channel_fetch_file` works the same way: attachments on history rows carry a
`file_…` handle, and that is the only thing the tool accepts. A provider file
id would be an addressing argument in everything but name — a bot can usually
read files from every conversation it belongs to, so a model that could pass
one could reach a file this conversation never carried.

`channel_edit` and `channel_retract` additionally require that the handle refer
to a message **this agent posted**. Re-reading a thread the agent replied to
returns the same handle it was given at post time, so authorship survives a
history read.

### Enrichment, not lookup tools

Author names and permalinks are resolved by the adapter in trusted code and
attached to what the agent is already reading: `channel_history` rows carry
`author.display_name`, and `channel_reply` returns a `permalink` where the
provider has one. There is no `resolve_user` or `get_permalink` tool, because
each would be a second round trip the model has to know to make — and each
would take an addressing argument.

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
    "@introspection-ai/recipe-connector-slack": "^0.1.0"
  },
  "pi": {
    "connectors": [
      {
        "provider": "slack",
        "package": "@introspection-ai/recipe-connector-slack",
        "tools": { "include": ["info", "reply", "history", "react"] }
      }
    ]
  }
}
```

`tools.include` uses the **unprefixed operation ids** (`reply`, not
`channel_reply`); the agent's own `tools:` list uses the registered names
(`channel_reply`). Narrowing is fail-closed at three layers: the package's
capability-derived catalog, then `tools.include`, then the agent list.

Because the vocabulary is neutral, the same declaration and the same agent
prompt work against another provider by changing only the package and
`provider`. What changes is which tools exist — see the capability table below.

## Capabilities by provider

| Capability | Slack | Teams |
| --- | --- | --- |
| `reply` / `edit` / `retract` | yes | yes |
| `react` | yes | no |
| `history` | channel and thread | no |
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
schemas at all — that is what keeps two providers from drifting into
differently-shaped versions of the same operation, and what keeps either from
growing an addressing argument.

```ts
import {
  createChannelConnectorModule,
  type ChannelAdapter,
} from "@introspection-ai/recipes/channels";

const capabilities = {
  react: false, edit: true, retract: true,
  history: false, attach: false, fetchFile: false,
  documents: false, resolveAuthors: true, permalinks: false,
};

class MyAdapter implements ChannelAdapter {
  readonly provider = "my-channel";
  readonly capabilities = capabilities;
  async info(ctx) { return ctx.target; }
  async reply(ctx, { text }) { /* post into ctx.target */ }
  async edit(ctx, { ref, text }) { /* ctx.refs.resolveAuthored(ref) */ }
  async retract(ctx, { ref }) { /* … */ }
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

The result is an ordinary `RecipeConnectorModule`: manifest validation, the
fail-closed narrowing, and `tool_search` all work on it unchanged.

## Provider pages

- [Slack](slack.md)
- [Teams](teams.md)
