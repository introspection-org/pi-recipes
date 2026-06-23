# Recipe CLI

`recipes` is the neutral recipe package manager. It installs, registers, lists,
removes, and resolves recipe packages without depending on Pi-specific state.
Pi is currently the first harness that consumes the store, but the store format
and package shape are intentionally harness-neutral.

## Install

Install this package into the environment where you run Pi:

```bash
pi install npm:@tfidfwastaken/local-session-tools@testing
```

For local development:

```bash
pnpm install
pnpm build
pnpm link --global
```

The CLI binary is `recipes`:

```bash
recipes --help
```

## Store

Recipes are tracked in a local store:

```text
~/.agent-recipes/recipes.json
```

Use a different store with either:

```bash
AGENT_RECIPES_HOME=/path/to/store recipes list
recipes list --store /path/to/store
```

Remote Git recipes are cloned into the store. Local recipes are only registered
by path, so edits to the local directory are immediately visible to the harness.

## Create a Recipe

A recipe is a directory with a manifest and one or more agent definitions.

Minimal layout:

```text
my-recipe/
  recipe.yaml
  SYSTEM.md
  agents/
    agent.yaml
```

Minimal `recipe.yaml`:

```yaml
name: my-recipe
version: 0.1.0
description: A short description of what this recipe is for.
entrypoint: agent

agents:
  - agents/*.yaml
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

`SYSTEM.md` is optional. When present, Pi uses it as the recipe-level system
prompt before applying the selected agent's `system_instructions`.

## Resource Folders

Declare resources in `recipe.yaml` when you want explicit package boundaries:

```yaml
agents:
  - agents/*.yaml
extensions:
  - extensions/*.ts
  - extensions/*/index.ts
skills:
  - skills/**/SKILL.md
prompts:
  - prompts
themes:
  - themes/*.json
```

When entries are omitted, conventional folders are used if present:

- `agents`
- `skills`
- `prompts`
- `themes`

`extensions` are only loaded when declared.

`package.json` with a `pi` or `recipe` block is accepted as a compatibility
manifest, but new packages should prefer `recipe.yaml`.

## Check Locally

Validate the current recipe directory:

```bash
recipes doctor .
```

Register the local recipe:

```bash
recipes add ./my-recipe
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

## Add Recipes

Install from a local directory:

```bash
recipes add ./my-recipe
```

Install from GitHub shorthand:

```bash
recipes add github:owner/repo
recipes add github:owner/repo/path/to/recipe
recipes add owner/repo
```

Install a pinned ref:

```bash
recipes add github:owner/repo#v1.0.0
recipes add github:owner/repo/path/to/recipe#v1.0.0
```

Install from explicit Git URLs:

```bash
recipes add git@github.com:owner/private-recipe.git
recipes add git+https://github.com/owner/recipe.git#v1.0.0
recipes add file:///path/to/recipe.git#v1.0.0
```

Re-clone an existing remote source:

```bash
recipes add github:owner/repo --force
```

Print machine-readable output:

```bash
recipes add github:owner/repo --json
recipes list --json
recipes doctor my-recipe --json
```

## Resolve Recipes

`recipes path <identifier>` resolves an installed recipe directory:

```bash
recipes path my-recipe
recipes path github:owner/repo
recipes path owner/repo
recipes path repo
```

Identifiers can match:

- manifest `name`
- installed source
- canonical source id
- repository slug
- local directory path

The Pi extension uses the same resolution rules for `--recipe`.

## Remove Recipes

Remove a recipe record from the store:

```bash
recipes remove my-recipe
recipes rm github:owner/repo
```

This removes the store record. Remote clone contents may remain in the store
cache and can be reused by a later add unless `--force` is used.

## Publish Recipes

Publishing does not require a recipe registry.

For a standalone public recipe:

```bash
mkdir my-recipe
cd my-recipe
# add recipe.yaml, SYSTEM.md, agents/, skills/, extensions/ as needed
git init
git add .
git commit -m "initial recipe"
gh repo create owner/my-recipe --private=false --source . --push
```

Users install it with:

```bash
recipes add github:owner/my-recipe
```

For a private recipe, use normal GitHub access control. Users can install via
SSH:

```bash
recipes add git@github.com:owner/private-recipe.git
```

For CI or noninteractive GitHub installs, set a token:

```bash
GITHUB_TOKEN=... recipes add github:owner/private-recipe
```

For reproducible releases, tag the Git repository and tell users to install the
tag:

```bash
git tag v1.0.0
git push origin v1.0.0
recipes add github:owner/my-recipe#v1.0.0
```

For monorepos or recipe collections, put each recipe in a subdirectory:

```text
recipes/
  code-review/
    recipe.yaml
  research/
    recipe.yaml
```

Install a subdirectory recipe with:

```bash
recipes add github:owner/repo/recipes/code-review
recipes add github:owner/repo/recipes/research#v1.0.0
```

## Troubleshooting

If a private GitHub recipe fails to install with `github:owner/repo`, use SSH or
set a token:

```bash
recipes add git@github.com:owner/repo.git
GITHUB_TOKEN=... recipes add github:owner/repo
```

If `doctor` reports missing resources, check that glob paths are relative to the
recipe directory and that direct paths exist.

If Pi cannot find a recipe by name, confirm it is in the same store:

```bash
recipes list
AGENT_RECIPES_HOME=/same/store pi --recipe my-recipe
```
