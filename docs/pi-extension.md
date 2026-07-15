# Pi Recipe Extension

The Pi recipe extension resolves a recipe directory, selects a recipe agent, and
maps recipe resources into the live Pi session.

## Install

Install the recipe tooling:

```bash
npm install -g @introspection-ai/pi-recipes
```

`recipes install ...` automatically installs this companion extension into
Pi when it is missing. To set it up explicitly:

```bash
recipes setup
```

Manual Pi installation is still available:

```bash
pi install npm:@introspection-ai/pi-recipes
```

For a local clone:

```bash
pnpm install
pnpm build
pi install "$(pwd)"
```

Re-run `pnpm build` after changing extension source.

## Launch

Launch with a local recipe directory:

```bash
pi --recipe /path/to/recipe
```

Launch with an installed recipe:

```bash
recipes install github:owner/repo
pi --recipe owner/repo
pi --recipe recipe-name
```

Select an explicit recipe agent:

```bash
pi --recipe recipe-name --agent reviewer
```

Environment variable equivalents:

```bash
PI_RECIPE_DIR=recipe-name pi
PI_RECIPE_DIR=recipe-name PI_AGENT_NAME=reviewer pi
```

`--recipe` accepts:

- an existing local directory
- an installed short recipe name
- an installed scoped recipe name

The extension resolves installed recipes from the `recipes` store. Set
`PI_RECIPES_HOME` if Pi should use a non-default store.

## Launch Flow

On session startup, the extension:

1. Reads `--recipe` or `PI_RECIPE_DIR`.
2. Resolves the value as a local directory or installed recipe.
3. Loads the recipe manifest from `package.json`.
4. Selects the active recipe agent.
5. Loads declared recipe extensions.
6. Sets the Pi session name.
7. Sets the model and thinking level from the selected agent when specified.
8. Selects active tools from the selected agent.
9. Returns recipe resources for skills and prompts.
10. Composes the runtime system prompt from recipe-owned `SYSTEM.md` and selected agent instructions, falling back to Pi defaults when the recipe has no system prompt.

The current Pi working directory remains the user's project workspace. Recipe
metadata and filesystem paths are not injected into the system prompt.

## Manifest File

`package.json` is the recipe manifest. Top-level package fields tell Pi what
recipe this is:

- `name`, `version`, and `description`

The `pi` block tells Pi which recipe-owned files should be loaded:

- agent definition globs
- extension globs
- skill and prompt paths

The same file also carries normal Node package metadata for extension
dependencies. Add `dependencies`, `peerDependencies`, `packageManager`, and a
lockfile when TypeScript extensions under `extensions/` import npm packages.

Minimal example:

```json
{
  "name": "my-recipe",
  "version": "0.1.0",
  "description": "A short description of what this recipe is for.",
  "type": "module",
  "pi": {
    "agents": ["agents/*.yaml"]
  }
}
```

## Agent Selection

Selection order:

1. `--agent` or `PI_AGENT_NAME`
2. `agents/agent.yaml`
3. the only available agent

If multiple agents exist and no default can be inferred, launch fails with a
clear error.

Agent files are YAML:

```yaml
name: agent
description: Main coordinator
model:
  name: openai/gpt-5.4
  thinking_level: medium
tools:
  - read
  - bash
skills:
  - repo-index
subagents:
  - explorer
system_instructions:
  mode: append
  content: |
    Extra instructions for this agent.
```

A named variant is another agent that inherits from a base with `from:`:

```yaml
name: agent-opus
from: agent
model:
  name: openrouter/anthropic/claude-opus-4.8
```

Objects such as `model`, `extensions`, and `mcp` merge by key. Arrays such as
`tools`, `skills`, and `subagents` replace the inherited array. Within
`extensions`, a child's `include` or `exclude` replaces that selector list.
Within `mcp`, servers merge by id, and each child's `include` or `exclude`
replaces that server's corresponding list while inheriting the other list.

`system_instructions.mode` can be:

- `append`: append to the current prompt
- `replace`: replace the current prompt

Use `content: ""` when an agent intentionally adds no instructions beyond
`SYSTEM.md` but still needs to declare the field explicitly.

## Session Prompt

The session prompt uses recipe `SYSTEM.md` when present, otherwise Pi's base
system prompt, then applies the selected agent's `system_instructions` according
to its `append` or `replace` mode. Pi-recipes does not add capability notices,
filesystem paths, or other implicit instructions. Recipes own all durable
workflow guidance without changing where the user is working.

## Tools

The selected agent controls active tools:

```yaml
tools:
  - read
  - bash
  - WebFetch
```

