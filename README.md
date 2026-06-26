# @introspection-ai/pi-recipes

Experimental Pi recipe tooling with a `recipes` CLI and Pi extension
support.

Recipes are Pi packages: folders with a `package.json` manifest containing a
`pi` block, plus agent YAML files, prompts, skills, and optional TypeScript
runtime extensions. The `recipes` CLI installs or registers recipes in a
local store and ensures the Pi extension is installed before recipes are run.
The Pi extension resolves an installed recipe into a local directory and wires
those recipe files into the live Pi session at launch time.

`package.json` owns both recipe identity and Node dependency metadata. The
top-level `name`, `version`, and `description` identify the recipe, while the
`pi` block declares recipe resources such as agents, extensions, skills,
and prompts.

## Documentation

- [Recipe Flow](docs/recipe-flow.md): quick user-facing guide to installing, customizing, creating, and publishing recipes.
- [Recipe CLI](docs/recipe-cli.md): creating, installing, resolving, publishing, and removing recipes.
- [Pi Recipe Extension](docs/pi-extension.md): installing the Pi extension, launching recipes, agent selection, resources, subagents, and recipe extension loading.

## Package Exports

- `@introspection-ai/pi-recipes`: extension factory and recipe-loading helpers.
- `@introspection-ai/pi-recipes/pi-extension`: Pi extension entrypoint.
- `@introspection-ai/pi-recipes/recipe-store`: recipe install and resolution helpers.

## Quick Start

Install the recipe tooling:

```bash
npm install -g @introspection-ai/pi-recipes
```

The first `recipes install ...` run automatically installs the companion Pi
extension with `pi install npm:@introspection-ai/pi-recipes`.

Create a local recipe:

```bash
recipes create ./my-recipe
recipes doctor ./my-recipe
recipes install ./my-recipe
```

Launch it with Pi:

```bash
pi --recipe my-recipe
pi --recipe my-recipe --agent agent
```

`recipes create` writes a starter `package.json`, `SYSTEM.md`, `agents/agent.yaml`,
and recipe README. Edit those files as the recipe grows. Named variants are
agents too:

```yaml
name: agent-opus
from: agent
model:
  name: openrouter/anthropic/claude-opus-4.8
```

## Install Recipes

Install public GitHub recipes:

```bash
recipes install github:owner/repo
recipes install github:owner/repo/path/to/recipe
recipes install github:owner/repo#v1.0.0
```

Install private recipes with normal Git authentication:

```bash
recipes install git@github.com:owner/private-recipe.git
GITHUB_TOKEN=... recipes install github:owner/private-recipe
```

No recipe registry is required. Publishing a recipe creates or updates a GitHub
repository and pushes the local recipe:

```bash
recipes publish ./my-recipe --github owner/my-recipe --visibility private
```

Customize an installed recipe into an editable local copy:

```bash
recipes customize pi-codex
recipes doctor pi-codex
pi --recipe pi-codex
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Install from a local clone into Pi:

```bash
pnpm build
pi install "$(pwd)"
```

Pi records the local package path in `~/.pi/agent/settings.json`. Re-run
`pnpm build` after changing extension source.
