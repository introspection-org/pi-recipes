# Recipe serve

**Status:** Proposal.

Run a recipe as a long-lived service — in a container, on a VM, or on any
sandbox cloud (Docker, Modal, Daytona, Fly, Vercel Sandbox, Cloud Run) —
with nothing but Node, provider API keys, and the recipe directory.

Today a recipe runs interactively (`pi --recipe .`) or one-shot
(`pi --mode json -p …`). There is no serving entrypoint: Pi's RPC mode is
deliberately stdio-only, and the [portability boundary](index.md) ends at
"embed the resolver in your own host". This document specifies that host —
a small, first-party one — so deploying a recipe somewhere is a template,
not a project.

```ts
// api/agent.ts — the whole app
import { serveRecipe } from "@introspection-ai/pi-recipes/serve";
export default serveRecipe({ recipeDir: "." });
```

## The embedding ladder

The API is four rungs. Each rung is implemented on the rung below it, and
every rung is public: convenience at the top, control by peeling a layer,
never by configuring one.

```
serveRecipe()                  ./serve     Tasks API service: tasks, runs, AG-UI streams
  └─ runRecipe()               ./run       one-shot: prompt in → result out
       └─ createRecipeSession() ./session  a live Pi session you drive
            └─ resolveRecipe()  ./recipe   interpretation only (exists today)
```

Design rules:

1. **Peelable, not configurable.** When a rung doesn't expose a behavior
   (custom result sinks, your own tools, session persistence policy), the
   documented answer is "drop one rung", never a new option. `serveRecipe`
   accepts identity-and-binding options only.
2. **Standalone by construction.** No hosted service is assumed or
   contacted. Credentials are ambient env (or an injected store), MCP
   bindings are the existing `${VAR}` shape, telemetry is a local tap.
3. **No provider SDKs.** Cloud integration is a deploy template written in
   each provider's own idiom, hosting this one server. Nothing
   provider-specific lives in the package.

## Pi baseline

The ladder targets the current Pi surface (`@earendil-works/*` ≥ 0.82):

- Session construction via `createAgentSessionServices` /
  `createAgentSessionFromServices`.
- Model auth via `ModelRuntime.create({ credentials })` with a pi-ai
  `CredentialStore` — the 0.80.8 shape; `AuthStorage` is gone.
- Tools as string-name allowlists (`ResolvedRecipe.tools` already matches).
- Subagents via the recipe `agent` tool (`createAgentTool` +
  `AgentRunController`) — Pi has no first-party subagent API.
- Node ≥ 24 (the existing floor).

Adopting this spec includes bumping the pinned Pi peer range to `^0.82`
and migrating off `AuthStorage`.

## Rung 3: `createRecipeSession` — export `./session`

Everything between "resolved recipe" and "live Pi session", done once:
model construction and credentials, MCP materialization, skills /
extensions / system-prompt wiring, subagent tool registration.

```ts
import { createRecipeSession } from "@introspection-ai/pi-recipes/session";

const handle = await createRecipeSession({ recipeDir: "./my-recipe" });
await handle.session.prompt("triage the open issues");
await handle.dispose();
```

```ts
interface CreateRecipeSessionOptions {
  recipeDir: string;
  agentName?: string;            // default: agents/agent.yaml → single-agent rule
  cwd?: string;                  // agent workspace; default process.cwd()
  credentials?: CredentialStore; // default: derived from provider env keys
  model?: string;                // override the recipe's model spec
  thinkingLevel?: ThinkingLevel;
  mcpBindingsPath?: string;      // default: <recipeDir>/.pi/mcp.local.json
  mcpBindings?: McpLocalConfig;  // inline alternative, for hosts that
                                 // synthesize bindings instead of reading a file
  env?: Record<string, string>;  // ${VAR} resolution source; default process.env
  sessionManager?: SessionManager;        // default SessionManager.inMemory(cwd)
  settingsManager?: SettingsManager;      // host-owned settings (compaction, retry)
  extensionFactories?: ExtensionFactory[]; // appended after recipe extensions
  runController?: AgentRunController;     // replace the in-process subagent controller
  additionalSkillPaths?: string[];        // extra skill roots beyond the recipe's
  systemPrompt?: (resolved: string) => string; // post-resolution override hook
  onEvent?: (event: AgentSessionEvent) => void; // tap on session.subscribe
}

interface RecipeSessionHandle {
  session: AgentSession;   // prompt / steer / followUp / abort / subscribe
  recipe: ResolvedRecipe;
  runs: AgentRunController; // in-process default subagent controller
  dispose(): Promise<void>; // abort in-flight turn, dispose session, stop MCP
}
```

