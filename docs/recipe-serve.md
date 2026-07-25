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
serveRecipe()                  ./serve     HTTP service: runs, streaming, lifecycle
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
  env?: Record<string, string>;  // ${VAR} resolution source; default process.env
  sessionManager?: SessionManager;        // default SessionManager.inMemory(cwd)
  extensionFactories?: ExtensionFactory[]; // appended after recipe extensions
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
  `createAgentTool(runs, recipe.subagents)`.
- **Interactions** use the headless channel; asks resolve per
  [`PI_ASK_USER_AUTO_APPROVE`](interactions.md).
- No HTTP, no lifecycle policy, no persistence opinion — those belong to
  the rungs above, or to the caller via `sessionManager`.

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

A fetch-native app implementing the HTTP contract below, plus a Node
listener.

```ts
interface ServeRecipeOptions {
  recipeDir: string;
  agentName?: string;
  token?: string;       // inbound bearer; default env RECIPES_SERVE_TOKEN;
                        // unset → auth disabled (trusted-network deploys)
  workspace?: string;   // agent cwd; default process.cwd()
  onEvent?: (event: AgentSessionEvent) => void; // observability tap only
}

interface RecipeServer {
  fetch(request: Request): Promise<Response>; // default-exportable on fetch runtimes
  listen(options?: { port?: number; hostname?: string }): Promise<void>;
  close(): Promise<void>; // drain in-flight run, then stop
}
```

That is the whole options surface, deliberately. The server holds **one
agent session for the process lifetime**: constructed lazily on the first
run, reused across turns. Scale-out is the deploy target's job — one
container per conversation, which is also what makes snapshot/pause-resume
clouds (Daytona, Vercel Sandbox) work naturally.

### HTTP contract

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| `GET` | `/` | Liveness: `{ "status": "ok" }` | none |
| `GET` | `/status` | `{ status, is_streaming, idle_seconds }` | none |
| `POST` | `/v1/runs` | Submit a turn | bearer |
| `GET` | `/v1/runs/{run_id}` | Snapshot run state | bearer |
| `POST` | `/v1/runs/{run_id}/cancel` | Best-effort cancel | bearer |
| `GET` | `/v1/runs/{run_id}/stream` | SSE stream of run events | bearer |

`POST /v1/runs` body:

```json
{ "prompt": { "text": "…" }, "run_id": "optional-caller-id", "kind": "prompt" }
```

- `kind: "prompt"` starts a fresh turn; `409 Conflict` if one is in
  flight. `kind: "steer"` injects into the in-flight turn (falls back to a
  fresh turn when idle). Omitted `kind` classifies by busy-state.
- Response `201`: `{ "id", "status": "running", "created_at", "updated_at" }`.
  Run ids are minted as UUIDv7 when not supplied.
- Errors use `{ "error": "reason" }` with conventional status codes.
- Auth is a timing-safe byte compare against the configured token.

**Stream framing.** SSE, where each `data:` payload is one event from
**Pi's documented JSON event schema** — the same events `pi --mode json`
emits (`agent_start`, `turn_*`, `message_*` with `text_delta` /
`thinking_delta`, `tool_execution_*`, `auto_retry_*`, `agent_end`) —
prefixed by a `session` header event on connect, with a `heartbeat` every
15 s and a final `done` sentinel after the turn settles. Reusing Pi's
schema means anything that can consume `pi --mode json` output can consume
this stream, and the serve layer adds no translation layer of its own.
Content events carry monotonically increasing SSE `id:`s; clients may
resume after a disconnect via `Last-Event-ID` against a bounded in-memory
replay buffer. Responses set `Cache-Control: no-cache, no-transform` and
`X-Accel-Buffering: no` so intermediaries don't buffer the stream.

Versioning: `/v1/` is the version. New optional request fields and new
event types are additive; clients must ignore what they don't know.

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
| Telemetry | standard `OTEL_EXPORTER_OTLP_*`, or any `onEvent` consumer | Optional; nothing is emitted by default |

## Observability

`onEvent` is the seam: it receives every session event and is where any
OpenTelemetry instrumentation (or a plain logger) attaches. The package
itself emits nothing and depends on no telemetry SDK; hosts that want
traces wire an instrumentation of their choice into the tap.

## Non-goals (v1)

- **Multi-session serving.** One recipe, one session, one process.
- **Durable run state.** No local database; completed runs live only in
  the bounded stream buffer and the caller's transcript.
- **File-transfer routes.** The workspace is the container's filesystem;
  artifact movement is the deploy target's concern (volumes, object
  storage).
- **Serve implementations in other languages.** The agent loop is Pi
  (TypeScript); other languages are clients of the HTTP contract.

## Rollout

| Phase | Deliverable |
| --- | --- |
| 1 | `./session` + `./run`, Pi `^0.82` / `ModelRuntime` migration, tests against a scripted model |
| 2 | `./serve` + `recipes serve` + Dockerfile scaffold + contract tests |
| 3 | `recipes inspect` + `examples/deploy/*` templates |

## Open questions

1. **Steer ergonomics.** Is busy-state classification enough, or do
   template users need explicit queueing (`followUp`) exposed as a third
   `kind`?
2. **Subagent bounds.** Proposed defaults for the in-process controller:
   concurrency 4, depth 2 — to validate against recipes shipping subagents
   today.
3. **Session persistence across restarts.** Snapshot/pause-resume clouds
   preserve process memory, so resume works there by construction; a
   `sessionManager`-backed persistence option would extend it to cold
   restarts. Deferred until a template needs it.
4. **`recipes run` CLI.** `pi --mode json -p` already covers one-shot CLI;
   add a `recipes run` alias only if CI users ask.
