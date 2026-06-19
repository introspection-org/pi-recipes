# @introspection/pi-recipes

Local Pi recipe support for launching multi-agent recipe packages with `pi --recipe`.

Recipes are package folders that describe agent behavior, prompts, resources, and optional Pi extensions. The package wires those recipe files into the live Pi session at launch time.

## Package Exports

- `@introspection/pi-recipes`: Pi extension factory and recipe-loading helpers.
- `@introspection/pi-recipes/pi-extension`: Pi extension entrypoint.

## Recipe Package Shape

A recipe is a local directory with a `package.json`. Resource paths can be declared under `pi`; omitted entries fall back to conventional folders when present.

```json
{
  "name": "demo-recipe",
  "version": "1.0.0",
  "pi": {
    "agents": ["agents/*.yaml"],
    "profiles": ["profiles/*.yaml"],
    "extensions": ["extensions/*.ts"],
    "skills": ["skills/**/SKILL.md"],
    "prompts": ["prompts"],
    "themes": ["themes/*.json"]
  }
}
```

Conventional folders:

- `agents`
- `profiles`
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

Profile YAML:

```yaml
name: deep
entrypoint: agent
model:
  name: anthropic/claude-sonnet-4-5
  thinking_level: high
prompt: Profile-specific instructions.
```

`SYSTEM.md` is used as the recipe-level system prompt when present. Profile and agent `system_instructions` are applied on top. `mode: replace` replaces the current prompt; the default `append` mode appends content.

## Launch

The package declares its Pi extension in `package.json`:

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
pi --recipe /path/to/recipe --recipe-profile deep
pi --recipe /path/to/recipe --recipe-agent reviewer
```

The same selections can be supplied with environment variables:

- `PI_RECIPE_DIR`
- `PI_PROFILE_NAME`
- `PI_AGENT_NAME`

During session startup, the selected recipe configures the live Pi session:

- the current Pi working directory remains the writable project workspace;
- `SYSTEM.md`, selected profile instructions, selected agent instructions, and recipe runtime context are injected into the session prompt;
- the selected profile or agent can set the session model and thinking level;
- the selected agent controls active tools;
- declared recipe extensions are loaded before active tools are selected;
- declared recipe skills, prompt templates, and themes are surfaced through Pi resource discovery.

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

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Status

This package is private while publishing, licensing, and distribution decisions are settled.
