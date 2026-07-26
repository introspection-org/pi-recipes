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
manifest and launches Pi with the Recipe path. Pi automatically runs the same
validator with its local profile whenever `--recipe` is present.

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

The Recipe remains unchanged across hosts. A host calls `createAgentSession()`
and supplies its own credentials, task lifecycle, persistence, isolation, and
protocol surface. Pass `{ recipeDir }` and the package is resolved for you; a
long-lived host resolves once with `resolveRecipe()` and constructs every
session, root and child, from that snapshot.

Use Introspection when you want the managed host. Otherwise, integrate the Host
API with the platform that will operate the Recipe.
