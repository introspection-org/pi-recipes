# @tfidfwastaken/local-session-tools

Experimental local session tooling with a lightweight recipe CLI and Pi
extension support.

Recipes are folders with a `recipe.yaml` manifest plus agent YAML files,
prompts, skills, and optional TypeScript runtime extensions. The `recipes` CLI
installs or registers recipes in a neutral local store. The Pi extension is
currently the first harness: it resolves an installed recipe into a local
directory and wires those recipe files into the live Pi session at launch time.

## Documentation

- [Recipe CLI](docs/recipe-cli.md): creating, adding, resolving, publishing, and removing recipes.
- [Pi Recipe Extension](docs/pi-extension.md): installing the Pi extension, launching recipes, agent selection, resources, subagents, and recipe extension loading.

## Package Exports

- `@tfidfwastaken/local-session-tools`: extension factory and recipe-loading helpers.
- `@tfidfwastaken/local-session-tools/pi-extension`: Pi extension entrypoint.
- `@tfidfwastaken/local-session-tools/recipe-store`: neutral recipe install and resolution helpers.

## Quick Start

Install the package into Pi:

```bash
pi install npm:@tfidfwastaken/local-session-tools@testing
```

Create a local recipe:

```text
my-recipe/
  recipe.yaml
  SYSTEM.md
  agents/
    agent.yaml
```

`recipe.yaml`:

```yaml
name: my-recipe
version: 0.1.0
description: Demo recipe

agents:
  - agents/*.yaml
```

`agents/agent.yaml`:

```yaml
name: agent
description: Main coordinator
model:
  name: openai/gpt-5.4
  thinking_level: medium
tools:
  - read
  - bash
system_instructions:
  mode: append
  content: Follow the recipe workflow.
```

Named variants are agents too:

```yaml
name: agent-opus
from: agent
model:
  name: openrouter/anthropic/claude-opus-4.8
```

Validate and register it:

```bash
recipes doctor ./my-recipe
recipes add ./my-recipe
recipes list
```

Launch it with Pi:

```bash
pi --recipe my-recipe
pi --recipe my-recipe --agent agent
```

## Install Recipes

Install public GitHub recipes:

```bash
recipes add github:owner/repo
recipes add github:owner/repo/path/to/recipe
recipes add github:owner/repo#v1.0.0
```

Install private recipes with normal Git authentication:

```bash
recipes add git@github.com:owner/private-recipe.git
GITHUB_TOKEN=... recipes add github:owner/private-recipe
```

No recipe registry is required. Publishing a recipe means committing a recipe
folder to a Git repository and sharing the GitHub or Git source locator.

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
