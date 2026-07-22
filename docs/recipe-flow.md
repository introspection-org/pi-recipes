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
recipes install introspection-recipes/pi-codex#0.1.1
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
pi --recipe introspection-recipes/pi-codex
```

## 3. Customize an Installed Recipe

Use `customize` when you want to edit a recipe you installed from elsewhere:

```bash
recipes customize pi-codex --output ./my-agent
```

Example output:

```text
Created editable copy for pi-codex

Edit this folder:
  ./my-agent

Then check and run it:
  recipes check ./my-agent
  pi --recipe ./my-agent
```

Edit files in the printed owned folder, then validate and run the customized copy:

```bash
recipes check ./my-agent
pi --recipe ./my-agent
```

The installed source remains cached separately. Removing an owned derivative is
an explicit filesystem or Git operation; `recipes customize` does not delete it.

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

`SYSTEM.md` contains instructions shared by every root and delegated agent in
the recipe. Each `agents/*.yaml` file specializes one agent's model,
capabilities, selected skills, visible subagents, and instructions. Use `from:`
to derive variants and subagents from another agent. See
[Agent Composition](agent-composition.md) for the merge and override rules.

Validate and try it locally:

```bash
recipes check ./my-recipe
pi --recipe ./my-recipe --agent agent
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
