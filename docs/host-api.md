# Host API

The Recipes Host API turns Recipe source into a complete live Pi agent. It
defines the boundary between the portable agent and the system operating it.

## Surface

```text
                     Recipe package
                           │
                           ▼
                    resolveRecipe()
                           │
                           ▼
              immutable ResolvedRecipe
                           │
                    selectAgent(name)
                           │
                           ▼
                  ResolvedRecipeAgent
                           │
                   createAgentSession()
                           │
                           ▼
          Pi session + AgentRunController
```

Two functions. `resolveRecipe()` parses the package once into an immutable
snapshot; `createAgentSession()` turns one agent from it into a live Pi
session. Everything below that line is the host's.

## `resolveRecipe`

```ts
import { resolveRecipe } from "@introspection-ai/recipes/recipe";

const recipe = resolveRecipe({ recipeDir });
const agent = recipe.selectAgent(agentName);
```

The resolved agent carries visible subagents, model settings, tools, MCP
policy, skills, prompts, extensions, and system-prompt composition. It creates
no model client and starts no session.

Hold the snapshot for the lifetime of a materialized Recipe. Selecting root and
child agents from one parse is what keeps every session in a run reading the
same source, and it avoids reparsing YAML per child.

## `createAgentSession`

`createAgentSession(target, options)` is the host integration point. The target
is either an agent already selected off a `ResolvedRecipe`, or the package
itself, which is resolved for you:

```ts
import { createAgentSession } from "@introspection-ai/recipes/session";

// Resolve for me.
const handle = await createAgentSession(
  { recipeDir, agentName },
  { cwd: workspaceDir, credentials }
);
```

```ts
// Or construct from a snapshot the host already inspected, and select its
// children from that same parse.
const recipe = resolveRecipe({ recipeDir });
const agent = recipe.selectAgent(agentName);

const handle = await createAgentSession(agent, {
  recipe,
  cwd: workspaceDir,
  credentials: await credentialsFor(agent.modelSpec),
});
```

The full options bag:

```ts
const handle = await createAgentSession(
  { recipeDir, agentName },
  {
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
  }
);
```

It:

- resolves the Recipe and selected agent, when given a package;
- resolves model credentials fail-closed;
- materializes required MCP bindings fail-closed;
- loads Recipe skills, prompts, and extensions;
- registers the shared subagent tool;
- creates and binds the Pi `AgentSession`;
- returns one idempotent `dispose()` boundary.

The returned `RecipeSessionHandle` exposes:

- `session` — Pi prompt, steer, follow-up, abort, messages, and events;
- `agent` — the selected resolved portable definition;
- `runs` — the subagent run controller;
- `dispose()` — child, session, instrumentation, and MCP cleanup.

Host injection is intentional. A managed host can supply durable session state,
cross-process subagent execution, inline endpoint bindings, platform
extensions, its own settings, an event bus, host tools, and a
gateway-decorated model without reimplementing Recipe semantics. The Recipe
continues to own model configuration and tool selection; host seams replace
transport and materialized resources, not the portable definition.

The default in-process subagent controller requires the `ResolvedRecipe`
that produced the selected agent. It uses that same snapshot for every child, so
no session reparses the package or observes a different source snapshot.
Injected controllers own child selection and may omit `recipe`.

An injected `runController` is owned by the returned session handle.
`dispose()` calls the controller's `shutdown()` exactly once; controller
implementations use it to release all live child sessions and controller-level
resources. `close(id)` remains the lifecycle operation for one run.

Recipes are trusted application code, not untrusted data. A package can contain
TypeScript extensions that execute in the Pi process with that process's
filesystem, environment, and network authority. Hosts accepting third-party
Recipes must provide their own review, sandbox, and tenant-isolation boundary
before session construction.

In CLI mode, default MCP provisioning leases the supplied `env` object until
the handle is disposed and restores its prior MCP/PATH state afterward.
Concurrent CLI sessions must receive separate environment objects. Tools mode
uses an isolated session environment and does not expose its MCP runtime to
shell tools. A host that provisions MCP separately passes
`mcpProvisioning: "host"` to each session.

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

Short-lived hosts must flush their own provider once their sessions are
disposed; long-lived hosts should flush and shut it down with the host
lifecycle.

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

Those layers compose above `createAgentSession`.