If the selected agent has visible subagents, the extension also enables the
recipe `agent` tool.

Recipe extensions must be loaded before active tools are selected, because they
can register additional tools such as `WebFetch`, `WebSearch`, `todo_write`, or
custom workflow tools.

The selected agent can gate which declared recipe extensions load:

```yaml
extensions:
  include:
    - "*"
  exclude:
    - optional-runtime
```

Omitting `extensions` or `extensions.include` loads all declared recipe
extensions. `exclude` subtracts matching extension names.

## MCP

Recipes can expose MCP endpoint tools through a generated session-local `mcp` CLI.
The recipe declares an upper-bound MCP server policy in `package.json#pi.mcp`,
and each agent declares its own MCP selection in a separate `mcp` block.
Ordinary `tools` remains an exact allowlist of Pi built-ins and extension tools.

Example `package.json`:

```json
{
  "pi": {
    "agents": ["agents/*.yaml"],
    "mcp": {
      "manifest": "mcp.json",
      "servers": [
        {
          "id": "contacts",
          "required": true,
          "tools": {
            "include": ["*"],
            "exclude": ["delete_workspace", "purge_contacts"]
          }
        }
      ]
    }
  }
}
```

Example agent:

```yaml
tools:
  - bash
mcp:
  contacts:
    include:
      - "*"
    exclude:
      - delete_contact
```

Package selectors are local to their server: use `"*"` for all tools or a bare
tool name for one tool. Agent MCP policy is keyed by server and uses the same
bare tool names. Every server entry must declare `include`: use `["*"]` for all
package-permitted tools, an exact list for a subset, or `[]` for none.
`exclude` subtracts exact names after inclusion. Omitting a server gives the
agent no access to it; omitting the entire `mcp` block gives it no MCP access.
Empty package `tools`, agent server (`contacts: {}`), and agent `mcp: {}`
objects are invalid rather than implicit wildcards.

Package declaration, endpoint binding, and agent selection are independent
gates. A bound server that is absent from `package.json#pi.mcp.servers` is
ignored, and an agent cannot select it. An empty package server list therefore
permits no MCP servers; creating a local or cloud binding never grants access
by itself.

`"*"` is a reserved whole-toolset sentinel, not a glob. Patterns such as
`search_*` are invalid. An explicit wildcard opts into tools that the remote
server may add later; use exact includes when that behavior is not desired.

Package and agent MCP policies use only `include` and `exclude`. MCP tools are
selected only through the agent `mcp` block; the ordinary `tools` list remains
an explicit list of non-MCP tools.

`recipes check` owns detailed static MCP diagnostics, including:
`agent.mcp_server_undeclared`, `agent.mcp_tool_undeclared`,
`agent.mcp_include_missing`, `agent.mcp_empty`, and
`agent.mcp_selector_invalid`. The TypeScript runtime uses a generic fail-closed
guard so an invalid policy cannot launch silently without duplicating those
diagnostics. Runtime configuration also reports a zero-tool intersection for a
package-pinned catalog as `mcp.tools_filtered`.

