# @tfidfwastaken/local-session-tools

Experimental Pi recipe tooling with a `pi-recipes` CLI and Pi extension
support.

Recipes are Pi packages: folders with a `package.json` manifest containing a
`pi` block, plus agent YAML files, prompts, skills, and optional TypeScript
runtime extensions. The `pi-recipes` CLI installs or registers recipes in a
local store and ensures the Pi extension is installed before recipes are run.
The Pi extension resolves an installed recipe into a local directory and wires
those recipe files into the live Pi session at launch time.

`package.json` owns both recipe identity and Node dependency metadata. The
top-level `name`, `version`, and `description` identify the recipe, while the
`pi` block declares recipe resources such as agents, extensions, skills,
prompts, and themes.

## Documentation

- [Recipe CLI](docs/recipe-cli.md): creating, installing, resolving, publishing, and removing recipes.
- [Pi Recipe Extension](docs/pi-extension.md): installing the Pi extension, launching recipes, agent selection, resources, subagents, and recipe extension loading.

## Package Exports

- `@tfidfwastaken/local-session-tools`: extension factory and recipe-loading helpers.
- `@tfidfwastaken/local-session-tools/pi-extension`: Pi extension entrypoint.
- `@tfidfwastaken/local-session-tools/recipe-store`: recipe install and resolution helpers.

## Quick Start

Install the recipe tooling:

```bash
npm install -g @tfidfwastaken/local-session-tools
```

The first `pi-recipes install ...` run automatically installs the companion Pi
extension with `pi install npm:@tfidfwastaken/local-session-tools`.

Create a local recipe:

```bash
pi-recipes init ./my-recipe
pi-recipes doctor ./my-recipe
pi-recipes install ./my-recipe
```

Launch it with Pi:

```bash
pi --recipe my-recipe
pi --recipe my-recipe --agent agent
```

`pi-recipes init` writes a starter `package.json`, `SYSTEM.md`, `agents/agent.yaml`,
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
pi-recipes install github:owner/repo
pi-recipes install github:owner/repo/path/to/recipe
pi-recipes install github:owner/repo#v1.0.0
```

Install private recipes with normal Git authentication:

```bash
pi-recipes install git@github.com:owner/private-recipe.git
GITHUB_TOKEN=... pi-recipes install github:owner/private-recipe
```

No recipe registry is required. Publishing a recipe means committing a recipe
folder to a Git repository and sharing the GitHub or Git source locator.
Run `pi-recipes publish ./my-recipe` for a validation pass, publishing checklist,
and install commands to share.

Customize an installed recipe into an editable local copy:

```bash
pi-recipes customize pi-codex
pi-recipes doctor pi-codex
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
