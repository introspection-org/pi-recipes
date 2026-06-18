# @introspection/pi-recipes

Portable Pi recipe infrastructure for creating, sharing, and running agent "brains" locally.

This package separates the recipe brain specification from the runtime hands that execute it:

- **Recipe brain spec**: manifests, agents, profiles, prompts, skills, and validation.
- **Local runtime**: filesystem workspace/resource handling and a Pi `AgentSession` driver.
- **Pi extension**: a local-first recipe manager command surface inside Pi.

The Introspection cloud runtime is intentionally not implemented here. Cloud behavior lives in `introspection-cloud` as a platform adapter.

## Package Exports

- `@introspection/pi-recipes`: core recipe types, manifest helpers, runner interfaces, and local runner APIs.
- `@introspection/pi-recipes/local`: local adapter/runtime helpers.
- `@introspection/pi-recipes/pi-extension`: Pi extension entrypoint.
- `@introspection/pi-recipes/testing`: test helpers for extension/runtime tests.

## Pi Extension

The package declares its Pi extension in `package.json`:

```json
{
  "pi": {
    "extensions": ["./dist/pi-extension.js"]
  }
}
```

The extension registers a local `/recipe` command with these subcommands:

- `/recipe new <name>`
- `/recipe import <path> [name]`
- `/recipe list`
- `/recipe inspect <name-or-path> [profile]`
- `/recipe run <name-or-path> [prompt]`
- `/recipe export <name-or-path>`

Recipes are stored by default under `~/.pi/recipes`. Override with `PI_RECIPES_LIBRARY_DIR`.

## Local Runtime

Use the local runner directly from Node:

```ts
import { createLocalRecipeRunner } from "@introspection/pi-recipes";

const runner = createLocalRecipeRunner({
  recipeDir: "/path/to/recipe",
});

await runner.start();
await runner.prompt("Run this recipe locally.");
await runner.shutdown();
```

The local runtime uses direct model provider environment variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_API_KEY`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Status

This package is private while publishing, licensing, and final distribution decisions are settled.
