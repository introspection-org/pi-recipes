<div align="center">
  <a href="https://pi.recipes">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/images/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset=".github/images/logo-light.svg">
      <img alt="Pi Recipes" src=".github/images/logo-light.svg" width="165">
    </picture>
  </a>
</div>

<h4 align="center">Portable agent systems, built on Pi.</h4>

<div align="center">
  <a href="https://pi.recipes"><img src="https://img.shields.io/badge/website-pi.recipes-blue" alt="Website"></a>
  <a href="https://github.com/introspection-org/pi-recipes/actions/workflows/ci.yml"><img src="https://github.com/introspection-org/pi-recipes/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@introspection-ai/pi-recipes"><img src="https://img.shields.io/npm/v/@introspection-ai/pi-recipes?label=npm" alt="npm version"></a>
  <a href="https://crates.io/crates/pi-recipe-check"><img src="https://img.shields.io/crates/v/pi-recipe-check?label=crates.io" alt="crates.io version"></a>
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img src="https://img.shields.io/badge/license-Apache%202.0-green" alt="License"></a>
</div>

<br>

A **recipe** is a portable agent-system package. **Pi Recipes** is the open
format and toolchain for creating, validating, running, and distributing those
packages. It keeps instructions, agents, skills, extensions, capability policy,
and quality definitions together as source you can inspect, fork, and own.

## Overview

Recipes are Pi packages: folders with a `package.json` manifest containing a
`pi` block, plus agent YAML files, prompts, skills, optional judge YAML, and
optional TypeScript runtime extensions. The `recipes` CLI installs or registers
recipes in a local store and ensures the Pi extension is installed before
recipes are run. The Pi extension resolves an installed recipe into a local
directory and wires those recipe files into the live Pi session at launch time.

`package.json` is both the package manifest and the recipe entry point. `name`
is the package identity, `description` explains the package, and the optional
`version` is useful display/package metadata. The `pi` block declares resources
and policies. A reproducible distributed release is identified by its Git
source plus a commit SHA, or a tag protected by an immutable-release policy—not
by the mutable manifest alone.

Recipes remain ordinary Git-backed packages. Pi Recipes supplies the open
format, validator, CLI, resolver, and catalog; it does not require a registry
or a particular cloud. Run a recipe locally or embed it in your own compatible
Pi host, then deploy that host wherever its runtime requirements are supported.
Pi Recipes does not supply provider-specific Fly.io or Vercel deployment adapters.
[Introspection](https://docs.introspection.dev) is the first-party managed cloud
for operating and improving them, with isolated runtimes and production
improvement loops around the same portable artifact.

## Documentation

- [Documentation index](docs/index.md): choose the shortest path for creating, composing, validating, running, or distributing a recipe.
- [Recipe Flow](docs/recipe-flow.md): quick user-facing guide to installing, customizing, creating, and publishing recipes.
- [Recipe CLI](docs/recipe-cli.md): creating, installing, resolving, publishing, and removing recipes.
- [Agent Composition](docs/agent-composition.md): shared `SYSTEM.md`, specialized agent instructions, `from:` inheritance, capabilities, and subagents.
- [MCP Configuration](docs/mcp-configuration.md): package policy, per-agent selection, and package- or environment-supplied endpoints.
- [Recipe Judges](docs/recipe-judges.md): portable authored judge YAML, static validation, and the runtime ownership boundary.
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
- [`pi-recipe-check`](https://pypi.org/project/pi-recipe-check/) (Python package,
  [`bindings/python`](bindings/python)): typed native bindings for validating
  an in-memory recipe snapshot without filesystem I/O.

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
```

Launch it with Pi:

```bash
pi --recipe ./my-recipe --agent agent
```

Hosts that embed Pi can resolve the same recipe semantics without adopting a
second recipe abstraction. The following is integration pseudocode: the host
implements `AgentRunController` and owns session construction and lifecycle.

```ts
import { resolveRecipe } from "@introspection-ai/pi-recipes/recipe";
import { createAgentTool, type AgentRunController } from "@introspection-ai/pi-recipes/pi";

const recipe = resolveRecipe({ recipeDir, agentName });
const runs: AgentRunController = host.createRunController(recipe.subagents);

host.registerTool(createAgentTool(runs, recipe.subagents));
```

The host remains responsible for model credentials, session persistence,
telemetry, and lifecycle. The resolver owns recipe interpretation; the shared
tool delegates run execution to the host controller. Pass the resolved model,
tools, prompts, skills, and extensions to Pi's normal session constructors.

`recipes create` writes a starter `package.json`, shared `SYSTEM.md`,
`agents/agent.yaml`, and recipe README. Put package-wide instructions in
`SYSTEM.md` and role-specific instructions in agent YAML. Named variants are
agents too:

```yaml
name: agent-opus
from: agent
model:
  name: openrouter/anthropic/claude-opus-4.8
```

See [Agent Composition](docs/agent-composition.md) for the complete inheritance
and prompt-layering rules.

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

Customize an installed recipe into an owned editable path:

```bash
recipes customize pi-codex --output ./my-agent
recipes check ./my-agent
pi --recipe ./my-agent
```

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
development setup (TypeScript and the Rust validator), commit conventions,
and the release process.

## License

Apache-2.0
