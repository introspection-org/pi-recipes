# Channel tools

A Recipe that answers a chat message declares a **channel connector**. The host
then registers a fixed set of `channel_*` tools, named and shaped identically
for every provider. Reply defaults to the origin; adapters can opt into explicit
read/send destinations within the same credential session.

Two properties follow from that, and both are structural rather than
conventional:

- **Explicit targeting is a capability.** `targeting: true` adds `channel_send`
  and channel/thread arguments to `channel_read`. Adapters without it retain
  bound schemas. Reply, attach, and document tools still use the origin.
- **A tool that the provider cannot support is absent, not failing.** Each
  adapter declares a capability descriptor, and registration filters on it.
  For example, an adapter with no history API has no `channel_read` tool.

Before the first model call, the channel extension adds origin metadata to the
system prompt. The metadata contains the provider, the conversation name and
permalink when the adapter can resolve them, whether the origin is a thread,
and the available tools, plus channel/thread IDs for navigation. It contains
no messages. The injected guidance tells the agent to deliver its user-facing
response with `channel_reply`, because a normal final assistant response is not
delivered to the originating channel. `channel_read` remains the only way to
fetch earlier messages when the provider supports it.

## The tools

| Tool | Model arguments | Requires |
| --- | --- | --- |
| `channel_reply` | `text` (Markdown) | always |
| `channel_send` | `channel_id`, `thread_id?`, `text` | `targeting` |
| `channel_read` | `channel_id?`, `thread_id?`, `limit?`, `cursor?` | `read`; addressing requires `targeting` |
| `channel_react` | `message`, `emoji`, `action?` (`add` or `remove`) | `react` |
| `channel_edit` | `message`, `text` | `edit` |
| `channel_retract` | `message` | `retract` |
| `channel_attach` | `path`, `title?`, `comment?` | `attach` |
| `channel_fetch_file` | `file` (a `file_…` handle), `variant?` | `fetch_file` |
| `channel_post_document` | `title`, `markdown` | `documents` |

`channel_reply`, `channel_read`, and `channel_react` are active by default when
the provider supports them. The other selected tools start inactive, and the
model can find them through `tool_search`.

Reply content is **Markdown**. Each adapter renders it in the provider's own
format. There is no raw provider payload because the same tool contract must
work with every adapter.

### Targets and pagination

- `channel_read({})` reads the origin conversation.
- `channel_read({channel_id: "C2"})` reads that channel's timeline.
- `channel_read({channel_id: "C2", thread_id: "123.4"})` reads that thread.
- `channel_read({thread_id: null})` reads the origin channel timeline.
- `channel_send({channel_id: "C2", text: "Update"})` posts at channel level;
  supplying `thread_id` posts inside that thread.

An explicit channel does not require an origin, but still requires a working
provider credential. Sending/reading never changes `channel_reply`'s origin.
Thread IDs are provider-native roots/topics, not opaque message handles or
generic quoted-reply IDs. Quoted replies are not introduced in this first pass.

Read results include `target`, optional message `thread_id`/`reply_count`, and
`next_direction` when the adapter supplies it. Pages are chronological. Repeat
the same target with a cursor; cross-target cursors fail. Page size may change.

### Access boundary

Each adapter and reference store belongs to **one credential session**. Never
reuse either across installations. The connector loader creates fresh instances.
No model argument switches credentials or customer connections.

Hosts can supply `validateTarget(target, operation)` on a connector session or
to `registerChannelTools`. It runs for every operation, including mutations and
file downloads using existing references. Without it, explicit targets rely on
the existing credential's provider permissions.

This is a **tool-layer policy, not a sandbox-wide security boundary**. Direct
shell/API calls can bypass it if the sandbox has broader credentials. Binding
enforcement, credential selection, durable receipts, and cross-channel reply
routing are separate platform work. Sending elsewhere does not imply that
subsequent replies resume the originating task.

### Message and file references

`channel_react`, `channel_edit`, and `channel_retract` take a `message`, which is
an opaque handle minted by the host for the current session. It is not a Slack
timestamp or another provider message ID. Handles come back from
`channel_reply`, `channel_send`, and `channel_read`, so the model can only act on a message that
a channel tool returned.

`channel_react` adds a reaction when `action` is omitted. Set `action` to
`remove` to remove the agent's reaction with the same emoji.

Edit and retract have an extra check. They accept only a handle for a message
that this agent posted. Reading the same message again keeps its original
handle and authorship record.
Each reference resolves its own destination. Handles are session-local; editing
a previous session's message is not supported.

`channel_fetch_file` works the same way. Attachments returned by `channel_read`
carry a `file_…` handle, and that is the only value the tool accepts. A bot can
usually read files from every conversation it belongs to, so accepting a raw
provider file ID would bypass the requirement to observe the file first.

### Enrichment, not lookup tools

Author names and permalinks are resolved by the adapter in trusted code and
attached to what the agent is already reading: `channel_read` rows carry
`author.display_name`, and `channel_reply` returns a `permalink` where the
provider has one. There is no `resolve_user` or `get_permalink` tool, because
each would require another model turn. Each lookup would also take an
addressing argument.

### Unsupported operations

Search, channel listing/info, thread listing, channel joining, and directory
lookup are deferred. Explicit IDs can come from task context; thread IDs can
also come from channel reads.

Typing indicators and presence are runtime effects rather than model decisions.
Streaming controls how a reply is delivered. These tools do not add durable
send idempotency or claim exactly-once delivery.

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
tools: [channel_reply, channel_send, channel_read, channel_react, channel_edit, channel_retract, channel_fetch_file]
```

The host fails when an agent selects a tool that the provider does not support.

Because the vocabulary is neutral, the same declaration and the same agent
prompt work against another provider by changing the dependency and `provider`.
Each provider package declares the capabilities that it can support.

## Write an adapter

An adapter supplies transport and a capability descriptor. It writes no tool
schemas. The shared schema keeps providers from defining different forms of
the same operation. Set `targeting: true` and implement `send(ctx, {text})` to
opt into the shared targeting schema; omit it for origin-bound tools.

```ts
import {
  createChannelConnectorModule,
  type ChannelAdapter,
} from "@introspection-ai/recipes/channels";

const capabilities = {
  react: false, edit: true, retract: true, read: false,
  attach: false, fetchFile: false,
  documents: false, resolveAuthors: true, permalinks: false,
};

class MyAdapter implements ChannelAdapter {
  readonly provider = "my-channel";
  readonly capabilities = capabilities;
  async reply(ctx, { text }) { /* post into ctx.target */ }
  async edit(ctx, { ref, text }) { /* edit an agent-authored message */ }
  async retract(ctx, { ref }) { /* retract an agent-authored message */ }
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
