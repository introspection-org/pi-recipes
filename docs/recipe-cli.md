# Recipe CLI

`recipes` is the Pi recipe manager. It installs, registers, lists, removes,
validates, scaffolds, and publishes recipe folders for Pi.

## Install

Install the recipe tooling into the environment where you run Pi:

```bash
npm install -g @introspection-ai/pi-recipes
```

The first `recipes install ...` run checks whether the companion Pi extension
is installed. If it is missing, `recipes` runs:

```bash
pi install npm:@introspection-ai/pi-recipes
```

You can run setup explicitly:

```bash
recipes setup
```

For local development:

```bash
pnpm install
pnpm build
pnpm link --global
recipes setup "$(pwd)" --force
```

The CLI binary is `recipes`:

```bash
recipes --help
```

The package also bundles MCP CLI implementation code for recipe sessions, but
does not install `mcp` as a global binary. When a Pi session launches a recipe
whose selected agent declares MCP access, the extension creates a session-local
`.pi/bin/mcp` shim and prepends that directory to the Pi session's bash `PATH`.
The generated paths are recorded in `PI_RECIPES_MCP_SESSION` and
`PI_RECIPES_MCP_BIN_DIR`.

When `recipes install` installs a recipe that declares `pi.mcp`, it also creates
`.pi/mcp.local.json` in the installed recipe if that file is missing. If the
recipe ships `.pi/mcp.local.example.json`, install copies it; otherwise install
generates a template from `pi.mcp.servers`. The install output prints the config
path and the environment variables referenced by the template.

## Store

Recipes are tracked in a local store:

```text
~/.pi/recipes/recipes.json
```

Use a different store with either:

```bash
PI_RECIPES_HOME=/path/to/store recipes list
recipes list --store /path/to/store
```

Remote Git recipes are cloned into the store. Local recipes are registered by
path, so edits to the local directory are immediately visible to the harness.
If a recipe declares extension runtime dependencies in `package.json`,
`recipes install` installs them in that recipe directory.

## Create a Recipe

Create a starter recipe with:

```bash
recipes create ./my-recipe
```

This writes a working recipe skeleton:

```text
my-recipe/
  package.json
  README.md
  SYSTEM.md
  agents/
    agent.yaml
```

Use `--name` when the directory name is not the recipe identifier you want:

```bash
recipes create ./recipes/code-review --name code-review
```

`recipes create` refuses to overwrite existing scaffold files unless `--force` is
provided. After generating the starter, edit the files to fit your workflow.

Minimal `package.json`:

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

Minimal `agents/agent.yaml`:

```yaml
name: agent
description: Main recipe agent.
model:
  name: openai/gpt-5.4
  thinking_level: medium
tools:
  - read
  - bash
system_instructions:
  mode: append
  content: |
    Follow the recipe's workflow.
```

`agents/agent.yaml` is the conventional default entrypoint. A named variant is
another agent that inherits from a base with `from:`:

```yaml
name: agent-high-recall
from: agent
model:
  thinking_level: high
```

`SYSTEM.md` is shared by every root and delegated agent in the recipe.
`system_instructions` specializes the selected agent. `from:` derives a complete
agent definition with field-specific merge rules: objects merge selectively,
arrays replace, and explicit `[]` clears an inherited array. See
[Agent Composition](agent-composition.md) for the full inheritance matrix,
prompt layering, capability selection, and subagent behavior.

## Develop a Recipe

Validate the current recipe directory:

```bash
recipes check .
```

`check` checks the manifest, resolves declared resources, catches missing
required agent globs, validates optional direct-child `judges/*.yaml` and
`judges/*.yml` definitions, validates Harbor eval suite pins, and warns when no
default agent can be inferred. See [Recipe judge definitions](recipe-judges.md)
for the portable authored judge contract and runtime ownership boundary.

Use the CI profile when validation should block a pull request or push:

```bash
recipes check . --profile ci
recipes check . --profile ci --json
```

The CI profile exits non-zero for invalid recipes and promotes checks that are
unsafe for committed recipes, such as missing lockfiles for runtime
dependencies.

Run the local recipe directly by path:

```bash
pi --recipe . --agent agent
```

Registration is optional when you want a stable store identifier:

```bash
recipes install ./my-recipe
```

Then inspect or run the registered name:

```bash
recipes list
recipes path my-recipe
recipes check my-recipe
```

