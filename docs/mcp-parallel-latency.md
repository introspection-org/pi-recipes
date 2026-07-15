# MCP Parallel Call Latency — Investigation

Follow-up to [#78](https://github.com/introspection-org/pi-recipes/pull/78)
(bundled native MCP client resolution). That PR removed per-call client startup
overhead. This note answers the remaining question from the delegation brief:

> When the model emits multiple MCP shell calls intended to run in parallel,
> does Pi actually dispatch them concurrently — and if not, where do they
> serialize?

**Answer: they are already dispatched concurrently, end to end.** Neither Pi's
tool scheduler nor the pi-recipes MCP daemon serializes independent calls. No
`call_batch` daemon protocol and no change to Pi's dispatch are warranted. A
regression guard was added to keep the daemon path concurrent.

## Flow traced

```
model emits parallel tool calls
  → Pi agent loop schedules the tool batch      (@earendil-works/pi-agent-core)
  → shell tool executes `mcp call …` per call   (one subprocess each)
  → native MCP client (crates/pi-mcp-client)    (Unix socket bridge)
  → sandbox MCP daemon (src/mcp-daemon.ts)      (one connection per call)
  → shared mcporter runtime (callTool)          (one pooled MCP connection)
  → MCP server
```

## Findings

### 1. Pi's agent loop dispatches concurrent tool calls in parallel by default

`pi-agent-core`'s `executeToolCalls` (`dist/agent-loop.js`) picks between two
strategies for the tool calls in a single assistant message:

- `config.toolExecution` — defaults to **`"parallel"`** (`agent.js`:
  `this.toolExecution = options.toolExecution ?? "parallel"`).
- Per-tool `executionMode` — if **any** tool in the batch declares
  `executionMode: "sequential"`, the whole batch runs sequentially.

In parallel mode, tool calls are *prepared* sequentially (argument validation +
the `beforeToolCall` extension hook), then their *executions* run concurrently
via `Promise.all`, preserving original result order.

Neither `runtime-agent` nor any recipe sets `toolExecution: "sequential"` or
registers a tool with `executionMode: "sequential"`, and no extension registers
a blocking `tool_call` hook. So the default (parallel) is what runs in
production.

**Evidence** — driving the real `pi-agent-core` `Agent` loop with a scripted
model emitting N tool calls in one message, each tool sleeping 120 ms:

| Scenario | Tools | Execution span | Overlap |
| --- | --- | --- | --- |
| Default (`parallel`) | 2 | ~121 ms | **YES** |
| Default (`parallel`) | 6 | ~121 ms | **YES** (not 720 ms) |
| `toolExecution: "sequential"` | 2 | ~242 ms | NO |
| One tool `executionMode: "sequential"` | 2 | ~242 ms | NO |

Six independent calls finish in the time of one — Pi is not the bottleneck.

### 2. The daemon → mcporter → MCP server path is concurrent end to end

- The daemon (`src/mcp-daemon.ts`) handles each socket connection independently;
  `execute()` is async with no cross-request lock. Concurrent `mcp call`s land
  on concurrent connections.
- `mcp call` resolves to `callWithSharedRuntime` → `runtime.callTool` directly
  (no pre-call `tools/list`/schema fetch), sharing one mcporter runtime.
- mcporter serializes only **connection setup** (a mutex so N cold calls spawn
  one server process, not N), then issues concurrent JSON-RPC requests over the
  one pooled connection. MCP allows many in-flight requests per connection.

**Evidence** — real daemon + a stub MCP server whose `tools/call` sleeps 300 ms
and records peak in-flight count, driven through the actual `mcp` shim (native
client when built):

| Scenario | Wall-clock | Server-side overlap |
| --- | --- | --- |
| 6 parallel — cold (first batch) | ~373 ms | **YES** (one-time ~70 ms setup shared) |
| 6 parallel — warm | ~307 ms | **YES** (peak in-flight = 6) |
| 2 parallel | ~305 ms | **YES** |
| 1 failure among successes | ~305 ms | **YES**, failure isolated (exit 1 on that call only) |
| Cancel one mid-batch | cancelled aborts ~150 ms, survivor completes | independent cancellation works |

Warm 6-parallel ≈ single-call latency; cold adds a one-time shared setup cost,
never a 6× amplification.

## What actually caused the observed 2–4 s

With both layers concurrent, the latency was not a dispatch serialization bug:

1. **Client startup overhead (fixed in #78).** Before #78 each call paid ~106 ms
   Node-client startup; six concurrent heavy spawns contend and inflate
   wall-clock. #78 cut per-call startup 106 ms → 1.74 ms. This is the dominant
   fix and is already merged.
2. **Cold connection setup.** First use of an MCP server pays a one-time
   connect + `initialize` handshake (~tens of ms) shared across a concurrent
   batch. Warm reuse removes it.
3. **Model turn structure.** If the model emits one tool call per assistant
   message (rather than a batch), the calls serialize by construction — a full
   model round-trip between each. This is not a Pi/pi-recipes serialization; the
   `mcp run` path (`Promise.all` inside one daemon worker) and its prompt
   guidance exist precisely so a model can batch dependent/parallel work in a
   single shell call.

## Decision

- **No `call_batch` protocol.** Concurrent client requests already provide
  parallelism with original ordering, per-call stdout/stderr, partial failures,
  and independent cancellation. The brief's bar for adding `call_batch` ("only
  if concurrent client requests cannot provide the required behavior") is not
  met.
- **No change to Pi dispatch.** Pi already runs concurrently-emitted tool calls
  in parallel; forcing anything else would regress the contract.

## Regression guard

`test/mcp.test.ts` → `describe("MCP daemon concurrent dispatch")` drives the
real shim → daemon → mcporter → MCP server path and asserts the invariant:

- six parallel `mcp call`s reach the server with **peak in-flight = 6** over a
  **single** connection, and total wall-clock stays under `3×` a single call;
- a failing call surfaces its error (exit 1) on that call only while concurrent
  successes are unaffected (peak in-flight = 3).

These fail if anyone reintroduces a lock, flips the shell tool to
`executionMode: "sequential"`, or otherwise serializes the path.

## Reproducing

```bash
pnpm build:ts
cargo build -p pi-mcp-client && MCP_CLIENT_BIN=target/debug/mcp-client node scripts/package-mcp-client.mjs  # exercise the native client
npx vitest run test/mcp.test.ts -t "MCP daemon concurrent dispatch"
```
