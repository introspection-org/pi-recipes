# Slack connector for Introspection Recipes

The Slack adapter for the provider-neutral
[channel tools](https://github.com/introspection-org/recipes/blob/main/docs/channels.md).
A Recipe installs it when its `package.json#pi.connectors` list includes the
`slack` provider.

The package supplies Slack Web API transport and a capability descriptor. The
tool names and schemas come from `@introspection-ai/recipes/channels`, so a
Recipe written against `channel_reply` or `channel_notify` is not written
against Slack.

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

`channel_reply` acts only on the conversation the task came from. A scheduled
task may use `channel_notify` for interim updates to a trusted Operator target;
the extension sends its final response there automatically after the run
settles. No tool takes a channel, thread, or user argument. Recipe authors
select tools in the agent YAML file and do not write an extension or call the
Slack client directly.

Install the recipe dependencies before running `introspection local`. The cloud
runtime installs the locked production dependencies when it builds a recipe
image or starts an `introspection dev` overlay.

The package calls the Slack Web API. It does not use Socket Mode, WebSockets,
or streaming. Operations outside the declared `channel_*` tool set are
unsupported.

See the [Slack connector guide](https://github.com/introspection-org/recipes/blob/main/docs/slack.md)
for tool behavior and testing.