Run it in Pi:

```bash
pi --recipe my-recipe
pi --recipe my-recipe --agent agent
```

## `package.json` and `pi`

Recipes use `package.json` as their manifest. Top-level package fields describe
the package:

- `name`: the package identity; installed recipes can also resolve by source,
  normalized scoped identity, or an unambiguous short-name alias
- `version`: optional package/display metadata shown in Pi sessions; omitted
  versions resolve as `0.0.0` for compatibility
- `description`: a short summary for humans

For distribution, the reproducible identity is the Git source plus a commit SHA,
or a tag protected by an immutable-release policy. The manifest version is not
a substitute for that source pin.

The `pi` block declares recipe-owned resources:

- `agents`: agent definition globs
- `extensions`: TypeScript extension globs
- `skills`: skill paths or globs
- `prompts`: prompt paths or globs
- `mcp`: MCP server policy and optional manifest paths
- `evals`: Harbor offline eval suite references

Normal package-manager fields such as `dependencies`, `optionalDependencies`,
`peerDependencies`, `devDependencies`, `packageManager`, and lockfile metadata
live in the same `package.json`. This keeps recipe discovery, publishing, and
extension dependency installation on one obvious path.

## Resource Folders

Declare resources in `package.json#pi` when you want explicit package
boundaries:

```json
{
  "pi": {
    "agents": ["agents/*.yaml"],
    "extensions": ["extensions/*.ts", "extensions/*/index.ts"],
    "skills": ["skills/**/SKILL.md"],
    "prompts": ["prompts"]
  }
}
```

When entries are omitted, conventional folders are used if present:

- `agents`
- `skills`
- `prompts`

`extensions` are only loaded when declared.

## MCP Manifests

See [MCP configuration](mcp-configuration.md) for the package policy, per-agent
selection, and environment-binding model in one place.

Recipes can declare MCP endpoint policy with `package.json#pi.mcp`:

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
            "include": ["*"],
            "exclude": ["delete_workspace", "purge_contacts"]
          }
        }
      ]
    }
  }
}
```

Agents opt into MCP tools through a separate YAML `mcp` block:

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

At both layers, `include` is required for each server: `["*"]` enables every
package-permitted tool, an exact list enables a subset, and `[]` enables none.
`exclude` removes exact names after inclusion and always wins. `"*"` is a
whole-toolset sentinel, not a glob; patterns such as `search_*` are invalid.
Omitting a server or the agent `mcp` block means no access. Exact includes avoid
automatically exposing tools that a remote server adds later. Missing package
`tools` fails closed with a warning. Agent server (`contacts: {}`) and empty
agent `mcp: {}` objects are valid but silently treated as omitted; none imply a
wildcard.

Package declaration and agent selection are the two authorization gates. The
authorized server also needs an endpoint from a configured package manifest or
a local/host binding. A binding never grants access by itself, and a bound server
not listed in `package.json#pi.mcp.servers` is ignored. An empty package server
list therefore permits no MCP servers.

Package and agent MCP policies use only `include` and `exclude`, and MCP tools
are selected only through the agent `mcp` block. Missing package declarations,
invalid selectors, and package-blocked agent tools are reported as validation
errors by `recipes check` rather than being silently filtered. Runtime launch
uses a generic fail-closed policy guard, while binding diagnostics distinguish
package, agent-selection, explicitly-disabled, and zero-tool-intersection
filtering.

Recipes decide how their agents invoke the session-local MCP CLI. Recipe-check
validates MCP policy and selections without assuming a particular execution
tool name.