Specified behavior:

- **Fails closed at construction.** `RecipeResolutionError` propagates. A
  declared MCP server with `required: true` and no binding → typed error
  naming the server and its unresolved `${VAR}`s. A model whose provider
  has no credential → typed error naming the expected env var.
- **Default credentials** resolve: explicit store → per-provider env keys
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
  `OPENROUTER_API_KEY`, …) → error. Nothing is written to disk.
- **Subagents:** when the agent declares subagents, the shared `agent`
  tool is registered against an in-process controller that spawns child
  sessions through this same rung (bounded concurrency and depth; child
  events surface through `onEvent`). A host wanting cross-process or
  sandboxed subagents supplies its own controller by dropping to
  `createAgentTool(runs, recipe.subagents)`. Recovery edge every
  controller must honor: if a pending child's agent profile no longer
  exists (the recipe changed), the parent's `agent` tool call resolves as
  an error — it must never wedge the parent turn.
- **Interactions** use the headless channel; asks resolve per
  [`PI_ASK_USER_AUTO_APPROVE`](interactions.md).
- No HTTP, no lifecycle policy, no persistence opinion — those belong to
  the rungs above, or to the caller via `sessionManager`.

The host-injection options (`credentials`, `mcpBindings`,
`extensionFactories`, `runController`, `settingsManager`,
`additionalSkillPaths`, `systemPrompt`) exist so that *any* host — the
serve layer here, and equally a managed runtime — can adopt this rung as
its recipe engine without forking it: platform-specific credential
brokers, synthesized MCP bindings, cross-process subagent controllers,
and prompt/settings policy all inject through options rather than through
a copied implementation. One engine, many hosts: the Pi CLI hosts it via
[`./pi-extension`](pi-extension.md), `serveRecipe` hosts it per task, and
a hosted runtime can wrap it in its own lifecycle and identity layer.

A **host conformance suite** ships with the engine (`test-utils`):
acceptance tests a host runs in its own CI against its injected pieces —
credential store resolution, binding synthesis, run-controller lifecycle
(including the recovery edges below). Passing the suite is what
"supported host" means; the first-party hosts run it themselves, so the
engine's contract cannot drift from its consumers silently.

## Rung 2: `runRecipe` — export `./run`

One turn, no server: CI, cron, queue workers, tests. The programmatic
analog of `pi --mode json -p`.

```ts
import { runRecipe } from "@introspection-ai/pi-recipes/run";

const result = await runRecipe({
  recipeDir: "./my-recipe",
  prompt: "summarise the last deploy",
});
```

```ts
interface RunRecipeOptions extends CreateRecipeSessionOptions {
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface RecipeRunResult {
  status: "finished" | "failed" | "cancelled";
  text: string;             // final assistant message text ("" if none)
  messages: AgentMessage[]; // full transcript, Pi's message shape
  error?: string;           // present iff status === "failed"
}
```

Semantics: create session → single `prompt()` → await settle →
`dispose()`, always, including on timeout or abort (`"cancelled"`).
Agent-level failure never throws — it lands in `status: "failed"`; only
caller mistakes (bad options, unreadable recipe) throw.

## Rung 1: `serveRecipe` — export `./serve`

