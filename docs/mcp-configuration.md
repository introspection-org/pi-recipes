# MCP configuration

MCP capability is resolved through three independent gates. No layer grants
access by itself.

```text
package policy       agent selection       environment binding
package.json#pi.mcp  agents/*.yaml#mcp     .pi/mcp.local.json or host
        └─────────────── intersection ───────────────┘
                            ↓
                   session-local mcp CLI
```

## 1. Declare the package boundary

`package.json#pi.mcp` declares the servers a recipe may use and the maximum
tool set available from each one. It can also reference portable MCP manifests.

```json
{
  "pi": {
    "mcp": {
      "manifest": "mcp.json",
      "servers": [
        {
          "id": "contacts",
          "required": true,
          "tools": {
            "include": ["search_contacts", "get_contact"],
            "exclude": []
          }
        }
      ]
    }
  }
}
```

Prefer exact tool names. `"*"` explicitly permits the package-visible tool set,
including tools a server may add later; patterns such as `search_*` are invalid.

## 2. Narrow access for each agent

An agent selects a subset of the package-permitted servers and tools. It cannot
add capability that the package did not declare.

```yaml
tools:
  - bash
mcp:
  contacts:
    include:
      - search_contacts
```

Omitting a server—or the entire agent `mcp` block—means no access. `exclude`
removes exact names after inclusion and always wins. MCP tools are selected here,
not in the agent's ordinary `tools` list.

## 3. Bind the environment

Policy is portable; connectivity is environment-specific. For local runs,
provide endpoints and credential references in `.pi/mcp.local.json`:

```json
{
  "servers": [
    {
      "id": "contacts",
      "transport": "streamable_http",
      "url": "https://contacts.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${CONTACTS_MCP_TOKEN}"
      }
    }
  ]
}
```

Commit an example when helpful, but never commit credentials. A hosted runtime
binds its own endpoint and credential system to the same shape. A bound server
that the package and selected agent do not permit remains unavailable.

`recipes install` creates `.pi/mcp.local.json` when the recipe declares MCP and
the file is absent, using `.pi/mcp.local.example.json` when provided or a
generated template otherwise.

## Use capabilities from an agent

When the selected agent has MCP access, the extension creates a session-local
`mcp` command. Discover narrowly, inspect one schema, then call or compose:

```bash
mcp search "contact lookup"
mcp list contacts.search_contacts --schema
mcp call contacts.search_contacts query="Ada Lovelace"
```

The command is headless and cannot add servers, mutate configuration, or start
browser authentication. See [MCP authentication](mcp-auth.md) for OAuth and
hosted binding details, and [Pi Recipes extension](pi-extension.md#mcp) for the
full runtime contract.
