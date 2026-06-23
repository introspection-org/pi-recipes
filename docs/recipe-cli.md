# Recipe CLI

`recipes` is the neutral recipe package manager. It installs, registers, lists,
removes, and resolves recipe folders without depending on Pi-specific state.
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

Remote Git recipes are cloned into the store. Local recipes are registered by
path, so edits to the local directory are immediately visible to the harness.
If a recipe declares extension runtime dependencies in `package.json`,
`recipes add` installs them in that recipe directory.

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

`SYSTEM.md` is optional. When present, Pi uses it as the recipe-level system
prompt before applying the selected agent's `system_instructions`.

## `recipe.yaml` and `package.json`

New recipes should use `recipe.yaml` as the recipe manifest. It describes the
portable recipe boundary:

- recipe identity: `name`, `version`, and `description`
- recipe-owned resources: agents, extensions, skills, prompts, and themes
- resource globs that are resolved relative to the recipe directory

`package.json` has a different job. It is the Node package manifest for the
recipe's extension runtime. Add it only when files under `extensions/` import
external npm packages, or when you need package-manager metadata such as
`packageManager`.

The two files are intentionally separate because recipe metadata should stay
harness-neutral and package-manager-neutral. A recipe can be used by Pi today
and another harness later without pretending to be an npm package. At the same
time, TypeScript extensions are JavaScript modules, so they still need normal
Node dependency metadata when they import third-party code.

When both files exist, keep responsibilities split:

- Put recipe name, recipe version, agent globs, extension globs, skills,
  prompts, and themes in `recipe.yaml`.
- Put `dependencies`, `optionalDependencies`, `peerDependencies`, `devDependencies`,
  `packageManager`, and lockfile-related npm metadata in `package.json`.
- Do not duplicate the recipe manifest into `package.json` for new recipes.

The recipe `name` in `recipe.yaml` is the identifier users pass to
`pi --recipe` and `recipes path`. A `package.json` `name`, when present, is npm
metadata for dependency installation and does not define the recipe identity.

Older Pi recipes may have used `package.json` blocks such as `pi` or `recipe`
as the recipe manifest. Pi still accepts those legacy blocks for compatibility,
but the neutral `recipes` manifest reader expects `recipe.yaml`. Prefer
migrating legacy recipes by moving resource declarations into `recipe.yaml` and
leaving `package.json` for extension dependencies.

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

## Extension Dependencies

Recipes that declare TypeScript extensions can add a `package.json` next to
`recipe.yaml` when those extensions need third-party runtime dependencies:

```text
my-recipe/
  recipe.yaml
  package.json
  package-lock.json
  extensions/
    tools.ts
```

Example `recipe.yaml`:

```yaml
name: zod-tools
version: 0.1.0
description: Recipe with an extension that validates inputs with zod.

agents:
  - agents/*.yaml
extensions:
  - extensions/*.ts
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
  "private": true,
  "type": "module",
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
recipes add .
```

`recipes add` installs production dependencies into the recipe directory so
extension imports resolve from that recipe. For local recipes, this modifies the
local recipe directory. For remote Git recipes, dependencies are installed into
the cloned recipe cache.

When a remote Git recipe has `dependencies` or `optionalDependencies`, it must
also commit a lockfile:

- `package-lock.json`
- `npm-shrinkwrap.json`
- `pnpm-lock.yaml`
- `yarn.lock`

`recipes add` installs production dependencies with lifecycle scripts disabled:

- npm: `npm ci --omit=dev --ignore-scripts`
- pnpm: `pnpm install --prod --frozen-lockfile --ignore-scripts`
- yarn: `yarn install --production --frozen-lockfile --ignore-scripts`

It chooses the package manager from `packageManager` when present, otherwise
from the lockfile. If you use pnpm or yarn, set `packageManager` and commit the
matching lockfile:

```json
{
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.0.0",
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
recipe is added for runtime use.

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
recipe directory and that direct paths exist. If `recipes add` reports missing
extension dependency lockfiles, commit the lockfile generated by your package
manager.

If Pi cannot find a recipe by name, confirm it is in the same store:

```bash
recipes list
AGENT_RECIPES_HOME=/same/store pi --recipe my-recipe
```
