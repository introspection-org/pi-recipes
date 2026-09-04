# Slack connector for Introspection Recipes

The Slack adapter for the provider-neutral
[channel tools](https://github.com/introspection-org/recipes/blob/main/docs/channels.md).
A Recipe installs it when its `package.json#pi.connectors` list includes the
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
    "connectors": [
      {
        "provider": "slack"
      }
    ]
  }
}
```

`channel_reply` answers the origin. `channel_send` takes an explicit channel
and optional thread; `channel_read` accepts optional channel/thread targets.
Recipe authors select tools in the agent YAML:

```yaml
tools: [channel_reply, channel_send, channel_read, channel_react, channel_fetch_file]
```

Targets use the existing connection. This package does not add backend binding
authorization or cross-channel reply routing. Handles are session-local. Thread
reads page forward in bounded requests; channel timelines page backward.

Install the recipe dependencies before running `introspection local`. The cloud
runtime installs the locked production dependencies when it builds a recipe
image or starts an `introspection dev` overlay.

The package calls the Slack Web API. It does not use Socket Mode, WebSockets,
or streaming. Operations outside the declared `channel_*` tool set are
unsupported.

See the [Slack connector guide](https://github.com/introspection-org/recipes/blob/main/docs/slack.md)
for tool behavior and testing.
