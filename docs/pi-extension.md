# Session Recipe Extension

The session recipe extension turns a resolved recipe package into the active session configuration. The recipe can be a local directory or a recipe installed in the neutral local store.

## Launch Flow

1. Read `--recipe` or `PI_RECIPE_DIR`.
2. Resolve the value as a local directory, installed recipe name, installed source, or installed source id.
3. Load the recipe package manifest.
4. Resolve the selected agent.
5. Load declared recipe extensions.
6. Set session name, model, thinking level, and active tools.
7. Return recipe resources for skills, prompts, and themes.
8. Compose the session prompt from Pi defaults, `SYSTEM.md`, agent instructions, and recipe runtime context.

## Agent Selection

Selection order:

1. `--agent` or `PI_AGENT_NAME`
2. recipe manifest `entrypoint`
3. `agents/agent.yaml`
4. the only available agent

If multiple agents exist and no default can be inferred, the launch fails with a clear error.

## Subagent Tool

The selected agent exposes recipe subagents through the `agent` tool.

The tool accepts:

- `name`: child agent name
- `task`: delegated task
- `label`: optional display label
- `wait`: wait for completion on start, defaulting to `true`
- `action`: `start`, `status`, `wait`, `interrupt`, or `close`
- `id`: retained child-run id for management actions

Child runs use the same recipe directory and current Pi workspace as the parent session.

## Commands

The extension registers:

- `/recipe`: active recipe summary, selected agent, model, thinking level, visible subagents, and active tools from the recipe.

## Resources

`resources_discover` returns:

- `skillPaths`
- `promptPaths`
- `themePaths`

Declared manifest paths are used first. When omitted, conventional folders are used if present.