A **standalone Tasks API server** for the recipe: a fetch-native app
serving the Introspection public Tasks surface — CRUD over tasks, runs
within a task, and [AG-UI](https://docs.ag-ui.com/) event streams per run
— with all state held in-process. A *task* is a conversation; creating one
creates a Pi session; deploying a recipe therefore yields a small
self-contained conversation service, not just a bare turn endpoint.

This is the AgentOS pattern (define agents in code, hand them to a
runtime, get a self-hosted app with a full REST API that SDKs and UIs
connect to directly), applied to recipes — with the API shape being the
Introspection Tasks contract rather than an invented one, so existing
task clients work against a served recipe by changing the base URL.

```ts
interface ServeRecipeOptions {
  recipeDir: string;
  agentName?: string;   // default agent for created tasks (overridable per task)
  token?: string;       // inbound bearer; default env RECIPES_SERVE_TOKEN;
                        // unset → auth disabled (trusted-network deploys)
  workspace?: string;   // workspace root; each task gets <root>/<task_id>/
  maxTasks?: number;    // live-session cap; default 8; excess → 409
  onTask?: (taskId: string, handle: RecipeSessionHandle) => void;
                        // lifecycle tap: called as each task's session is
                        // created — the instrumentation/logging seam
}

interface RecipeServer {
  fetch(request: Request): Promise<Response>; // default-exportable on fetch runtimes
  listen(options?: { port?: number; hostname?: string }): Promise<void>;
  close(): Promise<void>; // drain in-flight runs, dispose sessions, stop
}
```

### Wire contract — the Tasks API subset

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| `POST` | `/v1/tasks` | Create a task (= conversation = Pi session); optional first `prompt`, optional `agent_name` | bearer |
| `GET` | `/v1/tasks` | Cursor-paginated list of live tasks | bearer |
| `GET` | `/v1/tasks/{task_id}` | Task view: id, status, agent_name, timestamps, last-response metadata | bearer |
| `DELETE` | `/v1/tasks/{task_id}` | End the conversation: dispose the session, free the slot | bearer |
| `POST` | `/v1/tasks/{task_id}/cancel` | Abort the task's in-flight run | bearer |
| `POST` | `/v1/tasks/{task_id}/runs` | Submit a turn (prompt or steer) → run view | bearer |
| `GET` | `/v1/tasks/{task_id}/runs/{run_id}/stream` | AG-UI event stream (SSE) for the run | bearer |
| `GET` | `/config` | Instance bootstrap document: recipe name/version, agents, capabilities (the `recipes inspect` derivation served over HTTP) | bearer |
| `GET` | `/health` | Liveness probe (non-normative) | none |

Shapes follow the platform's public Tasks API: CRUD-only routes plus the
sanctioned protocol verbs `/cancel` and `/stream`; task and run ids are
UUIDv7; list pagination is cursor-based; task `status` uses the platform
vocabulary restricted to what a standalone server owns (`running`, `idle`,
`completed`, `failed`, `cancelled` — no provisioning states, since
creating a task creates the session synchronously).

Binding semantics:

- **Task = conversation = one Pi session**, created via rung 3 at
  `POST /v1/tasks`, disposed at `DELETE`. Each task runs in its own
  workspace subdirectory under the workspace root.
- **One run at a time per task.** A new prompt while a run is in flight →
  `409 Conflict`; a steer joins the in-flight turn. Tasks are independent
  — concurrent runs on different tasks are fine, bounded by `maxTasks`.
- **State is in-process.** The task registry and transcripts live with
  their sessions; a restart is a fresh server (see non-goals). Durable
  conversation state is the platform's product, not this server's.
- **Cancel is a settlement with defined races.** A cancel that loses the
  race to a finished run settles as `completed` (finished wins); a crash
  or disconnect mid-cancel settles the run as `cancelled`, never retried.
  Cancellation is asynchronous; the terminal state is observable on the
  stream and the task view.
- Auth is a timing-safe byte compare against the configured token; there
  is one bearer for the whole server (no tenancy — see non-goals).
  **Unauthorized is indistinguishable from nonexistent:** a wrong or
  missing bearer on a task route returns the same `404` as an unknown
  task id, so the API is not an oracle for probing ids.

### Run streams (AG-UI)

Each run's `/stream` is an AG-UI event stream — `RUN_STARTED`,
`TEXT_MESSAGE_START/CONTENT/END`, `TOOL_CALL_START/ARGS/END`,
`TOOL_CALL_RESULT`, `RUN_FINISHED` / `RUN_ERROR` — encoded per the AG-UI
spec (`@ag-ui/core` types + `@ag-ui/encoder`, SSE with JSON/protobuf
content negotiation). Pi session events map onto AG-UI events under the
protocol's strict start/content/end id discipline; this translator
already exists, battle-tested, in the first-party managed runtime, and
adopting this spec includes extracting it here so it is written once and
shared. Responses set `Cache-Control: no-cache, no-transform` and
`X-Accel-Buffering: no`; SSE comments keep idle connections alive. Any
AG-UI consumer (`@ag-ui/client`, CopilotKit components, a plain SSE
reader) can render a run's stream as-is.

**Reconnection contract.** Every event on a run's stream carries a
sequential `event_index` (the SSE `id:`). A client that reconnects sends
its last index (`Last-Event-ID` header or `?last_event_index=`); the
server opens the stream with one meta-event declaring what follows —
`catch_up` (run still live: buffered events replay, then live events),
`replay` (run finished: buffered events replay to the terminal event), or
`subscribed` (nothing missed: live from here) — then delivers events with
their original indexes. The per-run buffer is bounded; an index older
than the retained window yields a `gap` meta-event so the client refetches
task state rather than trusting a silently incomplete replay.

### Compatibility promise

The acceptance test for this surface is client reuse: a task client built
for the platform's public Tasks API — including the Introspection SDKs'
task runner (create → run → stream → cancel), pointed at this server's
base URL with its bearer — round-trips unchanged. Resources this server
does not implement (conversations, files, events, metrics, shares) return
`404`; clients that need them need the platform.

### Roadmap (deliberately not in v1)

The internal seam is adapter-shaped — a surface takes the task registry /
`RecipeSessionHandle`s and returns a fetch sub-app — so these add later
as small adapters without reworking the server:

- **Human-in-the-loop pause/continue.** Today serve runs headless
  (`PI_ASK_USER_AUTO_APPROVE`). v2: a tool ask surfaces as task status
  `paused` with the pending tool calls, and
  `POST /v1/tasks/{id}/continue` carries per-tool-call `confirmed`
  flags. The taxonomy to build toward: user confirmation vs
  organizational approval vs audit-only.
- **Browser→instance control plane.** With `/config` plus a CORS
  allowlist option, a hosted UI can talk directly from the operator's
  browser to a served instance — dashboard UX with zero vendor data
  custody.
- **Protocol facades:** a bare single-session AG-UI endpoint, A2A
  (agent card + delegation), and MCP recipe-as-tool exposing the full
  lifecycle (`run` / `get` / `continue` / `cancel`) with a
  `result_mode: trimmed | full` knob for caller context budgets.

## CLI: `recipes serve`

```
recipes serve [recipe-dir] [--agent <name>] [--port 8888] [--host 127.0.0.1]
              [--token <bearer>] [--workspace <dir>]
```

A thin wrapper over `serveRecipe().listen()`; flags mirror the options
one-to-one. Any construction error (§rung 3) exits non-zero at boot —
fail-fast is the deploy story: a container that cannot serve its recipe
must crash, not `500`.

`recipes create` scaffolding gains a commented `Dockerfile`
(`node:24-slim` → `npm ci` → `CMD ["npx", "recipes", "serve", "."]`) so
every new recipe is deployable from day one.

## `recipes inspect`

Deploy templates (and humans) need to know what a recipe requires before
running it. Nearly all of it is already derivable from the package — no
new manifest keys:

```
recipes inspect [dir] --json
```

```json
{
  "name": "@acme/triage",
  "agents": ["agent", "reviewer"],
  "providers": ["anthropic"],
  "credential_env": ["ANTHROPIC_API_KEY"],
  "mcp": { "required": ["linear"], "optional": ["slack"] },
  "mcp_env": ["LINEAR_MCP_URL", "LINEAR_MCP_TOKEN"],
  "resources": { "agents": 2, "skills": 3, "extensions": 1, "prompts": 0 }
}
```

Derivations: `providers` from resolved agent `model.name` prefixes;
`mcp.required` / `optional` from `pi.mcp.servers[].required`; the `*_env`
lists from `placeholderEnvVars()` plus the provider-key mapping.
`serveRecipe` runs the same derivation for its boot-time fail-fast, and
catalogs can generate their capability metadata from it instead of
curating it by hand.

## Deploy templates

`examples/deploy/<target>/` in this repo, each a few dozen lines of the
target's own idiom hosting the same server:

- **Docker / any port-exposing host** — the scaffolded `Dockerfile`;
  reference for Fly, Cloud Run, Railway, plain Kubernetes.
- **Modal** — `modal.Image.from_dockerfile(...)` + `@modal.web_server(8888)`.
- **Daytona** — snapshot from the image, `recipes serve` as the entry
  process, port exposed via the preview URL.
- **Vercel** — via **Vercel Sandbox** (`Sandbox.getOrCreate` + the image),
  not plain functions: recipes need a writable POSIX workspace and a real
  shell for the `bash` tool, which rules out edge/isolate runtimes. The
  same constraint applies to Cloudflare (containers, not Workers).

Every template README states the target requirements: Node ≥ 24, writable
filesystem, outbound HTTPS to model providers and any bound MCP endpoints,
unbuffered response streaming.

## Configuration

| Source | Keys | Notes |
| --- | --- | --- |
| Provider credentials | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, … | Resolved via `ModelRuntime`; injectable as a `CredentialStore` |
| MCP bindings | the `${VAR}`s referenced by `.pi/mcp.local.json` | Existing portable shape; unresolved placeholders are printed at boot, `required` servers fail closed |
| Inbound auth | `RECIPES_SERVE_TOKEN` | Unset → auth disabled |
| Interactions | `PI_ASK_USER_AUTO_APPROVE` | Headless ask resolution ([interactions](interactions.md)) |
| Telemetry | standard `OTEL_EXPORTER_OTLP_*`, or `INTROSPECTION_TOKEN` (+ `INTROSPECTION_BASE_OTEL_URL`) | Optional; nothing is emitted by default |

## Instrumentation

Nothing is emitted by default. When an export target is configured, the
package attaches the same **GenAI semantic-convention** instrumentation
the managed runtime uses and exports the traces out of the host — three
layers, all opt-in:

1. **Built-in OTel export (env-gated).** `serveRecipe` (and any host that
   calls `initRecipeTelemetry` from `./tracing`) builds a trace
   provider when an OTLP target is configured, and every session the
   engine creates — subagents included — is instrumented: one
   `invoke_agent` span per run, `chat {model}` spans with token usage,
   `execute_tool` spans per tool call, the task id as
   `gen_ai.conversation.id`. Two env-driven targets, either or both:

   - `OTEL_EXPORTER_OTLP_ENDPOINT` (+ `_HEADERS`, …) — the standard OTLP
     contract; any collector or vendor backend renders it.
   - `INTROSPECTION_TOKEN` (+ `INTROSPECTION_BASE_OTEL_URL`) — plain OTLP
     with a bearer header to the Introspection ingest, the same pair the
     managed runtime uses, so conversations from a recipe served anywhere
     appear in the product.

   The instrumentation itself is
   [`@introspection-sdk/introspection-pi`](https://www.npmjs.com/package/@introspection-sdk/introspection-pi)
   — a standalone OTel-semconv package (no platform client). Spans carry
   full conversation content; keep the export target under the same data
   policy as the provider keys.

2. **The seam (library).** `serveRecipe`'s `onTask(taskId, handle)` fires
   as each task's session is created, handing the live session to
   whatever the host wants to attach — an instrumentation wrapper, a
   logger via `handle.session.subscribe`, metrics. Rungs 2–3 need no tap:
   they return the session/handle directly.

3. **Host-owned providers (composition).** A host that already runs its
   own OTel setup skips `initRecipeTelemetry` (which returns a
   `RecipeTelemetry` handle — flush/shutdown ownership — only to the
   caller that created the provider, and `null` whenever one exists; if
   the host registered a global tracer provider first, init backs off
   without overwriting it) and calls
   `instrumentRecipeSession(session, { tracer, meta })` with its own
   tracer. Hosts that also own the span topology — their own turn/run
   spans — pass `runSpans: false` plus `getParentContext`, and
   optionally `abortTerminationReason` (classify user-requested stops)
   and `extraAttributes` (tenant labels), so chat and tool spans nest
   under the host's spans instead of a package-created run span.

The `./tracing` module keeps its runtime imports to the OTel API plus the
instrumentation package; the export pipeline (SDK provider, OTLP/protobuf
exporters) loads lazily inside `initRecipeTelemetry`, so embedding rungs
that never export pay nothing at module-eval time.

Catalog telemetry opt-outs (`DO_NOT_TRACK`, `PI_RECIPES_NO_TELEMETRY`)
are unrelated to run instrumentation and unchanged by this document.

## Naming (decision pending)

Recommendation: rename the package to `@introspection-ai/recipes` as part
of phase 1 — the CLI is already `recipes`, the format is positioned as a
portable agent-system package rather than a Pi-only artifact, and the
blast radius only grows once `./serve` ships. Scope: package identity
only — the `recipes` bin, `PI_RECIPE_DIR`/`PI_RECIPES_*` env vars, and
the pi.recipes domain are unchanged; the old name publishes as a
deprecated alias re-exporting the new package; repo renames may trail.
"Pi Recipes" remains the long-form project name where the harness
matters.

## Non-goals (v1)

- **Durability and tenancy.** The task registry is in-process: a restart
  is a fresh server, and there is one bearer for the whole instance — no
  users, orgs, or per-task auth. Durable, multi-tenant conversation state
  is a platform product, not this server.
- **Task isolation beyond a workspace directory.** Tasks in one process
  share the container (filesystem, network, env). Deployments that need
  hard isolation run one task per container and put a router in front —
  the sandbox clouds' native model.
- **Non-task resources.** No conversations, files, events, metrics, or
  shares routes; unimplemented resources return `404`.
- **Serve implementations in other languages.** The agent loop is Pi
  (TypeScript); other languages are clients of the HTTP contract.

## Rollout

| Phase | Deliverable |
| --- | --- |
| 1 | `./session` + `./run`, Pi `^0.82` / `ModelRuntime` migration, host conformance suite (`test-utils`), package rename if approved; tests against a scripted model |
| 2 | `./serve` (incl. `/config`, resume contract, cancel settlement) + `recipes serve` + Dockerfile scaffold; acceptance = an Introspection SDK task client round-trips (create → run → stream → cancel) against the served base URL |
| 3 | `recipes inspect` + `examples/deploy/*` templates |

## Open questions

1. **Subagent bounds.** Proposed defaults for the in-process controller:
   concurrency 4, depth 2 — to validate against recipes shipping subagents
   today.
2. **Task persistence across restarts.** Snapshot/pause-resume clouds
   preserve process memory, so live tasks survive there by construction; a
   `sessionManager`-backed persistence option would extend the registry to
   cold restarts. Deferred until a template needs it.
3. **`maxTasks` default.** 8 is a guess; validate against real recipe
   memory footprints (a Pi session + MCP daemon per task).
4. **`recipes run` CLI.** `pi --mode json -p` already covers one-shot CLI;
   add a `recipes run` alias only if CI users ask.
