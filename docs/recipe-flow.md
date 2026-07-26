# Recipe workflow

The `introspection` CLI owns the developer workflow. The Recipes npm package is
the format implementation, Host API, and Pi extension; it does not install a
second CLI.

## Create and run locally

```bash
npm install -g @introspection-ai/cli
introspection init
introspection check
introspection local
```

`introspection init` scaffolds a Recipe and ensures compatible versions of Pi
and the Recipes extension are present. `introspection check` runs the Recipe
Format validator. `introspection local` resolves the repository's project
manifest and launches Pi with the Recipe path.

The local path requires no login or Introspection cloud service.

## Run Pi directly

```bash
pi install npm:@introspection-ai/recipes
pi --recipe ./my-recipe --agent agent
```

Recipes are ordinary Git-backed source packages. Clone, fork, or copy them with
normal Git and filesystem tools. There is no Recipe-specific install store or
publish command.

## Deploy

The Recipe remains unchanged across hosts. A long-lived host resolves the Recipe
once, calls `createAgentSession()`, and supplies its own credentials, task
lifecycle, persistence, isolation, and protocol surface. Short-lived hosts can
use `createAgentSessionFromRecipe()` as the resolve-and-create convenience.

Use Introspection when you want the managed host. Otherwise, integrate the Host
API with the platform that will operate the Recipe.
