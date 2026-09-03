# Channel tools

A Recipe that answers a chat message declares a **channel connector**. The host
then registers a fixed set of `channel_*` tools, named and shaped identically
for every provider, and bound to the one conversation the task came from.

Two properties follow from that, and both are structural rather than
conventional:

- **Message destinations are allow-listed.** `channel_message` requires the
  provider channel id and, for a threaded destination, its thread id. The host
  supplies those ids in trusted channel context and rejects any values that do
  not exactly match the task's inbound origin or automation notification
  target. No other channel tool takes an addressing argument. Provider egress
  remains the authorization boundary for raw sandbox requests.
- **A tool that the provider cannot support is absent, not failing.** Each
  adapter declares a capability descriptor, and registration filters on it.
  For example, an adapter with no history API has no `channel_read` tool.

Before the first model call, the channel extension adds destination metadata to
the system prompt. The metadata contains the provider channel id, its thread id
when threaded, the conversation name and permalink when available, and the
active channel tools. It contains no messages. An inbound task delivers through
`channel_message`, because a normal final assistant response is not delivered
to the originating channel. An automation run may use the same tool for interim
updates; its final assistant response is posted automatically after the run
settles, whether the run was started by its schedule or the manual Run control.
`channel_read` remains the only way to fetch earlier messages when supported.

## The tools

| Tool                    | Model arguments                                   | Requires                                                          |
| ----------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| `channel_message`       | `channel`, `thread?`, `text` (Markdown)           | an inbound conversation or trusted automation notification target |
| `channel_read`          | `limit?`, `cursor?`                               | `read`                                                            |
| `channel_react`         | `message`, `emoji`, `action?` (`add` or `remove`) | `react`                                                           |
| `channel_edit`          | `message`, `text`                                 | `edit`                                                            |
| `channel_retract`       | `message`                                         | `retract`                                                         |
| `channel_attach`        | `path`, `title?`, `comment?`                      | `attach`                                                          |
| `channel_fetch_file`    | `file` (a `file_…` handle), `variant?`            | `fetch_file`                                                      |
| `channel_post_document` | `title`, `markdown`                               | `documents`                                                       |

`channel_message`, `channel_read`, and `channel_react` are active by default
when the provider supports them. Session filtering exposes `channel_message`
only when the task has an inbound origin or a trusted automation notification
target. The other selected tools start inactive, and the model can find them
through `tool_search`.

Reply content is **Markdown**. Each adapter renders it in the provider's own
format. There is no raw provider payload because the same tool contract must
work with every adapter.

### Message and file references

`channel_react`, `channel_edit`, and `channel_retract` take a `message`, which is
an opaque handle minted by the host for the current session. It is not a Slack
timestamp or another provider message ID. Handles come back from
`channel_message` and `channel_read`, so the model can only act on a message that
a channel tool returned.

`channel_react` adds a reaction when `action` is omitted. Set `action` to
`remove` to remove the agent's reaction with the same emoji.

Edit and retract have an extra check. They accept only a handle for a message
that this agent posted. Reading the same message again keeps its original
handle and authorship record.

`channel_fetch_file` works the same way. Attachments returned by `channel_read`
carry a `file_…` handle, and that is the only value the tool accepts. A bot can
usually read files from every conversation it belongs to, so accepting a raw
provider file ID would let the model reach files outside the bound conversation.

### Enrichment, not lookup tools

Author names and permalinks are resolved by the adapter in trusted code and
attached to what the agent is already reading: `channel_read` rows carry
`author.display_name`, and `channel_message` returns a `permalink` where the
provider has one. There is no `resolve_user` or `get_permalink` tool, because
each would require another model turn. Each lookup would also take an
addressing argument.

### Automation notifications

`channel_message` serves both inbound replies and interim automation updates.
Trusted host state supplies exactly one destination for the task. The model must
pass its channel id and, when present, its thread id; the tool rejects any other
destination. Automation notification targets cover both schedule ticks and the
manual Run control. After the run settles, the extension makes one automatic
post attempt for its final assistant response; an exact `NO_REPLY` response is
not posted. A task with neither an inbound origin nor an automation notification
target receives no channel tools.

Workspace search, channel listing and joining, directory lookup, and posting to
an arbitrary conversation are unsupported. A separate proposal can define them
when a concrete use case requires them.

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
tools:
  [
    channel_message,
    channel_read,
    channel_react,
    channel_edit,
    channel_retract,
    channel_fetch_file,
  ]
```

The host fails when an agent selects a tool that the provider does not support.

Because the vocabulary is neutral, the same declaration and the same agent
prompt work against another provider by changing the dependency and `provider`.
Each provider package declares the capabilities that it can support.

## Write an adapter

An adapter supplies transport and a capability descriptor. It writes no tool
schemas. The shared schema keeps providers from defining different forms of
the same operation and confines addressing to the validated `channel_message`
destination.

```ts
import {
  createChannelConnectorModule,
  type ChannelAdapter,
} from "@introspection-ai/recipes/channels";

const capabilities = {
  react: false,
  edit: true,
  retract: true,
  read: false,
  attach: false,
  fetchFile: false,
  documents: false,
  resolveAuthors: true,
  permalinks: false,
};

class MyAdapter implements ChannelAdapter {
  readonly provider = "my-channel";
  readonly capabilities = capabilities;
  async reply(ctx, { text }) {
    /* post into ctx.target */
  }
  async edit(ctx, { ref, text }) {
    /* edit an agent-authored message */
  }
  async retract(ctx, { ref }) {
    /* retract an agent-authored message */
  }
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
