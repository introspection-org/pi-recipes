# Host API

The Recipes Host API turns Recipe source into a complete live Pi agent. It
defines the boundary between the portable agent and the system operating it.

## API layers

```text
resolveRecipeGraph()     parse every agent in the portable package once
    │
    ├── graph.select()   select root and child execution plans
    │
    ▼
createRecipeSessionFromResolved()
                          construct one selected plan
    │
    ├── createRecipeSession()
    │                     resolve one plan and construct it
    │
    └── runRecipe()       execute one turn and dispose
```

Hosts choose the lowest layer they need.

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

Long-lived hosts and hosts with persistent subagents should resolve the package
graph once, then select root and child plans from it:

```ts
import { resolveRecipeGraph } from "@introspection-ai/recipes/recipe";
import {
  createRecipeSessionFromResolved,
} from "@introspection-ai/recipes/session";

const graph = resolveRecipeGraph({ recipeDir });
const recipe = graph.select(agentName);
const credentials = await credentialsFor(recipe.modelSpec);

const handle = await createRecipeSessionFromResolved(recipe, {
  cwd: workspaceDir,
  credentials,
});

const childRecipe = graph.select("researcher");
```

This keeps inspection and construction on the same resolution results and
avoids reparsing the package for every child session. `resolveRecipe()` remains
the convenience API for selecting one plan.

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
  otel: {
    tracer,
    meter,
    meta: { conversationId },
    runSpans: false,
    getParentContext: () => currentTurnContext,
  },
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
- `dispose()` — child, session, instrumentation, and MCP cleanup.

Host injection is intentional. A managed host can supply durable session state,
cross-process subagent execution, inline endpoint bindings, platform
extensions, its own settings, an event bus, host tools, and a
gateway-decorated model without reimplementing Recipe semantics. The Recipe
continues to own model configuration and tool selection; host seams replace
transport and materialized resources, not the portable definition.

Recipes are trusted application code, not untrusted data. A package can contain
TypeScript extensions that execute in the Pi process with that process's
filesystem, environment, and network authority. Hosts accepting third-party
Recipes must provide their own review, sandbox, and tenant-isolation boundary
before session construction.

Default MCP materialization leases the supplied `env` object until the handle
is disposed and restores its prior MCP/PATH state afterward. Concurrent
materialized sessions must receive separate environment objects. A host that
materializes MCP once for a process passes `mcpMode: "inherit"` to each
session.

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

## OpenTelemetry

Pass a tracer through `otel` to attach the JS SDK's OpenTelemetry GenAI
semantic-convention instrumentation to the session. Recipes derives default
agent identity from the resolved package and generates a conversation id when
the host does not provide one. The default in-process subagent controller
inherits that conversation id while each child derives its own Recipe agent
identity. Injected run controllers own their child-session instrumentation.

Recipes does not create or register an OTel provider, processor, exporter, or
global context manager. The host owns that pipeline and its content policy, so
the same session instrumentation works with any OTLP-compatible backend. A
host that needs structure-only traces can wrap its exporter with
`GenAiContentScrubbingExporter` from `@introspection-sdk/introspection-pi`.

Short-lived hosts must flush their own provider after `runRecipe` completes;
long-lived hosts should flush and shut it down with the host lifecycle.

## Host conformance

```ts
import { hostConformanceCases } from "@introspection-ai/recipes/test-utils";

for (const testCase of hostConformanceCases(myHost)) {
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
- provider-specific hosting integrations.

Those layers compose above `createRecipeSession`.