When the selected agent declares MCP access, the extension writes a
session-local shim at `.pi/bin/mcp` and prepends `.pi/bin` to `PATH` for
commands run from that Pi session. It writes the static package, agent, and
binding policy to `.pi/mcp-session.json` and an
[mcporter](https://github.com/openclaw/mcporter) config to `.pi/mcporter.json`
in the workspace. Launch does not contact MCP servers. `list` discovers only
the requested server, while `search` discovers configured servers in parallel.
`call` validates the static policy and connects directly without listing tools
first. Discovered catalogs are cached by policy and endpoint fingerprint in
`.pi/mcp-catalogs/` for the sandbox lifetime. Agents can use:

Because MCP endpoint tools are invoked through the session-local CLI, agents
normally need `bash` or another command-capable tool. Recipe validation emits a
non-blocking warning when an agent declares MCP access without `bash`;
recipes that provide a custom shell wrapper may intentionally ignore it.

```bash
mcp search "contact lookup"              # find relevant tool references
mcp list                                 # configured servers and tool counts
mcp list contacts                         # compact tool signatures
mcp list contacts.search_contacts --schema # compact input/output contract
mcp call contacts.search_contacts query="Ada Lovelace"
mcp run <<'JS'                           # batch or compose calls in JavaScript
const result = await tools["contacts"]["search_contacts"]({ query: "Ada Lovelace" })
console.log(JSON.stringify(result, null, 2))
JS
```

`mcp list` and `mcp call` delegate listing, argument coercion, tool execution,
and result formatting to mcporter against the session config. The
recipe wrapper enforces the static server/tool policy, blocks
configuration and ad-hoc transport escapes, keeps calls headless, rejects
ambiguous duplicate or malformed call input, and removes non-actionable error
stacks. Calls preserve actual server results; metadata uses compact text. An exact
`mcp list <server.tool> --schema` renders one token-efficient input/output
contract. Raw JSON is reserved for actual tool results.

Pi-recipes does not add MCP instructions to the system prompt. A recipe that
wants its agent to use the session-local `mcp` command must say so explicitly in
its own `SYSTEM.md` or selected agent instructions. CLI syntax, server
tool discovery, and schemas remain progressively available through `mcp
--help`, `mcp list`, and `mcp search`.

Only exact tool names in the runtime inventory or `mcp list` output are
callable. Upstream tool descriptions can mention related tools that are not
exposed by the recipe policy; those mentions are documentation, not capability
grants. If no available tool supports an action, the agent should report that
the connected capability is unavailable rather than guessing an unlisted tool.

Use `mcp search` to find relevant tool references without printing every schema.
Search covers tool names, descriptions, argument names, and argument
descriptions. Arguments are `key=value` pairs with automatic type
coercion; use `--json` for nested objects and arrays. `key=@file.md` reads a
value from a file, and `--output json` prints a
machine-parseable result. Use `mcp run` when a workflow needs multiple calls,
local filtering, ranking, or deduplication before printing a compact result.
If search does not find a match, retry with broader or alternate terms. Use
`mcp list <server>` only to identify exact tool names, then inspect one candidate with
`mcp list <server.tool> --schema`; avoid server-wide schema dumps during normal
agent workflows.
Every tool call in a run script must be awaited or its chain returned; merely
attaching `.then()` or `.catch()` is insufficient when the chain remains pending
as the script exits. Run workflows have bounded wall time, per-call time, total
calls, and concurrency. Calls beyond the concurrency limit wait in FIFO order
and inherit the remaining workflow deadline. Per-call deadlines are forwarded
to the MCP client; on a workflow timeout, queued calls are cancelled and active
transports are closed. Because a remote mutation may already have committed,
timeout diagnostics still treat its outcome as unknown. Structured MCP errors
retain recovery fields such as `code`, `retryable`, `action`, `request_id`, and
`outcome` on the thrown error and in `--json-errors` output.

Every call returns decoded JSON by default. When a tool explicitly documents a
different response type, select it on the tool function with `.text(args)`,
`.markdown(args)`, `.images(args)`, `.content(args)`,
`.structuredContent(args)`, or `.raw(args)`. Calls in every format share the
same await detection, queue, deadline, typed-error, and allowlist enforcement.
Interactive OAuth is disabled: configured headers and cached credentials are
usable, but a failed bearer token cannot launch a browser flow from the agent.

`mcp run` executes JavaScript with the same OS privileges as the active shell
sandbox. It is a composition convenience, not a second security boundary; the
recipe allowlist controls which MCP tools are reachable, while the outer runtime
remains responsible for filesystem, environment, process, and network isolation.

The `mcp` command is a pi-recipes wrapper backed by mcporter, installed as a
package dependency; the shim pins `MCPORTER_CONFIG` to the generated session
config, so a recipe session only ever sees the servers and tools its policy
allows — never host-level mcporter or editor MCP configs. Header values in the
generated config stay `${VAR}` environment references; secrets are resolved by
mcporter at call time and are not written to disk.

The session records the generated paths in `PI_RECIPES_MCP_SESSION`,
`MCPORTER_CONFIG`, and `PI_RECIPES_MCP_BIN_DIR`.

For local endpoint bindings, use `.pi/mcp.local.json` in the workspace or recipe
directory. To override that path, set `PI_RECIPES_MCP_LOCAL_CONFIG`. Header
values can reference environment variables such as `${CONTACTS_MCP_TOKEN}`.
Local bindings may instead declare `auth: "oauth"`. The agent-facing CLI is
always headless; local users complete OAuth with mcporter outside the agent
session, while hosted environments supply their configured credentials. See
[MCP authentication](mcp-auth.md).

`recipes install` creates the recipe-local `.pi/mcp.local.json` template for MCP
recipes if it is missing and prints the env vars that need values. The extension
does not translate or adapt MCP tool names. The server must expose the tool names
declared by the selected recipe agent, or `mcp call` fails with the underlying
MCP error.

## Commands

When a recipe is active, the extension registers:

```text
/recipe
/recipe reload
```

`/recipe` shows:

- active recipe name and version
- selected agent
- selected model and thinking level
- visible subagents
- active recipe tools
- recipe directory
- project workspace

`/recipe reload` asks Pi to reload extensions, skills, and prompts, and
clears the cached recipe manifest and agent state first. Use it after editing a
local recipe's `package.json`, agent files, resources, or extension code.

## Resources

The extension responds to Pi `resources_discover` with:

- `skillPaths`
- `promptPaths`

Declared manifest paths are used first. When omitted, conventional folders are
used if present:

- `skills`
- `prompts`

Skills become Pi `/skill:name` commands. Prompt templates are surfaced through
Pi's normal resource system.

## Subagents

Recipe subagents are other agents from the same recipe, exposed through the
`agent` tool.

If the selected agent declares `subagents`, only those agents are visible:

```yaml
name: agent
subagents:
  - explorer
  - reviewer
```

If it omits `subagents`, every other recipe agent is visible.

The `agent` tool accepts:

- `name`: child agent name
- `prompt`: delegated instructions
- `label`: optional display label
- `output_path`: optional workspace or `/tmp` file for the final output
- `wait`: block for the new run, defaulting to `false`
- `action`: `start`, `status`, `wait`, `message`, `interrupt`, or `close`
- `id`: child-run id for management actions
- `ids`: child-run ids for joining multiple runs with `action: "wait"`
- `message`: follow-up instructions for `action: "message"`
- `timeout_ms`: optional join timeout; timing out never stops the agents

Starts run in the background by default. Use `wait: true` only when the parent
must block immediately, or use `action: "wait"` later to join existing runs.
Completed local agents retain their Pi sessions until closed, so follow-up
messages preserve context. Child runs use the same recipe directory and current
Pi workspace as the parent session, but child questions never interrupt the
root: approvals auto-approve and questions auto-decline.

## Recipe Extensions

Recipes can declare Pi extensions:

```json
{
  "pi": {
    "extensions": ["extensions/*.ts", "extensions/*/index.ts"]
  }
}
```

Extensions are loaded during `session_start`. If one extension fails, Pi shows a
warning and continues loading the rest of the recipe. During local recipe
development, run `/recipe reload` after editing extension files to reload them
without restarting Pi.

Extension glob branches are optional, so a recipe can declare both flat and
nested extension layouts without failing when one branch has no matches.

Extensions are loaded with module resolution rooted at the recipe directory. If
an extension imports a third-party package, declare that dependency in the
recipe's `package.json` and install/register the recipe with `recipes install`
so dependencies are installed into the recipe directory. For remote Git recipes,
commit a lockfile with the recipe.

Example layout:

```text
my-recipe/
  package.json
  package-lock.json
  agents/
    agent.yaml
  extensions/
    tools.ts
```

Example dependency manifest:

```json
{
  "name": "hello-tools",
  "version": "0.1.0",
  "type": "module",
  "pi": {
    "agents": ["agents/*.yaml"],
    "extensions": ["extensions/*.ts"]
  },
  "dependencies": {
    "zod": "^4.0.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

Generate the lockfile from inside the recipe directory:

```bash
cd my-recipe
npm install --package-lock-only
recipes install .
```

For a remote Git recipe, commit `package.json` and the lockfile.
When users run `recipes install github:owner/repo`, the CLI installs production
dependencies into that cloned recipe before Pi loads extensions.

Imports of Pi runtime packages such as `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai`, and `typebox` are resolved to the host Pi installation.
Declare those as peers in the recipe `package.json` rather than bundling another
copy.

Use normal `dependencies` for packages your extension imports at runtime. Use
`devDependencies` only for local recipe development tools; they are not needed
for Pi to run the recipe.

Example extension:

```ts
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const extension: ExtensionFactory = (pi) => {
  pi.registerTool(
    defineTool({
      name: "hello_recipe",
      label: "Hello",
      description: "Return a greeting from the recipe.",
      parameters: Type.Object({ name: Type.String() }),
      async execute(_id, params) {
        return { content: [{ type: "text", text: `Hello ${params.name}` }] };
      },
    })
  );
};

export default extension;
```

## Troubleshooting

If Pi cannot find an installed recipe, check the store:

```bash
recipes list
recipes path recipe-name
```

If Pi and `recipes` are using different stores, set:

```bash
PI_RECIPES_HOME=/path/to/store pi --recipe recipe-name
```

If an agent selects a model but Pi reports the model is unavailable, confirm the
model provider exists in Pi and the corresponding API key is configured.

If a recipe tool is listed in an agent but not active, confirm the extension
that registers the tool is declared in the recipe manifest and loads without a
warning.

If an extension fails with `Cannot find module`, confirm the dependency is in
the recipe `package.json`, the recipe was installed with `recipes install`, and the
dependency was written to the recipe's `node_modules`.
