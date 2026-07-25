# Runtime library

The Recipes runtime library turns Recipe source into a live Pi agent. It is a
library boundary, not a hosting framework.

## The embedding ladder

```text
resolveRecipe()          read and resolve the portable package
    │
    ▼
createRecipeSession()    construct the complete live Pi session
    │
    └── runRecipe()      execute one turn and dispose
```

Hosts should use the lowest layer that preserves their control.

## `resolveRecipe`

```ts
import { resolveRecipe } from "@introspection-ai/recipes/recipe";

const recipe = resolveRecipe({
  recipeDir,
  agentName,
});
```

The result contains the selected agent, visible subagents, model settings,
tools, MCP policy, skills, prompts, extensions, and system-prompt composition.
It does not create a model client or start a session.

## `createRecipeSession`

```ts
import { createRecipeSession } from "@introspection-ai/recipes/session";

const handle = await createRecipeSession({
  recipeDir,
  agentName,
  cwd: workspaceDir,
  credentials,
  modelOverride,
  mcpBindings,
  eventBus,
  customTools,
  extensionFactories,
  runController,
  agentToolOptions,
  settingsManager,
  sessionManager,
  additionalSkillPaths,
  skillPaths,
  systemPrompt,
  onDiagnostics,
  onEvent,
});
```

This is the primary host integration point. It:

- resolves the Recipe and selected agent;
- resolves model credentials fail-closed;
- materializes required MCP bindings fail-closed;
- loads Recipe skills, prompts, and extensions;
- registers the shared subagent tool;
- creates and binds the Pi `AgentSession`;
- returns one idempotent `dispose()` boundary.

The returned `RecipeSessionHandle` exposes:

- `session` — Pi prompt, steer, follow-up, abort, messages, and events;
- `recipe` — the resolved portable definition;
- `runs` — the subagent run controller;
- `dispose()` — child, session, tracing, and MCP cleanup.

Host injection is intentional. A managed host can supply durable session state,
cross-process subagent execution, inline endpoint bindings, platform
extensions, its own settings, an event bus, host tools, and a
gateway-decorated model without reimplementing Recipe semantics. The Recipe
continues to own model configuration and tool selection; host seams replace
transport and materialized resources, not the portable definition.

## `runRecipe`

```ts
import { runRecipe } from "@introspection-ai/recipes/run";

const result = await runRecipe({
  recipeDir,
  cwd: workspaceDir,
  prompt,
  timeoutMs: 120_000,
});
```

`runRecipe` creates one session, executes one prompt, returns the transcript and
final text, and always disposes. It is suitable for tests, cron jobs, and queue
workers that do not need a durable conversational host.

## Inspection

```ts
import { inspectRecipe } from "@introspection-ai/recipes/inspect";

const requirements = inspectRecipe(recipeDir);
```

Inspection derives agents, providers, expected credential variables, required
and optional MCP servers, and resource counts without creating a session.

## Tracing

The tracing module attaches OpenTelemetry GenAI semantic-convention spans to
Recipe sessions. Nothing exports by default.

Standalone hosts can initialize the standard `OTEL_EXPORTER_OTLP_*` pipeline.
Hosts with an existing provider call `instrumentRecipeSession` with their own
tracer. Provider ownership and export policy stay with the host.

## Host conformance

```ts
import { hostConformanceCases } from "@introspection-ai/recipes/test-utils";

for (const testCase of hostConformanceCases(myHostAdapter)) {
  it(testCase.name, testCase.run);
}
```

Passing the suite means the host is using the same session construction
contract as Pi and Introspection. Protocol behavior, persistence, tenancy, and
deployment remain host-specific and require their own tests.

## Deliberate non-features

The package does not provide:

- an HTTP server or wire protocol;
- a task database or task state machine;
- a scheduler or queue;
- sandbox or tenant isolation;
- a deployment CLI;
- provider-specific hosting adapters.

Those layers compose above `createRecipeSession`.
