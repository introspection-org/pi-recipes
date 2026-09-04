# Channel tools

A Recipe that answers a chat message declares a **channel connector**. The host
then registers one `channels` tool with a `command` discriminator, shaped identically
for every provider. Reply defaults to the origin; adapters can opt into explicit
read/send destinations within the same credential session.

Two properties follow from that, and both are structural rather than
conventional:

- **Explicit targeting is a capability.** `targeting: true` adds `channels send`
  and channel/thread arguments to `channels read`. Adapters without it retain
  bound schemas. Reply, attach, and document tools still use the origin.
- **A command that the provider cannot support is absent, not failing.** Each
  adapter declares a capability descriptor, and registration filters on it.
  For example, an adapter with no history API has no `read` command.

Agents select `tools: [channels]`. By default this exposes all operations supported
by the adapter. To restrict commands for the recipe, set an allowlist on the
connector in `package.json`:

```json
{"pi":{"connectors":[{"provider":"slack","commands":["list","read","reply"]}]}}
```

The allowlist applies to all agents using this connector; an empty list exposes
no channel tool. Unknown or unsupported commands fail at registration. Commands
outside the allowlist and invalid command arguments are rejected before provider
calls. The host API uses `registerChannelTools(..., { commands: [...] })` for the
same restriction.

### Required replies

Set `requireReply: true` on a channel connector to require a successful final
`reply` on turns with a channel origin. It is opt-in; UI and automation turns
without an origin are unaffected. The agent must select `channels`, and the
connector must expose `reply`.

`reply` accepts `final` (default `true`). Use `final: false` for progress updates.
Only a successful final reply satisfies the guard, not reactions or explicit
sends. The extension adds delivery instructions and queues one corrective
follow-up if the agent finishes without replying. If that also finishes without
a reply, a visible `channel-delivery-failed` message records the failure locally.
It never automatically publishes private assistant text. Aborted and provider-error
runs are not retried by this guard. Hosts must wait for `agent_settled`, not an
intermediate `agent_end`, before declaring a run complete.

Migration: replace agent `channel_*` tool names with `channels`, and move any
operation restrictions to `commands` (without the `channel_` prefix). This is a
breaking interface change; old individual tool names are not registered.

Before each agent run, the channel extension attaches origin metadata as a
separate, hidden `channel-context` custom message. Pi converts it to user-role
model context without changing the user's message. It contains the provider,
channel/thread IDs, conversation scope, and optional name/permalink, but no
history or tool inventory. The system prompt contains only stable facts: display
labels are untrusted metadata, and normal assistant output is not delivered to
the channel. Recipe instructions decide when to reply, stay silent, read history,
or send elsewhere; tool descriptions explain how. Tool discovery remains the
responsibility of the tool-search extension.

Origin fields are stored once per session branch and rendered at the end of the
first user message, rather than as a separate user turn. Older duplicate context
entries are collapsed in model input; stored history is not rewritten.
Cloud ingress supplies per-message `from`, `message_id`, and `sent_at` attribution
in this wrapper too.
The first message merges attribution with origin fields; follow-ups carry only
their own attribution, without repeating the channel details.
Origin fields are JSON inside a single `<channel_context>` wrapper. JSON Unicode
escapes for `<`, `>`, and `&` keep provider labels from breaking the wrapper while
preserving valid JSON and the original values when parsed.

The context message is not an authorization boundary. Tools continue to resolve
the origin from host state, never from message text, and validate explicit targets
through the host's policy. Non-channel triggers receive no channel context.

## Commands

