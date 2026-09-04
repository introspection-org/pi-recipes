# Slack connector for Introspection Recipes

The Slack adapter for the provider-neutral
[channel tools](https://github.com/introspection-org/recipes/blob/main/docs/channels.md).
A Recipe installs it when its `package.json#pi.connectors` list includes the
`slack` provider.

The package supplies Slack Web API transport and a capability descriptor. The
tool names and schemas come from `@introspection-ai/recipes/channels`, so a
Recipe written against `channel_message` is not written against Slack.

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

`channel_message` requires a channel id and accepts an optional thread id.
Channel-connection sessions are bound to their inbound conversation; eligible
Operator sessions may post to any channel the injected Slack bot credential can
access. Operator tasks can resolve a complete channel name with
`channel_lookup`. Messages are published only through explicit tool calls.
Recipe authors select tools in the agent YAML file and do not write an extension
or call the Slack client directly.

The cloud runtime installs the locked production dependencies when it builds a
recipe image or starts an `introspection dev` overlay.

The package calls the Slack Web API. It does not use Socket Mode, WebSockets,
or streaming. Operations outside the declared `channel_*` tool set are
unsupported.

See the [Slack connector guide](https://github.com/introspection-org/recipes/blob/main/docs/slack.md)
for tool behavior and testing.
