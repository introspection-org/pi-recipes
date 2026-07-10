# MCP authentication in recipe sessions

Recipe MCP authentication follows the binding that made an already-approved
server reachable. Authentication never selects a server or grants tools: the
materialized package, binding, and active-agent policies still determine the
final server/tool inventory.

## Local OAuth

Local users may declare OAuth on a server in the workspace- or recipe-local
`.pi/mcp.local.json`:

```json
{
  "servers": [
    {
      "id": "linear",
      "transport": "streamable_http",
      "url": "https://mcp.linear.app/mcp",
      "auth": "oauth",
      "oauthClientId": "optional-pre-registered-client-id",
      "oauthClientSecretEnv": "LINEAR_OAUTH_CLIENT_SECRET",
      "oauthRedirectUrl": "http://127.0.0.1:8787/callback",
      "oauthScope": "optional provider-specific scopes"
    }
  ]
}
```

Only `auth: "oauth"` enables interactive authorization. Tool discovery during
local session startup may complete the browser flow and preserves mcporter's
token cache and refresh behavior for that configured server. After the server
has materialized, `mcp auth linear --reset` can refresh its credentials;
`--no-browser` prints the URL for a headless local terminal. Calls and `mcp run`
may also complete OAuth for that same configured server.

The session CLI does not accept OAuth URLs, ad-hoc servers, config imports, or
configuration mutation. A local user configures connectivity outside the agent
through `.pi/mcp.local.json`; the agent can authenticate only a server already
present in the filtered session manifest.

## Managed Introspection bindings

Introspection deployments do not run interactive OAuth. An MCP endpoint is
configured in the project bindings UI with either:

- an authorized application, which signs a per-task identity assertion; or
- stored headers, such as `Authorization: Bearer <token>` or `X-API-Key`.

The sandbox receives a task session token and the endpoint URL. The egress
layer replaces that token with the configured application assertion or stored
headers for the destination host; upstream credentials are not written into
the recipe workspace. `mcp list`, `mcp call`, and `mcp run` force non-interactive
operation for these bindings, and `mcp auth` rejects them.

## Agent-facing command boundary

Recipe sessions expose only `mcp search`, `mcp list`, `mcp call`, `mcp run`,
and conditional `mcp auth <configured-local-oauth-server>`. Administrative and
developer commands (`config`, `vault`, `generate-cli`, `emit-ts`, `record`,
`replay`, `daemon`, and `serve`) are intentionally unavailable. URL selectors,
ad-hoc HTTP/stdio transports, config overrides, and persistence flags are also
rejected. The upstream `--tail-log` call flag is also unavailable because it
reads an absolute local path supplied by an MCP result; server output must not
choose files for an agent session to read.

This command policy prevents accidental escape from the materialized MCP
surface. It is not an OS or network sandbox: the enclosing local shell or
managed runtime remains responsible for filesystem, process, and egress
isolation.
