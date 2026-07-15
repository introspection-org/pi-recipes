<div align="center">
  <a href="https://pi.recipes">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/images/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset=".github/images/logo-light.svg">
      <img alt="Pi Recipes" src=".github/images/logo-light.svg" width="165">
    </picture>
  </a>
</div>

<h4 align="center">Reproducible frontier-grade agents</h4>

<div align="center">
  <a href="https://pi.recipes"><img src="https://img.shields.io/badge/website-pi.recipes-blue" alt="Website"></a>
  <a href="https://github.com/introspection-org/pi-recipes/actions/workflows/ci.yml"><img src="https://github.com/introspection-org/pi-recipes/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@introspection-ai/pi-recipes"><img src="https://img.shields.io/npm/v/@introspection-ai/pi-recipes?label=npm" alt="npm version"></a>
  <a href="https://crates.io/crates/pi-recipe-check"><img src="https://img.shields.io/crates/v/pi-recipe-check?label=crates.io" alt="crates.io version"></a>
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img src="https://img.shields.io/badge/license-Apache%202.0-green" alt="License"></a>
</div>

<br>

A Pi recipe captures the expertise behind a frontier-grade agent so the same
workflow can be run, measured, and improved anywhere Pi runs. Install one from
Git and customize it locally.

## Overview

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
- [Recipe Evals](docs/recipe-evals.md): declaring and running Harbor offline eval suites with exact pins.

## Package Exports

- `@introspection-ai/pi-recipes`: extension factory and recipe-loading helpers.
- `@introspection-ai/pi-recipes/pi-extension`: Pi extension entrypoint.
- `@introspection-ai/pi-recipes/recipe`: recipe parsing and resolved session inputs.
- `@introspection-ai/pi-recipes/pi`: the shared `agent` tool and controller types.
- `@introspection-ai/pi-recipes/recipe-store`: recipe install and resolution helpers.
- [`pi-recipe-check`](https://crates.io/crates/pi-recipe-check) (Rust crate,
  [`crates/pi-recipe-check`](crates/pi-recipe-check)): the pure recipe
  validation engine behind the vendored `recipe-check` binary, embeddable by
  other hosts such as `introspection-cli`.

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
recipes check ./my-recipe
recipes install ./my-recipe
```

Launch it with Pi:

```bash
pi --recipe my-recipe
pi --recipe my-recipe --agent agent
```

Hosts that embed Pi can resolve the same recipe semantics without adopting a
second runtime abstraction:

```ts
import { resolveRecipeSession } from "@introspection-ai/pi-recipes/recipe";
import { createAgentTool } from "@introspection-ai/pi-recipes/pi";

const recipe = resolveRecipeSession({ recipeDir, agentName });
const runs = createHostAgentRunController(recipe.subagents);
const agents = (pi) => {
  pi.registerTool(createAgentTool(runs, recipe.subagents));
};

const services = await createAgentSessionServices({
  cwd,
  agentDir: recipe.recipeDir,
  authStorage,
  settingsManager,
  resourceLoaderOptions: {
    additionalSkillPaths: recipe.skillPaths,
    systemPromptOverride: recipe.systemPromptOverride,
    extensionFactories: [agents],
  },
});

const { session } = await createAgentSessionFromServices({
  services,
  sessionManager,
  model: resolveHostModel(recipe.modelSpec, recipe.modelConfig),
  thinkingLevel: recipe.thinkingLevel,
  tools: recipe.tools,
});
```

The host remains responsible for model credentials, session persistence,
telemetry, and lifecycle. The resolver owns recipe interpretation; the shared
tool delegates run execution to the host controller.

The package keeps those responsibilities separate:

- `@introspection-ai/pi-recipes/recipe` parses and resolves declarative recipes.
- `@introspection-ai/pi-recipes/pi` exposes ordinary Pi SDK integrations.
- The existing `pi-extension` entrypoint owns local child sessions,
  filesystem persistence, and completion delivery.

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

Use `--visibility public` to submit the recipe's public GitHub metadata to the
marketplace catalog after a successful push. Catalog submissions are
best-effort; private publishes are not listed.

Customize an installed recipe into an editable local copy:

```bash
recipes customize pi-codex
recipes check pi-codex
pi --recipe pi-codex
```

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
development setup (TypeScript and the Rust validator), commit conventions,
and the release process.

## License

Apache-2.0
