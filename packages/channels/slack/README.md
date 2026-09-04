# Slack connector for Introspection Recipes

The Slack adapter for the provider-neutral
[channel tools](https://github.com/introspection-org/recipes/blob/main/docs/channels.md).
A Recipe installs it when its `package.json#pi.connectors` list includes the
`slack` provider.

The package supplies Slack Web API transport and a capability descriptor. The
tool names and schemas come from `@introspection-ai/recipes/channels`, so a
Recipe written against `channels reply` is not written against Slack.

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

`channels reply` answers the origin. `channels list` returns the public and
private channels available to the bot. `channels send` takes an explicit channel
and optional thread; `channels read` accepts optional channel/thread targets.
Recipe authors select tools in the agent YAML:

```yaml
tools: [channels]
```

Targets use the existing connection. This package does not add backend binding
authorization or cross-channel reply routing. Handles are session-local. Thread
reads page forward in bounded requests; channel timelines page backward.

Install the recipe dependencies before running `introspection local`. The cloud
runtime installs the locked production dependencies when it builds a recipe
image or starts an `introspection dev` overlay.

The package calls the Slack Web API. It does not use Socket Mode, WebSockets,
or streaming. Operations outside the declared `channels` command set are
unsupported.

See the [Slack connector guide](https://github.com/introspection-org/recipes/blob/main/docs/slack.md)
for tool behavior and testing.
