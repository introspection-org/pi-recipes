# Pi Recipe Extension

The Pi recipe extension turns a local recipe package into the active Pi session configuration.

## Launch Flow

1. Read `--recipe` or `PI_RECIPE_DIR`.
2. Load the recipe package manifest.
3. Resolve the selected profile and agent.
4. Load declared recipe extensions.
5. Set session name, model, thinking level, and active tools.
6. Return recipe resources for skills, prompts, and themes.
7. Compose the session prompt from Pi defaults, `SYSTEM.md`, profile instructions, agent instructions, and recipe runtime context.

## Agent Selection

Selection order:

1. profile `entrypoint`
2. `--recipe-agent` or `PI_AGENT_NAME`
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

## Resources

`resources_discover` returns:

- `skillPaths`
- `promptPaths`
- `themePaths`

Declared manifest paths are used first. When omitted, conventional folders are used if present.
