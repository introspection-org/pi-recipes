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
9. Returns recipe resources for skills, prompts, and themes.
10. Composes the runtime system prompt from Pi defaults, `SYSTEM.md`, selected agent instructions, and recipe runtime context.

The current Pi working directory remains the user's project workspace. The
recipe directory is available in runtime context, but it does not become the
workspace.

## Manifest File

`package.json` is the recipe manifest. Top-level package fields tell Pi what
recipe this is:

- `name`, `version`, and `description`

The `pi` block tells Pi which recipe-owned files should be loaded:

- agent definition globs
- extension globs
- skill, prompt, and theme paths

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

Objects such as `model` and `extensions` merge by key. Arrays such as `tools`,
`skills`, and `subagents` replace the inherited array.

`system_instructions.mode` can be:

- `append`: append to the current prompt
- `replace`: replace the current prompt

## Session Prompt

The session prompt is assembled from:

1. Pi's base system prompt
2. recipe `SYSTEM.md`, when present
3. selected agent `system_instructions`
4. runtime context containing the current workspace and recipe directory

This lets recipes carry durable workflow guidance without changing where the
user is working.

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

`/recipe reload` asks Pi to reload extensions, skills, prompts, and themes, and
clears the cached recipe manifest and agent state first. Use it after editing a
local recipe's `package.json`, agent files, resources, or extension code.

## Resources

The extension responds to Pi `resources_discover` with:

- `skillPaths`
- `promptPaths`
- `themePaths`

Declared manifest paths are used first. When omitted, conventional folders are
used if present:

- `skills`
- `prompts`
- `themes`

Skills become Pi `/skill:name` commands. Prompt templates and themes are
surfaced through Pi's normal resource system.

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
- `task`: delegated task
- `label`: optional display label
- `wait`: wait for completion on start, defaulting to `true`
- `action`: `start`, `status`, `wait`, `interrupt`, or `close`
- `id`: child-run id for management actions

Child runs use the same recipe directory and current Pi workspace as the parent
session.

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
