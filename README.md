# @introspection/pi-recipes

Portable Pi recipe infrastructure for creating, sharing, and running agent "brains" locally.

This package separates the recipe brain specification from the runtime hands that execute it:

- **Recipe package spec**: package manifests, agent YAML, profile YAML, system prompts, skills, prompts, themes, extensions, and validation.
- **Neutral runner core**: adapter interfaces, launch context/resource types, lifecycle sequencing, transcript event types, and session driver contracts.
- **Local runtime**: local recipe materialization, workspace/output resource handling, direct provider credentials, and a Pi `AgentSession` driver.
- **Pi extension**: launch-time recipe wiring for local Pi sessions.

The Introspection cloud runtime is intentionally not implemented here. Cloud behavior belongs in `introspection-cloud` as a platform adapter.

## Package Exports

- `@introspection/pi-recipes`: core types and helpers, including adapter types, env helpers, local runner APIs, recipe loading/validation, session driver APIs, and the recipe-agents extension factory.
- `@introspection/pi-recipes/local`: local adapter/runtime helpers.
- `@introspection/pi-recipes/pi-extension`: Pi extension entrypoint.
- `@introspection/pi-recipes/testing`: test helpers for extension/runtime tests.

## Recipe Package Shape

A recipe is a local package directory with a `package.json`. Resource paths can be declared under `pi`; if they are omitted, the loader uses conventional folders where present.

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

Conventional defaults:

- `agents`
- `profiles`
- `skills`
- `prompts`
- `themes`

Agent YAML supports:

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

The `skills` field is parsed as agent metadata today; local Pi resource discovery currently loads declared package skills from the manifest/default `skills` folder rather than filtering skills per agent.

Profile YAML selects an entrypoint and can override model/thinking level and system instructions:

```yaml
name: deep
entrypoint: agent
model:
  name: anthropic/claude-sonnet-4-5
  thinking_level: high
prompt: Profile-specific instructions.
```

`SYSTEM.md` is used as the recipe-level system prompt when present. Profile and agent `system_instructions` are applied on top of it; `mode: replace` replaces the current prompt, while the default `append` behavior appends content.

## Pi Extension

The package declares its Pi extension in `package.json`:

```json
{
  "pi": {
    "extensions": ["./dist/pi-extension.js"]
  }
}
```

The extension registers launch flags. It does not register the old local `/recipe` command.

```bash
pi --recipe /path/to/recipe
pi --recipe /path/to/recipe --recipe-profile deep
pi --recipe /path/to/recipe --recipe-agent reviewer
```

The same selections can be supplied with env vars:

- `PI_RECIPE_DIR`
- `PI_PROFILE_NAME`
- `PI_AGENT_NAME`

During session startup, the selected recipe configures the live Pi session:

- the current Pi working directory remains the writable project workspace;
- `SYSTEM.md`, selected profile instructions, selected agent instructions, and local runtime context are injected into the session prompt;
- the selected profile/agent can set the session model, thinking level, and active tools;
- declared recipe extensions are loaded before active tools are selected;
- declared recipe skills, prompt templates, and themes are surfaced through Pi resource discovery;
- agents listed in the selected agent YAML's `subagents` field are exposed through an `agent` tool.

The launch extension's `agent` tool starts a selected subagent, streams prompt/output updates into the tool block, and waits for completion by default. Pass `wait: false` to keep a child run in the background, then use `action: "status"`, `"wait"`, `"interrupt"`, or `"close"`.

## Local Runtime

Use the local runner directly from Node:

```ts
import { createLocalRecipeRunner } from "@introspection/pi-recipes";

const runner = createLocalRecipeRunner({
  recipeDir: "/path/to/recipe",
  profileName: "deep",
  agentName: "agent",
});

await runner.start();
await runner.prompt("Run this recipe locally.");
await runner.shutdown();
```

The local runtime can also read launch context from `PI_*` variables:

- `PI_TASK_ID`, `PI_RUN_ID`, `PI_CONVERSATION_ID`, `PI_PROJECT_ID`
- `PI_RECIPE_DIR`, `PI_PROFILE_NAME`, `PI_AGENT_NAME`
- `PI_WORKSPACE_DIR`, `PI_REPOS_DIR`, `PI_UPLOADS_DIR`, `PI_OUTPUTS_DIR`, `PI_MEMORIES_DIR`
- `PI_AGENT_BIN_DIR`, `PI_AGENT_SKILLS_DIR`
- `PI_TASK_METADATA_JSON`

Model credentials come from direct provider environment variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_API_KEY`, unless an adapter supplies a custom `ModelCredentialProvider`.

## Adapter Boundary

Recipes remain portable brain specs. Runtime hosts provide execution through adapters. The local adapter accepts a neutral `RunnerTranscriptSink`, so Pi, cloud hosts, or web hosts can stream, persist, forward, or ignore the same transcript events.

The current interface is sufficient for isolated runs with streamed transcript events. It can reliably report loaded skills and can report explicit skill use when the prompt contains a `/skill:name` invocation or Pi emits a parsed skill block. A deeper "model used this skill" signal is not currently observable from the Pi session API; if we need that distinction, the neutral adapter contract needs a structured skill-invocation event from the underlying runtime.

The main remaining gap is a first-class resumable run handle: follow-up prompts against an existing recipe session, cancellation/status lookup by run id across processes, and richer transcript pagination should become neutral runner APIs before implementing `/recipe follow` or a full recipe TUI mode.

See [docs/runtime-adapters.md](docs/runtime-adapters.md) for the detailed architecture.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Status

This package is private while publishing, licensing, and final distribution decisions are settled.
