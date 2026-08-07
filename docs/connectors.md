# Connectors

A connector is a project-managed credential and ingress binding for an external
app. A Recipe declares which connector-backed apps its runtime needs; the
platform resolves the customer's connection and mounts each app as an MCP
server.

Recipes does not define provider-specific connector tools or transport provider
tokens. The existing MCP policy controls the tools the agent may call, and the
host applies connector credentials outside the sandbox.

## Declare connector-backed apps

The deployment manifest declares connector requirements as app slugs:

```yaml
# .introspection/my-agent.yaml
runtime:
  connectors: [slack, linear, notion]
```

The Recipe package separately declares the authorized MCP tool set for each
app:

```json
{
  "pi": {
    "mcp": {
      "servers": [
        {
          "id": "slack",
          "required": false,
          "tools": {
            "include": ["send_message", "read_thread", "read_history"]
          }
        },
        {
          "id": "linear",
          "required": false,
          "tools": {
            "include": ["get_issue", "create_comment", "update_issue"]
          }
        },
        {
          "id": "notion",
          "required": false,
          "tools": {
            "include": ["search", "get_page", "create_page"]
          }
        }
      ]
    }
  }
}
```

The deployment declaration is deliberately only a list:

- Tool curation belongs to `pi.mcp.servers`.
- OAuth scopes and provider registration belong to the platform connector.
- Customer and workspace selection comes from the task's origin connection.
- Credentials are resolved and injected at the platform egress boundary.

First-party apps and aggregator-backed apps use the same deployment shape. The
Recipes checker validates the package MCP policy; deployment tooling validates
the connector requirements and project bindings.

## Local development

Local Pi uses the normal MCP configuration path. Define the server endpoints in
`.pi/mcp.local.json` (or its example file) and keep credentials out of the
Recipe. A deployed host replaces those local bindings with the connector-backed
MCP endpoints appropriate to the task and project.

See [MCP configuration](mcp-configuration.md) for server declarations, local
bindings, and model visibility.
