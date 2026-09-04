# Channel tools

A Recipe that uses a chat provider declares a **channel connector**. The host
registers a provider-neutral set of `channel_*` tools with the same names and
schemas for every provider.

Two properties are structural:

- **Message destinations are explicit.** `channel_message` requires the
  provider's channel id and accepts a thread id when needed. The provider bot's
  injected credential is the authorization boundary: a call can reach any
  channel that bot can access, but no other workspace or provider credential.
- **A tool that the provider cannot support is absent, not failing.** Each
  adapter declares a capability descriptor, and registration filters on it.
  For example, an adapter with no history API has no `channel_read` tool.

For an inbound task, the extension adds the origin's channel id and optional
thread id to the system prompt so the agent can reply explicitly. It includes
no messages; `channel_read` remains the only way to fetch earlier context. A
task without an origin receives no invented destination. It can use
`channel_lookup` to resolve a complete channel name, then pass that id to
`channel_message`. A normal assistant response is never published to a channel.

## The tools

| Tool                    | Model arguments                                   | Requires                               |
| ----------------------- | ------------------------------------------------- | -------------------------------------- |
| `channel_message`       | `channel`, `thread?`, `text` (Markdown)           | provider messaging access              |
| `channel_lookup`        | `name`                                            | exact provider channel-name lookup     |
| `channel_read`          | `limit?`, `cursor?`                               | an inbound origin and `read` capability |
| `channel_react`         | `message`, `emoji`, `action?` (`add` or `remove`) | `react`                                                           |
| `channel_edit`          | `message`, `text`                                 | `edit`                                                            |
| `channel_retract`       | `message`                                         | `retract`                                                         |
| `channel_attach`        | `path`, `title?`, `comment?`                      | `attach`                                                          |
| `channel_fetch_file`    | `file` (a `file_…` handle), `variant?`            | `fetch_file`                                                      |
| `channel_post_document` | `title`, `markdown`                               | `documents`                                                       |

`channel_message`, `channel_lookup`, `channel_read`, and `channel_react` are
active by default when supported. Session filtering can expose messaging and
lookup without an inbound origin while keeping origin-bound reads and reactions
absent. Other selected tools start inactive and are found through `tool_search`.

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

### Lookup and enrichment

`channel_lookup` resolves one complete channel name to an id. It is not fuzzy
search: the adapter may enumerate every provider page internally, but returns
only an exact match that the bot can message. Author names and permalinks remain
trusted enrichment attached to messages the agent already handles. There is no
user-directory or permalink lookup tool.

`channel_message` is the only publication path. It serves inbound replies,
automations, and ordinary Operator conversations alike, and every call names
its channel and optional thread explicitly. Finishing an agent run without that
tool call sends nothing.

Workspace search, channel joining, directory lookup, and user resolution remain
unsupported.

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
    channel_lookup,
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
schemas. The shared schema keeps providers from defining different forms of the same
operation.

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
  lookup: false,
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

Low-level hosts that call `registerChannelTools()` directly still own
session-specific availability narrowing when they omit `tools`; changing that
host contract is deferred to a separately versioned API design.

## Provider pages

- [Slack](slack.md)
