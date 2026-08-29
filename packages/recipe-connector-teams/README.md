# Microsoft Teams connector for Introspection Recipes

The Teams adapter for the provider-neutral [channel tools](../../docs/channels.md).
A Recipe installs it when its `package.json#pi.connectors` list includes the
`teams` provider.

```json
{
  "dependencies": {
    "@introspection-ai/recipe-connector-teams": "^0.1.0"
  },
  "pi": {
    "connectors": [
      {
        "provider": "teams",
        "package": "@introspection-ai/recipe-connector-teams",
        "tools": { "include": ["info", "reply", "edit", "retract"] }
      }
    ]
  }
}
```

The package speaks the Bot Framework Connector — the credential every Teams bot
has. It registers the same tool names Slack does, minus what Teams cannot do
without tenant-granted Microsoft Graph consent: there is no `channel_history`,
no `channel_react`, and no `channel_fetch_file`. Those tools are absent rather
than failing, which is what the capability descriptor is for.

See the [Teams connector guide](../../docs/teams.md).