| Command (`channels` + `command`) | Additional arguments | Requires |
| --- | --- | --- |
| `channels reply` | `text` (Markdown), `final?` (default `true`) | always |
| `channels send` | `channel_id`, `thread_id?`, `text` | `targeting` |
| `channels list` | none | `list` |
| `channels read` | `channel_id?`, `thread_id?`, `limit?`, `cursor?` | `read`; addressing requires `targeting` |
| `channels react` | `message`, `emoji`, `action?` (`add` or `remove`) | `react` |
| `channels edit` | `message`, `text` | `edit` |
| `channels retract` | `message` | `retract` |
| `channels attach` | `path`, `title?`, `comment?` | `attach` |
| `channels fetch_file` | `file` (a `file_…` handle), `variant?` | `fetch_file` |
| `channels post_document` | `title`, `markdown` | `documents` |

`channels` is active immediately. Its command schema includes only supported,
allowed operations; no tool search is needed.

Reply content is **Markdown**. Each adapter renders it in the provider's own
format. There is no raw provider payload because the same tool contract must
work with every adapter.

### Targets and pagination

- `channels({command: "list"})` returns the channels available to the provider credential session.
- `channels({command: "read"})` reads the origin conversation.
- `channels({command: "read", channel_id: "C2"})` reads that channel's timeline.
- `channels({command: "read", channel_id: "C2", thread_id: "123.4"})` reads that thread.
- `channels({command: "read", thread_id: null})` reads the origin channel timeline.
- `channels({command: "send", channel_id: "C2", text: "Update"})` posts at channel level;
  supplying `thread_id` posts inside that thread.

An explicit channel does not require an origin, but still requires a working
provider credential. Sending/reading never changes `channels reply`'s origin.
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

`channels react`, `channels edit`, and `channels retract` take a `message`, which is
an opaque handle minted by the host for the current session. It is not a Slack
timestamp or another provider message ID. Handles come back from
`channels reply`, `channels send`, and `channels read`, so the model can only act on a message that
a channel tool returned.

`channels react` adds a reaction when `action` is omitted. Set `action` to
`remove` to remove the agent's reaction with the same emoji.

Edit and retract have an extra check. They accept only a handle for a message
that this agent posted. Reading the same message again keeps its original
handle and authorship record.
Each reference resolves its own destination. Handles are session-local; editing
a previous session's message is not supported.

`channels fetch_file` works the same way. Attachments returned by `channels read`
carry a `file_…` handle, and that is the only value the tool accepts. A bot can
usually read files from every conversation it belongs to, so accepting a raw
provider file ID would bypass the requirement to observe the file first.
File handles also retain the channel/thread read scope where they were observed.
Fetching revalidates that scope; observing the same file through another scope
creates a separate handle rather than changing the authority of an earlier one.

### Listing and enrichment

`channels list` returns provider channel IDs and names for explicitly targeted
reads and sends. When the host supplies `validateTarget`, every listed channel
is checked with the `list` operation and denied entries are omitted before any
IDs or names become model-visible. Author names and permalinks are resolved by the adapter in trusted code and
attached to what the agent is already reading: `channels read` rows carry
`author.display_name`, and `channels reply` returns a `permalink` where the
provider has one. There is no `resolve_user` or `get_permalink` tool, because
each would require another model turn. Each lookup would also take an
addressing argument.

### Unsupported operations

Search, individual channel-info lookup, thread listing, channel joining, and directory
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
tools: [channels]
```

The host fails when an agent selects a tool that the provider does not support.

Because the vocabulary is neutral, the same declaration and the same agent
prompt work against another provider by changing the dependency and `provider`.
Each provider package declares the capabilities that it can support.

## Write an adapter

An adapter supplies transport and a capability descriptor. It writes no tool
schemas. The shared schema keeps providers from defining different forms of
the same operation. Set `targeting: true` and implement `send(ctx, {text})` to
opt into the shared targeting schema; set `list: true` and implement `list()` to
expose `channels list`. Omit these capabilities for origin-bound tools.

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

The result is an ordinary `RecipeConnectorModule`. Manifest validation and agent
tool selection work without provider-specific code in the Recipe. The unified
tool is active immediately and does not require `tool_search`.

## Provider pages

- [Slack](slack.md)
