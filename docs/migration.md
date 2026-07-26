# Migration to Recipes

The project and npm package are now **Recipes**:

```text
@introspection-ai/pi-recipes  →  @introspection-ai/recipes
Pi Recipes                    →  Recipes
```

The artifact remains **a Recipe**. The package format and focused Host API
entrypoints remain source-compatible unless noted below.

## Package imports

```diff
- import { resolveRecipe } from "@introspection-ai/pi-recipes/recipe";
+ import { resolveRecipe } from "@introspection-ai/recipes/recipe";

- import { createRecipeSession } from "@introspection-ai/pi-recipes/session";
+ import { createRecipeSession } from "@introspection-ai/recipes/session";
```

The same replacement applies to `/run`, `/pi`, `/interactions`, and
`/test-utils`. The former `/tracing` entrypoint is removed: pass a host-owned
tracer through `createRecipeSession({ otel })` instead.

## Pi extension

```bash
pi remove npm:@introspection-ai/pi-recipes
pi install npm:@introspection-ai/recipes
```

The Recipe extension factory is now `createRecipesExtension`.
`createPiRecipesExtension` remains as a deprecated source-compatible alias.

Recipe-owned extensions that still import
`@introspection-ai/pi-recipes/interactions` are aliased to the current
module while they migrate.

## CLI

The standalone `recipes` executable has been retired. Use:

```bash
introspection init
introspection check
introspection local
introspection dev
```

Use ordinary Git and filesystem operations to clone, fork, copy, and publish
Recipe source.

## Hosting

`serveRecipe` and `@introspection-ai/recipes/serve` are not part of the new
package. Hosts integrate at `createRecipeSession`; HTTP protocols, persistence,
auth, and deployment adapters belong to the host.

`runRecipe` remains as the small one-turn convenience above the session API.

## Validation

The root npm package no longer downloads or exposes a `recipe-check`
executable. Use `introspection check`.
