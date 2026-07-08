# Pi Recipes: Install, Customize, Publish

A recipe is a shareable Pi workflow package: it can add agents, instructions,
skills, prompts, and optional runtime extensions.

Use `recipes` to install recipes, make local edits, validate them, and
publish your own.

## 1. Install the Tooling

Install the recipe CLI once:

```bash
npm install -g @introspection-ai/pi-recipes
```

`recipes` works with a companion Pi extension. Install it explicitly with:

```bash
recipes setup
```

After that, install recipes with `recipes install ...`.

Recipes are stored under:

```text
~/.pi/recipes
```

## 2. Install and Run a Recipe

Install a recipe from GitHub:

```bash
recipes install github:tfidfwastaken/pi-codex
```

See what is installed:

```bash
recipes list
```

Run it in Pi:

```bash
pi --recipe pi-codex
```

If two installed recipes share the same short name, use the scoped name shown by
`recipes list`:

```bash
pi --recipe tfidfwastaken/pi-codex
```

## 3. Customize an Installed Recipe

Use `customize` when you want to edit a recipe you installed from elsewhere:

```bash
recipes customize pi-codex
```

Example output:

```text
Created editable copy for pi-codex

Edit this folder:
  ~/.pi/recipes/local/tfidfwastaken-pi-codex

Then check and run it:
  recipes check pi-codex
  pi --recipe pi-codex
```

Edit files in the printed folder, then validate and run the customized copy:

```bash
recipes check pi-codex
pi --recipe pi-codex
```

To discard a customized copy, delete the editable folder and reinstall the
original source:

```bash
rm -rf ~/.pi/recipes/local/tfidfwastaken-pi-codex
recipes install github:tfidfwastaken/pi-codex
```

## 4. Create a New Recipe

Create a starter recipe:

```bash
recipes create ./my-recipe
```

The starter contains:

```text
my-recipe/
  package.json
  README.md
  SYSTEM.md
  agents/
    agent.yaml
```

Validate and try it locally:

```bash
recipes check ./my-recipe
recipes install ./my-recipe
pi --recipe my-recipe
```

## 5. Publish a Recipe

Publishing turns a local recipe into a GitHub-backed recipe. It validates the
recipe, updates `package.json#name` to match the target repo, commits changes,
creates the GitHub repo if needed, pushes `main`, and re-registers the local
recipe.

```bash
recipes publish ./my-recipe --github owner/my-recipe --visibility private
```

Use `--visibility public` for public recipes.

After publishing, other users install it with:

```bash
recipes install github:owner/my-recipe
pi --recipe my-recipe
```

## Mental Model

- `install` gets a recipe into your local Pi recipe store.
- `list` shows what Pi can run and where the local files are.
- `customize` creates an editable local copy of an installed recipe.
- `check` validates a recipe before running or publishing it.
- `evals` runs pinned Harbor offline eval suites for a recipe.
- `create` starts a new recipe from scratch.
- `publish` pushes a recipe to GitHub so others can install it.
