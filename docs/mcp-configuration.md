# MCP configuration

MCP authorization is the intersection of two fail-closed policy gates: the
package boundary and the subsets selected by the active agent and its visible
subagents. The authorized server must
also have a reachable endpoint, supplied either by a package-declared MCP
manifest or by a local/host binding. A binding supplies connectivity; it never
expands authorization.

```text
package policy  ∩  active/visible-agent selections  =  authorized tools
       package.json#pi.mcp             agents/*.yaml#mcp
                              +
 endpoint from package manifest or local/host binding
                              ↓
                     session-local mcp CLI
```

## 1. Declare the package boundary

`package.json#pi.mcp` declares the servers a Recipe may use and the maximum
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

`manifest` accepts a single path; `manifests` accepts an array, and either the
`mcp` value or a manifest reference may be given as a string shorthand for a
single path. A server marked `"required": true` must resolve to a bound endpoint
at session materialization or the session fails closed rather than starting
without the capability.

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

## 3. Supply endpoint configuration

A referenced MCP manifest can carry a portable configured endpoint and catalog.
When connectivity varies by environment, provide an endpoint and credential
references in `.pi/mcp.local.json` for local runs, or through a host binding:

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

The `${CONTACTS_MCP_TOKEN}` reference is resolved from the environment at launch,
so export it before running the recipe locally:

```bash
export CONTACTS_MCP_TOKEN='...'
pi --recipe . --agent agent
```

Do not commit or distribute `.pi/mcp.local.json`; publish validation rejects
local configuration. Commit `.pi/mcp.local.example.json` when a binding template
is helpful. A host binds its own endpoint and credential system to the same
shape. A binding overrides a package-manifest endpoint with the same id,
but a server that the package does not permit, or that none of the active/visible
agents permit, remains unavailable.

When the local file is absent, manifest-supplied endpoints remain usable.
Required servers that need environment-specific bindings fail closed until the
local Pi environment or embedding host supplies them.

## Use capabilities from an agent

When the active agent or one of its visible subagents has MCP access, the
extension creates a session-local `mcp` command from their combined selections.
Discover narrowly, inspect one schema, then call or compose:

```bash
mcp search "contact lookup"
mcp list contacts.search_contacts --schema
mcp call contacts.search_contacts query="Ada Lovelace"
```

The command is headless and cannot add servers, mutate configuration, or start
browser authentication. See [MCP authentication](mcp-auth.md) for OAuth and
hosted binding details, and [Recipes extension](pi-extension.md) for the
full session contract.