The extension writes `.pi/bin/mcp` and makes that shim available on `PATH` for
bash commands run inside the launched Pi session. It resolves package, agent,
and endpoint policy without contacting remote servers, then writes a
workspace-local `.pi/mcp-session.json` plus an
[mcporter](https://github.com/openclaw/mcporter) config at `.pi/mcporter.json`.
The CLI discovers catalogs on first `list` or `search` use and caches them per
server in `.pi/mcp-catalogs/`; `mcp search` discovers uncached servers in
parallel. `mcp call` validates static policy and connects directly without
listing tools first.
Agents use:

```bash
mcp search "contact lookup"              # find relevant tool references
mcp list                                 # configured servers and tool counts
mcp list contacts                         # compact tool signatures
mcp list contacts.search_contacts --schema # compact input/output contract
mcp call contacts.search_contacts query="Ada Lovelace"
mcp run <<'JS'                           # batch or compose calls in JavaScript
const result = await tools.contacts.search_contacts({ query: "Ada Lovelace" })
console.log(JSON.stringify(result, null, 2))
JS
```

`mcp list` and `mcp call` delegate listing, argument coercion, tool execution,
and result formatting to mcporter against the session config. The
recipe wrapper enforces the materialized server/tool policy, blocks
configuration and ad-hoc transport escapes, keeps calls headless, rejects
ambiguous duplicate or malformed call input, and removes non-actionable error
stacks. Calls preserve actual server results; metadata uses compact text. An exact
`mcp list <server.tool> --schema` renders one token-efficient input/output
contract. Raw JSON is reserved for actual tool results.

Every `mcp run` tool call must be awaited or its promise chain returned. A
detached `.then()` or `.catch()` chain that is still pending when the script
exits fails as a missing await. Duplicate direct-call arguments, invalid limits,
and invalid timeout configuration also fail with a nonzero usage status instead
of continuing ambiguously. Run workflows bound per-call time, total calls, and
concurrency; excess calls wait in a FIFO queue and inherit the remaining run
deadline. At the deadline queued calls are cancelled and active transports are
closed. A timeout still reports that a remote mutation may already have
committed and must be inspected before retrying. Structured MCP errors preserve
server recovery fields such as `code`, `retryable`, `action`, `request_id`, and
`outcome` in JavaScript and `--json-errors` output.

If search does not find a match, retry with broader or alternate terms. Use
`mcp list <server>` only to identify exact tool names, then inspect one candidate with
`mcp list <server.tool> --schema`; avoid server-wide schema dumps during normal
agent workflows.

Every tool call returns decoded JSON by default. For a tool that explicitly
documents another response type, select it on the tool function with
`.text(args)`, `.markdown(args)`, `.images(args)`, `.content(args)`,
`.structuredContent(args)`, or `.raw(args)`. All formats share the normal queue,
deadline, await-detection, typed-error, and allowlist behavior. `mcp run`
disables interactive OAuth while retaining configured and cached credentials,
so a headless recipe call cannot unexpectedly launch a browser.

The JavaScript runs with the same OS privileges as the active shell sandbox.
`mcp run` is not an additional sandbox or security boundary.

The `mcp` command is a pi-recipes wrapper backed by mcporter (a package
dependency), locked to the generated session config via `MCPORTER_CONFIG` — a
recipe session never reads host-level mcporter or editor MCP configs. Outside
the Pi session, `mcp` is not a normal package-level command; the launched
session owns the CLI setup.

For local endpoint bindings, use `.pi/mcp.local.json` in the workspace or recipe
directory. Workspace config wins over recipe config. To override that path, set
`PI_RECIPES_MCP_LOCAL_CONFIG`. Header values can reference environment variables
such as `${CONTACTS_MCP_TOKEN}`.
Local bindings may instead declare `auth: "oauth"`. The agent-facing CLI is
always headless; local users complete OAuth with mcporter outside the agent
session, while hosted environments supply their configured credentials. See
[MCP authentication](mcp-auth.md).

The extension does not translate or adapt MCP tool names. The server must expose
the tool names declared by the selected recipe agent, or `mcp call` fails with
the underlying MCP error.

## Harbor Evals

Recipes can declare offline Harbor eval suites in `package.json#pi.evals`.
Suites are references, not vendored datasets:

```json
{
  "pi": {
    "evals": {
      "suites": [
        {
          "name": "smoke",
          "type": "registry",
          "dataset": "acme/coding-smoke",
          "version": "1.0.0"
        },
        {
          "name": "repo-tasks",
          "type": "git",
          "repo": "https://github.com/acme/coding-agent-evals.git",
          "rev": "abcdef1234567890",
          "dataset": "smoke"
        }
      ]
    }
  }
}
```

Run pinned suites with:

```bash
recipes evals run ./my-recipe
recipes evals run ./my-recipe --suite smoke
recipes evals run ./my-recipe --dry-run
recipes evals run ./my-recipe --suite smoke -- --task acme/one
```

Use `--dataset-path <dir>` while developing a local Harbor dataset before it has
a stable pin. See [Recipe Evals](recipe-evals.md) for the exact-pin rules and
adapter details. The recipe agent YAML owns model selection; `recipes evals`
does not expose a model override. Arguments after `--` are passed through to
the underlying `harbor run` invocation for local filters and environment-specific
experiments.

## Extension Dependencies

Recipes that declare TypeScript extensions add runtime dependencies to the same
`package.json`:

```text
my-recipe/
  package.json
  package-lock.json
  extensions/
    tools.ts
```

Example extension:

```ts
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";

const NameParams = z.object({ name: z.string().min(1) });

const extension: ExtensionFactory = (pi) => {
  pi.registerTool(
    defineTool({
      name: "hello_validated",
      label: "Hello",
      description: "Return a validated greeting.",
      parameters: Type.Object({ name: Type.String() }),
      async execute(_id, params) {
        const { name } = NameParams.parse(params);
        return { content: [{ type: "text", text: `Hello ${name}` }] };
      },
    })
  );
};

export default extension;
```

Example `package.json` for that extension:

```json
{
  "name": "zod-tools",
  "version": "0.1.0",
  "description": "Recipe with an extension that validates inputs with zod.",
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

Create and commit a lockfile from the recipe directory:

```bash
cd my-recipe
npm install --package-lock-only
```

Then register or install the recipe:

```bash
recipes install .
```

`recipes install` installs production dependencies into the recipe directory so
extension imports resolve from that recipe. For local recipes, this modifies the
local recipe directory. For remote Git recipes, dependencies are installed into
the cloned recipe cache.

When a remote Git recipe has `dependencies` or `optionalDependencies`, it must
also commit a lockfile:

- `package-lock.json`
- `npm-shrinkwrap.json`
- `pnpm-lock.yaml`
- `yarn.lock`

`recipes install` installs production dependencies with lifecycle scripts disabled:

- npm: `npm ci --omit=dev --ignore-scripts`
- pnpm: `pnpm install --prod --frozen-lockfile --ignore-scripts`
- yarn: `yarn install --production --frozen-lockfile --ignore-scripts`

It chooses the package manager from `packageManager` when present, otherwise
from the lockfile. If you use pnpm or yarn, set `packageManager` and commit the
matching lockfile:

```json
{
  "name": "zod-tools",
  "version": "0.1.0",
  "type": "module",
  "packageManager": "pnpm@10.0.0",
  "pi": {
    "agents": ["agents/*.yaml"],
    "extensions": ["extensions/*.ts"]
  },
  "dependencies": {
    "zod": "^4.0.0"
  }
}
```

Pi runtime packages imported by extensions, such as
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `typebox`,
should be peers. The Pi recipe extension aliases those packages to the host Pi
installation so recipe extensions share the running Pi runtime.

Use `devDependencies` for packages needed only while developing the recipe, such
as test runners or local build tools. They are not installed when a remote
recipe is installed for runtime use.

## Install Recipes

Install from a local directory:

```bash
recipes install ./my-recipe
```

Install from GitHub shorthand:

```bash
recipes install github:owner/repo
recipes install github:owner/repo/path/to/recipe
recipes install owner/repo
```

Install a pinned ref:

```bash
recipes install github:owner/repo#v1.0.0
recipes install github:owner/repo/path/to/recipe#v1.0.0
```

Install from explicit Git URLs:

```bash
recipes install git@github.com:owner/private-recipe.git
recipes install git+https://github.com/owner/recipe.git#v1.0.0
recipes install file:///path/to/recipe.git#v1.0.0
```

Re-clone an existing remote source:

```bash
recipes install github:owner/repo --force
```

Print machine-readable output:

```bash
recipes install github:owner/repo --json
recipes list --json
recipes check my-recipe --json
recipes check my-recipe --profile ci --json
```

## Customize Recipes

When you want to make a small local change to a recipe installed from elsewhere,
copy it into an editable local recipe:

```bash
recipes customize pi-codex --output ./my-agent
```

With `--output`, this creates an owned copy at the requested path, registers that
path under the same recipe name, and leaves remote clone caches alone. Without
`--output`, it preserves the legacy recipe-store `local/` destination. Edit the
printed directory, then run it directly:

```bash
recipes check ./my-agent
pi --recipe ./my-agent
```

If the recipe is already registered as an editable local copy, `customize`
reuses it. Pass `--force` only when copying from another registered source into
an existing destination.

## Resolve Recipes

`recipes path <identifier>` resolves an installed recipe directory:

```bash
recipes path my-recipe
recipes path github:owner/repo
recipes path owner/repo
recipes path repo
```

Identifiers can match:

- short recipe name, such as `my-recipe`
- scoped recipe name, such as `owner/my-recipe`
- local directory path

The Pi extension uses the same resolution rules for `--recipe`.

## Remove Recipes

Remove a recipe record from the store:

```bash
recipes remove my-recipe
recipes remove owner/my-recipe
```

This removes the store record. Remote clone contents may remain in the store
cache and can be reused by a later install unless `--force` is used.

## Publish Recipes

Publish a recipe to GitHub:

```bash
recipes publish ./my-recipe --github owner/my-recipe --visibility public
```

`recipes publish` runs the same development validation as `check`, updates
`package.json#name` to `@owner/my-recipe`, commits local changes, creates the
GitHub repository when needed, pushes `main`, and re-registers the local recipe.
When `--visibility public` is used, it also submits the public package metadata
to the recipe catalog so the marketplace can add or refresh the listing.

For a standalone public recipe:

```bash
mkdir my-recipe
cd my-recipe
# add package.json, SYSTEM.md, agents/, skills/, extensions/ as needed
git init
git add .
git commit -m "initial recipe"
gh repo create owner/my-recipe --private=false --source . --push
```

Users install it with:

```bash
recipes install github:owner/my-recipe
```

For a private recipe, use normal GitHub access control. Users can install via
SSH:

```bash
recipes install git@github.com:owner/private-recipe.git
```

For CI or noninteractive GitHub installs, set a token:

```bash
GITHUB_TOKEN=... recipes install github:owner/private-recipe
```

For reproducible releases, tag the Git repository and tell users to install the
tag:

```bash
git tag v1.0.0
git push origin v1.0.0
recipes install github:owner/my-recipe#v1.0.0
```

For monorepos or recipe collections, put each recipe in a subdirectory:

```text
recipes/
  code-review/
    package.json
  research/
    package.json
```

Install a subdirectory recipe with:

```bash
recipes install github:owner/repo/recipes/code-review
recipes install github:owner/repo/recipes/research#v1.0.0
```

## Telemetry

When you install a recipe from a remote source (`github:` or a Git URL),
`recipes install` sends a single anonymous ping to the public recipe directory
at [pi.recipes](https://pi.recipes) so it can rank recipes by install count.

The ping contains only the recipe's canonical id, name, recipe version, and
`pi-recipes` CLI version:

```json
{ "event": "install", "id": "github:owner/repo", "name": "my-recipe", "version": "1.0.0", "piRecipesVersion": "0.1.0" }
```

No paths, machine identifiers, or other personal data are sent. Local recipe
registration (`recipes install ./my-recipe`) is never reported. The ping is
best-effort and never blocks or fails an install.

When you publish with `--visibility public`, `recipes publish` sends the
recipe's public GitHub source, package name, version, description, resource
counts, and `pi-recipes` CLI version so it can appear in the catalog. `version`
is the verified Git ref used for public installs: the tag pointing at the pushed
commit when one is present on the remote, otherwise the pushed commit SHA. The
catalog derives website-specific fields such as homepage and install command
from the source and version.

Opt out by setting either environment variable to a truthy value:

```bash
DO_NOT_TRACK=1 recipes install github:owner/repo
PI_RECIPES_NO_TELEMETRY=1 recipes install github:owner/repo
```

Point install pings or catalog submissions at different collectors with:

```bash
PI_RECIPES_TELEMETRY_ENDPOINT=https://example.com/api/installs recipes install github:owner/repo
PI_RECIPES_CATALOG_ENDPOINT=https://example.com/api/catalog/recipes recipes publish . --github owner/my-recipe --visibility public
```

## Troubleshooting

If a private GitHub recipe fails to install with `github:owner/repo`, use SSH or
set a token:

```bash
recipes install git@github.com:owner/repo.git
GITHUB_TOKEN=... recipes install github:owner/repo
```

If `check` reports missing resources, check that glob paths are relative to the
recipe directory and that direct paths exist. If `recipes install` reports missing
extension dependency lockfiles, commit the lockfile generated by your package
manager.

If Pi cannot find a recipe by name, confirm it is in the same store:

```bash
recipes list
PI_RECIPES_HOME=/same/store pi --recipe my-recipe
```
