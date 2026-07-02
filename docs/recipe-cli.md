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
whose selected agent declares MCP refs, the extension creates a session-local
`.pi/bin/mcp` shim and prepends that directory to the Pi session's bash `PATH`.
The generated paths are recorded in `PI_RECIPES_MCP_MANIFEST` and
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
skills: []
subagents: []
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

Objects such as `model` and `extensions` merge by key, while arrays such as
`tools`, `skills`, and `subagents` replace the inherited array.

Use `system_instructions.content: ""` when an agent intentionally adds no
instructions beyond `SYSTEM.md` but still needs to declare the field explicitly.

`SYSTEM.md` is optional. When present, Pi uses it as the recipe-level system
prompt before applying the selected agent's `system_instructions`.

## Develop a Recipe

Validate the current recipe directory:

```bash
recipes doctor .
```

`doctor` checks the manifest, resolves declared resources, catches missing
required agent globs, validates Harbor eval suite pins, and warns when no
default agent can be inferred.

Register the local recipe:

```bash
recipes install ./my-recipe
```

Inspect what was registered:

```bash
recipes list
recipes path my-recipe
recipes doctor my-recipe
```

Run it in Pi:

```bash
pi --recipe my-recipe
pi --recipe my-recipe --agent agent
```

## `package.json` and `pi`

Recipes use `package.json` as their manifest. Top-level package fields describe
the recipe identity:

- `name`: the identifier users pass to `pi --recipe` and `recipes path`
- `version`: the recipe version shown in Pi sessions
- `description`: a short summary for humans

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
            "allow": ["search_contacts", "get_contact"]
          }
        }
      ]
    }
  }
}
```

Agents opt into MCP tools in their YAML `tools` list:

```yaml
tools:
  - bash
  - mcp:contacts/search_contacts
```

The extension writes `.pi/bin/mcp` and makes that shim available on `PATH` for
bash commands run inside the launched Pi session. When configured endpoints
expose matching allowed tools, it filters the manifest for the active agent and
writes a workspace-local `.pi/mcp.json`. Agents use:

```bash
mcp tools sources
mcp tools search "contact"
mcp tools describe contacts search_contacts
mcp call contacts search_contacts '{"query":"staff engineer"}'
```

Outside the Pi session, `mcp` is not a normal package-level command; the
launched session owns the CLI setup.

For local endpoint bindings, use `.pi/mcp.local.json` in the workspace or recipe
directory. Workspace config wins over recipe config. To override that path, set
`PI_RECIPES_MCP_LOCAL_CONFIG`. Header values can reference environment variables
such as `${CONTACTS_MCP_TOKEN}`.

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
recipes doctor my-recipe --json
```

## Customize Recipes

When you want to make a small local change to a recipe installed from elsewhere,
copy it into an editable local recipe:

```bash
recipes customize pi-codex
```

This creates a copy under the recipe store's `local/` directory, registers that
copy under the same recipe name, and leaves remote clone caches alone. Edit the
printed directory, then run:

```bash
recipes doctor pi-codex
pi --recipe pi-codex
```

If the recipe is already registered as an editable local copy, `customize`
reuses it. Pass `--force` only when the target local directory already exists
while copying from another registered source.

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

`recipes publish` runs the same development validation as `doctor`, updates
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

If `doctor` reports missing resources, check that glob paths are relative to the
recipe directory and that direct paths exist. If `recipes install` reports missing
extension dependency lockfiles, commit the lockfile generated by your package
manager.

If Pi cannot find a recipe by name, confirm it is in the same store:

```bash
recipes list
PI_RECIPES_HOME=/same/store pi --recipe my-recipe
```
