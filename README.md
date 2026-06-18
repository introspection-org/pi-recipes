# @introspection/pi-recipes

Portable Pi recipe infrastructure for creating, sharing, and running agent "brains" locally.

This package separates the recipe brain specification from the runtime hands that execute it:

- **Recipe brain spec**: manifests, agents, profiles, prompts, skills, and validation.
- **Local runtime**: filesystem workspace/resource handling and a Pi `AgentSession` driver.
- **Pi extension**: launch-time recipe wiring for local Pi sessions.

The Introspection cloud runtime is intentionally not implemented here. Cloud behavior lives in `introspection-cloud` as a platform adapter.

## Package Exports

- `@introspection/pi-recipes`: core recipe types, manifest helpers, runner interfaces, and local runner APIs.
- `@introspection/pi-recipes/local`: local adapter/runtime helpers.
- `@introspection/pi-recipes/pi-extension`: Pi extension entrypoint.
- `@introspection/pi-recipes/testing`: test helpers for extension/runtime tests.

## Pi Extension

The package declares its Pi extension in `package.json`:

```json
{
  "pi": {
    "extensions": ["./dist/pi-extension.js"]
  }
}
```

The extension registers launch flags instead of a local `/recipe` command:

```bash
pi --recipe /path/to/recipe
pi --recipe /path/to/recipe --recipe-profile deep
pi --recipe /path/to/recipe --recipe-agent reviewer
```

The launched Pi session is the selected recipe's main agent:

- the current Pi working directory remains the writable project workspace;
- `SYSTEM.md`, selected agent instructions, and local runtime context are injected into the live session prompt;
- the selected profile/agent can set the session model, thinking level, and active tools;
- declared recipe extensions are loaded during session startup before active tools are selected;
- declared recipe skills, prompt templates, and themes are loaded from the recipe manifest;
- agents listed in the selected agent YAML's `subagents` field are exposed through a local `agent` tool.

## Adapter Boundary

Recipes remain portable brain specs. Runtime hosts provide execution through adapters. The local adapter now accepts a neutral `RunnerTranscriptSink`, so Pi can stream run events to its UI while other hosts can persist, forward, or ignore the same events.

The current interface is sufficient for one-shot isolated runs with streamed transcript events. It can reliably report which skills were loaded and can report explicit skill use when the prompt contains a `/skill:name` invocation or Pi emits a parsed skill block. A deeper "model used this skill" signal is not currently observable from the Pi session API; if we need that distinction, the neutral adapter contract needs a structured skill-invocation event from the underlying runtime. The other remaining gap is a first-class resumable run handle: follow-up prompts against an existing recipe session, cancellation/status lookup by run id, and richer transcript pagination should become neutral runner APIs before we implement `/recipe follow` or a full recipe TUI mode.

## Local Runtime

Use the local runner directly from Node:

```ts
import { createLocalRecipeRunner } from "@introspection/pi-recipes";

const runner = createLocalRecipeRunner({
  recipeDir: "/path/to/recipe",
});

await runner.start();
await runner.prompt("Run this recipe locally.");
await runner.shutdown();
```

The local runtime uses direct model provider environment variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_API_KEY`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Status

This package is private while publishing, licensing, and final distribution decisions are settled.
