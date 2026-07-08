# Recipe Interactions

`@introspection-ai/pi-recipes/interactions` gives recipe tools one contract for
asking the user a question or requesting approval that works on every pi host:
the local TUI, RPC-driven UIs, headless runs, and hosts that stream tool
results to a remote frontend and can pause/resume a run.

The module registers no tools. Recipes own their interaction tools — their
names, schemas, prompts, and rendering — and call `elicit()` from the tool's
`execute()`. Removing every custom UI still leaves a working system; custom
UIs are pure enhancements.

## Quick start

```ts
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ELICIT_REASON_INPUT_REQUIRED,
  elicit,
} from "@introspection-ai/pi-recipes/interactions";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask user",
    description: "Ask the user a clarifying question and wait for the answer.",
    parameters: Type.Object({
      question: Type.String(),
      options: Type.Optional(Type.Array(Type.String())),
    }),
    // Required: interaction tools must not run concurrently with other tools,
    // otherwise a host pause can strand half-finished parallel tool calls.
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return await elicit(
        {
          reason: ELICIT_REASON_INPUT_REQUIRED,
          message: params.question,
          options: params.options,
          metadata: { kind: "question" },
        },
        { toolCallId, ctx, signal }
      );
    },
  });
}
```

`elicit()` always returns a finished tool result (`content` + `details`), so
the tool can return it directly. Pass the tool's own `signal` parameter — not
`ctx.signal` — so an aborted turn dismisses any open dialog.

## Channel resolution

`elicit()` picks the best available interaction channel, in order:

1. **`PI_ELICIT_AUTO_APPROVE`** (env) — headless/CI runs: confirmations
   resolve `approved`, everything else resolves `declined`. Deterministic and
   never blocks.
2. **Interactive UI** (`ctx.hasUI`, TUI and RPC modes) — the built-in dialog
   walk: a select for fixed options and approvals, a text input otherwise.
   A caller-provided `interactive` walk replaces the dialogs (return
   `undefined` to fall through). In RPC mode dialogs get a default timeout
   (`DEFAULT_RPC_DIALOG_TIMEOUT_MS`, 120s) so a client that never renders
   them cannot wedge the session; a timed-out or dismissed dialog declines.
3. **Interrupt-capable host** (`PI_INTERRUPT_RESUME` env, set by the host) —
   the tool returns `Awaiting user response.` with a `details.interrupt`
   descriptor. The host pauses the run, surfaces the descriptor to its own
   UI, and later resumes the run by rewriting this tool result with the
   response envelope (below). Suppressed inside in-process child agent runs,
   whose tool results the host does not observe.
4. **Fallback** — the result states that nothing was shown to the user and
   directs the model to ask in its normal assistant reply. An unrendered
   question is never treated as declined.

## The interrupt descriptor

`details.interrupt` is a **reserved key** on tool results: a host that
supports pause/resume treats any tool result carrying it as a pause request.
The descriptor is an exact subset of the AG-UI `InterruptSchema`
(`@ag-ui/core`):

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier, `<kind>:<toolCallId>` (`kind` from `metadata.kind`, else `reason`) |
| `reason` | Open string; well-known: `input_required`, `confirmation` |
| `message` | The human-readable prompt |
| `toolCallId` | The paused tool call |
| `responseSchema` | Flat single-object schema of the expected resume payload (MCP elicitation form subset: primitive properties, titled enums) |
| `expiresAt` | Optional ISO-8601 instant after which the host may auto-decline |
| `metadata` | Renderer hints (`kind`, `header`, `question`, `options`, …) |

Resume payloads are single-question: `{ answer }` for questions,
`{ approved, feedback? }` for confirmations. A decline is a resume with
status `cancelled` and **no payload**.

## Response envelopes (frozen)

The envelope is the tool-result text the model sees after the user responds.
It is a byte-exact wire contract: the local dialog walk and every
interrupt-capable host must synthesize identical text for the same outcome,
so recipes cannot tell where the answer came from. Do not reword these
without a coordinated protocol change across all hosts.

| Outcome | Envelope |
| --- | --- |
| Answered | `Answer: <answer>` |
| Approved | `Approved.` |
| Approved with feedback | `Approved. Feedback: <feedback>` |
| Revision requested | `Revision requested.` |
| Revision requested with feedback | `Revision requested. Feedback: <feedback>` |
| Declined | `User declined to answer. Proceed with your best judgment.` |
| Pending host resume | `Awaiting user response.` |

Declines are **not** tool errors — the model is expected to proceed with its
best judgment.

## Rules for interaction tools

- **`executionMode: "sequential"` is mandatory.** A host pause must never
  race concurrently executing tools.
- **Never format envelopes yourself.** Return `elicit()`'s result as-is;
  envelope authorship must not split across layers.
- **Thread the tool's `signal`** into `elicit()` and check for aborts after
  any custom dialog (`undefined` from a dialog means dismissal *or* abort —
  only the signal distinguishes them).
- **Custom UIs are enhancements.** A richer TUI walk goes through the
  `interactive` option; a richer web rendering keys off `metadata.kind`.
  Hosts that recognize neither must still work off `reason`,
  `message`, and `responseSchema`.
- **Child agents cannot elicit.** Inside an in-process child agent run the
  interrupt branch is suppressed and `elicit()` falls back to plain chat;
  the child's final response is where open questions belong.

## Host checklist (implementing `PI_INTERRUPT_RESUME`)

1. Watch root-session `tool_execution_end` events for `details.interrupt`.
2. Pause the run and persist the descriptor(s); the pause frame itself is
   not replayable — persisted descriptors are the source of truth.
3. On resume, rewrite the paused tool result's text with the frozen envelope
   for the user's response and continue the run. Declines (`cancelled`,
   no payload) use the declined envelope and are not errors.
4. Set `PI_INTERRUPT_RESUME=1` in the session environment only when all of
   the above is wired.
