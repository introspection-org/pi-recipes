# @tfidfwastaken/local-session-tools

Experimental local session tooling with a lightweight CLI and package-based
session extension support.

Recipes are package folders that describe agent behavior, prompts, resources,
and optional runtime extensions. The CLI installs or registers recipes in a
neutral local store. The Pi extension is currently the first harness: it resolves
an installed recipe into a local directory and wires those recipe files into the
live Pi session at launch time.

## Package Exports

- `@tfidfwastaken/local-session-tools`: extension factory and recipe-loading helpers.
- `@tfidfwastaken/local-session-tools/pi-extension`: extension entrypoint.
- `@tfidfwastaken/local-session-tools/recipe-store`: neutral recipe install and resolution helpers.

## CLI

Install or register a recipe:

```bash
recipe add ./my-recipe
recipe add git@github.com:owner/private-recipe.git
recipe add git+https://github.com/owner/recipe.git#v1.0.0
recipe add github:owner/repo
recipe add github:owner/repo/path/to/recipe#v1.0.0
recipe add owner/repo
```

List, inspect, and remove recipes:

```bash
recipe list
recipe path code-review
recipe doctor code-review
recipe remove code-review
```

Recipes are tracked in `~/.agent-recipes/recipes.json` by default. Set
`AGENT_RECIPES_HOME` or pass `--store <dir>` to use a different store. Remote
Git recipes are cloned into the same neutral store; local recipes are registered
by path. Private repositories use normal Git authentication, such as SSH keys or
your Git credential helper. In CI, set `GITHUB_TOKEN` or `GH_TOKEN` when using
`github:` sources.

## Recipe Package Shape

A recipe is a local directory with a `recipe.yaml`. Resource paths can be
declared directly in the manifest; omitted entries fall back to conventional
folders when present.

```yaml
name: demo-recipe
version: 1.0.0
description: Demo multi-agent workflow
entrypoint: agent

agents:
  - agents/*.yaml
skills:
  - skills/**/SKILL.md
prompts:
  - prompts
themes:
  - themes/*.json
```

`package.json` is still accepted as a compatibility manifest:

```json
{
  "name": "demo-recipe",
  "version": "1.0.0",
  "pi": {
    "agents": ["agents/*.yaml"],
    "extensions": ["extensions/*.ts"],
    "skills": ["skills/**/SKILL.md"],
    "prompts": ["prompts"],
    "themes": ["themes/*.json"]
  }
}
```

Conventional folders:

- `agents`
- `skills`
- `prompts`
- `themes`

Agent YAML:

```yaml
name: agent
description: Main coordinator
model:
  name: openai/gpt-4.1
  thinking_level: medium
tools:
  - shell
skills:
  - repo-index
subagents:
  - explorer
system_instructions:
  mode: append
  content: Extra instructions for this agent.
```

`SYSTEM.md` is used as the recipe-level system prompt when present. Agent
`system_instructions` are applied on top. `mode: replace` replaces the current
prompt; the default `append` mode appends content.

## Launch

Install the Pi extension package itself:

```json
{
  "pi": {
    "extensions": ["./dist/pi-extension.js"]
  }
}
```

Launch a recipe:

```bash
pi --recipe /path/to/recipe
pi --recipe demo-recipe
pi --recipe owner/repo
pi --recipe /path/to/recipe --agent reviewer
```

`--recipe` first accepts a local directory. If that does not exist, the extension
looks in the neutral recipe store for an installed recipe matching the recipe
name, source, or source id. Use `recipe add owner/repo` before launching a
remote recipe by source.

The same selections can be supplied with environment variables:

- `PI_RECIPE_DIR`
- `PI_AGENT_NAME`

During session startup, the selected recipe configures the live Pi session:

- the current Pi working directory remains the writable project workspace;
- `SYSTEM.md`, selected agent instructions, and recipe runtime context are injected into the session prompt;
- the selected agent can set the session model and thinking level;
- the selected agent controls active tools;
- declared recipe extensions are loaded before active tools are selected;
- declared recipe skills, prompt templates, and themes are surfaced through Pi resource discovery.

## Pi Commands

When a recipe is active, the extension adds slash commands:

```text
/recipe
```

`/recipe` shows the active recipe, directory, selected agent, model, thinking
level, visible subagents, and the active tools that came from the recipe.

## Subagents

Subagents are recipe-defined agents made available through the `agent` tool.

If the selected agent declares `subagents`, only those agents are available. If it omits `subagents`, the extension exposes the other recipe agents except the selected parent.

```yaml
name: agent
subagents:
  - explorer
  - reviewer
```

The `agent` tool starts a selected child agent with the same recipe directory and current project workspace. A start call waits by default so the tool block can stream the delegated prompt and child output inline. Pass `wait: false` for a retained background run, then use `action: "status"`, `"wait"`, `"interrupt"`, or `"close"`.

## Recipe Extensions

Recipe packages can declare additional Pi extensions:

```json
{
  "pi": {
    "extensions": ["extensions/setup-git.ts"]
  }
}
```

Extensions are loaded during `session_start`. If one extension fails, Pi shows a warning and continues loading the rest of the recipe.

## Install From npm

Once published, install the package with Pi:

```bash
pi install npm:@tfidfwastaken/local-session-tools@testing
```

## Install From a Clone

Clone the repo, build it, and install the local package path into Pi:

```bash
git clone <repo-url>
cd <repo-dir>
pnpm install
pnpm build
pi install "$(pwd)"
```

Pi records the local path in `~/.pi/agent/settings.json`. Re-run `pnpm build` after changing the extension source.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Publishing Recipes

No registry is required. Put a recipe folder in a GitHub repo, add
`recipe.yaml`, and install it with:

```bash
recipe add github:owner/repo
```

For monorepos or collections:

```bash
recipe add github:owner/repo/path/to/recipe
```

Use tags or branches for reproducible installs:

```bash
recipe add github:owner/repo#v1.0.0
```

For private repositories, prefer an authenticated Git URL:

```bash
recipe add git@github.com:owner/private-recipe.git
```
