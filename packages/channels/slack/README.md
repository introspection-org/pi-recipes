# Slack connector for Introspection Recipes

The Slack adapter for the provider-neutral
[channel tools](https://github.com/introspection-org/recipes/blob/main/docs/channels.md).
A Recipe installs it when its `package.json#pi.channels` list includes the
`slack` provider.

The package supplies Slack Web API transport and a capability descriptor. The
tool names and schemas come from `@introspection-ai/recipes/channels`, so a
Recipe written against `channel_reply` is not written against Slack.

```json
{
  "dependencies": {
    "@introspection-ai/recipe-channel-slack": "^0.1.0"
  },
  "pi": {
    "channels": [
      {
        "provider": "slack"
      }
    ]
  }
}
```

Every registered tool acts on the conversation the task came from; none takes a
channel, thread, or user argument. Recipe authors select tools in the agent YAML
file and do not write an extension or call the Slack client directly.

Use `introspection dev` to test channel recipes. The cloud runtime installs the
locked production dependencies and receives Slack events for your local Recipe
files. Standalone channel access through `introspection local` is not supported.

The package calls the Slack Web API. It does not use Socket Mode, WebSockets,
or streaming. Operations outside the declared `channel_*` tool set are
unsupported.

See the [Slack connector guide](https://github.com/introspection-org/recipes/blob/main/docs/slack.md)
for tool behavior and testing.
