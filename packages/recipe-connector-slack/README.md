# Slack connector for Introspection Recipes

This package provides Slack Bot API tools for Recipes. A recipe installs it
when its `package.json#pi.connectors` list includes the `slack` provider.

Recipe authors declare the tools in `package.json`. They do not write an
extension or call the Slack client directly.

```json
{
  "dependencies": {
    "@introspection-ai/recipe-connector-slack": "^0.1.0"
  },
  "pi": {
    "connectors": [
      {
        "provider": "slack",
        "tools": {
          "include": ["origin", "read_thread", "send_message"]
        }
      }
    ]
  }
}
```

Install the recipe dependencies before running `introspection local`. The
cloud runtime installs the locked production dependencies when it builds a
recipe image or starts an `introspection dev` overlay.

The package calls the Slack Web API. It does not use hosted MCP, Socket Mode,
WebSockets, or streaming.

See the [Slack tool guide](../../docs/slack.md) for tool behavior and testing.
