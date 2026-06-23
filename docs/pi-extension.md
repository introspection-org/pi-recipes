# Pi Recipe Extension

The Pi recipe extension is the first harness for neutral recipes. It resolves a
recipe directory, selects a recipe agent, and maps recipe resources into the
live Pi session.

The extension is Pi-specific. The recipe package and `recipes` CLI are not.

## Install

Install the package into Pi:

```bash
pi install npm:@tfidfwastaken/local-session-tools@testing
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
recipes add github:owner/repo
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
- an installed manifest name
- an installed source
- an installed canonical source id
- a repository slug such as `repo`

The extension resolves installed recipes from the neutral `recipes` store. Set
`AGENT_RECIPES_HOME` if Pi should use a non-default store.

## Launch Flow

On session startup, the extension:

1. Reads `--recipe` or `PI_RECIPE_DIR`.
2. Resolves the value as a local directory or installed recipe.
3. Loads the recipe manifest from `recipe.yaml` or a legacy `package.json`
   `recipe`/`pi` block.
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

## Agent Selection

Selection order:

1. `--agent` or `PI_AGENT_NAME`
2. recipe manifest `entrypoint`
3. `agents/agent.yaml`
4. the only available agent

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

## Commands

When a recipe is active, the extension registers:

```text
/recipe
```

`/recipe` shows:

- active recipe name and version
- selected agent
- selected model and thinking level
- visible subagents
- active recipe tools
- recipe directory
- project workspace

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

```yaml
extensions:
  - extensions/*.ts
  - extensions/*/index.ts
```

Extensions are loaded during `session_start`. If one extension fails, Pi shows a
warning and continues loading the rest of the recipe.

Extension glob branches are optional, so a recipe can declare both flat and
nested extension layouts without failing when one branch has no matches.

Extensions are loaded with module resolution rooted at the recipe directory. If
an extension imports a third-party package, declare that dependency in the
recipe's optional `package.json` and install/register the recipe with
`recipes add` so dependencies are installed into the recipe directory. For
remote Git recipes, commit a lockfile with the recipe.

Imports of Pi runtime packages such as `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai`, and `typebox` are resolved to the host Pi installation.
Declare those as peers in the recipe `package.json` rather than bundling another
copy.

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
AGENT_RECIPES_HOME=/path/to/store pi --recipe recipe-name
```

If an agent selects a model but Pi reports the model is unavailable, confirm the
model provider exists in Pi and the corresponding API key is configured.

If a recipe tool is listed in an agent but not active, confirm the extension
that registers the tool is declared in the recipe manifest and loads without a
warning.

If an extension fails with `Cannot find module`, confirm the dependency is in
the recipe `package.json`, the recipe was installed with `recipes add`, and the
dependency was written to the recipe's `node_modules`.
