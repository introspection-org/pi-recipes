# Microsoft Teams connector for Introspection Recipes

The Teams adapter for the provider-neutral [channel tools](../../docs/channels.md).
A Recipe installs it when its `package.json#pi.connectors` list includes the
`teams` provider.

```json
{
  "dependencies": {
    "@introspection-ai/recipe-channel-teams": "^0.1.0"
  },
  "pi": {
    "connectors": [
      {
        "provider": "teams"
      }
    ]
  }
}
```

The package uses the Bot Framework Connector credential that every Teams bot
has. It registers `channel_reply`. Reading earlier messages, reactions, and
file access need Microsoft Graph consent, so those tools are absent.

See the [Teams connector guide](../../docs/teams.md).
