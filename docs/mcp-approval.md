# MCP Tool Approval (`always_ask` at the daemon)

**Status:** Implemented — Phase 0 (config + daemon enforcement) and Phase 1
(marker + file-grant, local `ctx.ui` host, remote AG-UI interrupt host). The
remote interrupt→resume→grant flow is wired against Pi's tool-result/interrupt
contract; end-to-end verification on a live cloud stack is the remaining check.

## Summary

The one human-in-the-loop primitive worth the platform owning is **`ask`** — pausing
a tool call for the user's approval. It belongs in exactly one place: **per MCP
tool, enforced at the MCP daemon**, because that is the structured, un-routable
choke point where a side-effecting call actually happens. Everything else
(allowing/denying tools, approving tools a recipe owns, gating built-in `bash`)
is either the recipe author's job or a job the author can already do, and the
platform should not reimplement it.

This proposal keeps the surface to one config knob and one mechanism, and is
honest about what `ask` is (a guardrail for a cooperative agent) versus what it
is not (a wall against an adversarial one).

## Principle: three separate concerns, three owners

| Concern | Owner | Mechanism |
| --- | --- | --- |
| **Availability** — may the agent call this tool at all? | recipe author | tool **inclusion** (`tools` / `mcp` selection). Not selected = not callable. |
| **Approval** — pause a callable tool for the user? | platform, *only where the author can't self-implement* | per-tool `always_ask` at the MCP daemon (this doc) |
| **The HITL delivery mechanism** | platform (already exists) | `askUserApproval` + the runtime's interrupt / resume |

`ask` is only owned by the platform for **MCP tools**. For a tool a recipe
*owns*, the author calls `askUserApproval()` inside the tool. For built-in
un-owned tools (`bash`, `write`), the control is inclusion plus sandbox egress —
**not** a policy gate (see Non-goals).

## Non-goals

- **No general tool-level policy gate.** Gating arbitrary `bash` by policy is a
  leaky soft-control: the argument surface is unbounded, the agent can obfuscate
  or route the same effect through another tool, and "skip mcp calls" heuristics
  invite bypasses. Availability is expressed by inclusion, not a per-call verb.
- **Built-in `bash`/`write` are not gated here.** If the agent shouldn't have
  raw shell, don't include it; if it has it, egress + filesystem scope are the
  boundary.
- **`ask` is not a security boundary.** An agent with raw `bash` + network
  bypasses MCP entirely (curl the endpoint, install its own client). `ask` is a
  guardrail against *mistakes* by a cooperative agent, layered on top of the real
  boundary (inclusion + egress).

## Config surface

Approval policy is declared per MCP server, with an optional per-tool override.
Vocabulary mirrors Claude Managed Agents: **`always_allow`** (default) and
**`always_ask`**. The `always_` prefix is intentional — the policy re-confirms
on *every* call; there is no remembered "allow once" state.

Package upper bound (`package.json#pi.mcp.servers[]`):

```json
{
  "pi": {
    "mcp": {
      "servers": [
        {
          "id": "gmail",
          "policy": "always_allow",
          "toolPolicies": {
            "send_email": "always_ask",
            "trash_thread": "always_ask"
          }
        }
      ]
    }
  }
}
```

Agent selection may tighten (never loosen) it:

```yaml
mcp:
  gmail:
    include: ["*"]
    policy: always_ask        # this agent asks for everything on gmail
```

Semantics:

- **Default + override.** The effective policy for a tool is
  `toolPolicies[tool] ?? policy ?? "always_allow"`. `policy` sets the server-wide
  default; `toolPolicies` overrides per tool.
- **Tighten-only across layers.** Across the package bound, the `from:` agent
  chain, and the selecting agent, the **strictest** policy wins
  (`always_ask` dominates `always_allow`). An agent can raise a tool to
  `always_ask` but never lower a package `always_ask` to `always_allow`.
- **Validated at build time.** `recipes check` reports any value that is not
  `always_allow` / `always_ask` as `mcp.policy_invalid` / `agent.mcp_policy_invalid`.
  An unparseable value fails **closed** to `always_ask` at runtime — a typo never
  silently opens a gate.

## Enforcement: at the daemon, and why

MCP tools run through a detached process, not the Pi session:

```
pi host ──bash subprocess──▶ `mcp` CLI ──unix socket──▶ daemon ──Worker thread──▶ resolve policy + callTool
```

The gate runs in the daemon Worker, immediately before `runtime.callTool`, on the
**parsed** `(server, tool, args)`. That is the correct enforcement point:

- It is the true side-effect boundary — the actual call to the endpoint.
- It operates on a **structured, enumerable identity**, not an opaque `bash`
  string. The agent can obfuscate the shell (`m=mcp; $m call …`) but still has to
  go through the daemon to reach the tool, so the decision cannot be dodged.
- The agent cannot reach into the daemon to skip the check.

Gating the `mcp call` *bash string* at the host instead would reintroduce the
obfuscation surface we are avoiding, so the **decision** stays at the daemon.

## Reaching the user: the HITL back-channel

The daemon's only channel to the host is stdout / exit code. It has no `ctx`, no
access to the interrupt machinery. So today `always_ask` **fails open** (runs
without prompting) in both local and remote modes. Closing that is the real work,
and it splits cleanly: **decision at the daemon, delivery + plumbing at the host.**

1. **Await.** On `always_ask` with no grant and no in-process resolver, the
   daemon gate (running in the Worker) does not execute. It writes an
   *awaiting-approval marker* to stdout — `__PI_MCP_APPROVAL_REQUIRED__` + JSON
   `{server, tool, args, nonce}` — which streams to the host as the `mcp call`
   result. Implemented: `formatApprovalMarker` in `mcp-approval.ts`.
2. **Interrupt.** The host scans the `mcp call` result for the marker
   (`parseApprovalMarker`) and raises the **existing** interrupt — a local
   `ctx.ui` dialog, or a durable AG-UI interrupt in the cloud (reusing
   `askUserApproval`'s resume envelope, so local and remote are byte-identical).
   The host reacts only to the daemon's structured marker; it never parses the
   bash string to decide, so no obfuscation surface is added.
3. **Grant + re-invoke.** On approval the host drops a **single-use grant file**
   into the session-root grants dir (`writeApprovalGrant`) carrying the approved
   `(server, tool, args)`, and the model re-invokes the call. The gate finds the
   grant (`consumeApprovalGrant`, matched by `(server, tool)`), runs the
   **approved** args (not whatever the model re-sent), and deletes the file
   (single-use). A **file** is the channel because host and Worker share the
   sandbox filesystem, so it needs no daemon-protocol or thin-client (JS + native)
   change. (Pi executes a tool only when the model invokes it, so approval flows
   through a re-invoke; the grant keeps that re-invoke from re-prompting.)
4. **Deny.** The host rewrites the held result to "User declined to run
   `server.tool`. Proceed with your best judgment." — no grant, no execution.

The grant is **ephemeral** (approval → the immediately-following re-invoke, and
the host clears stale grant files on a fresh turn); the durable record is the
interrupt itself, persisted the same way every other interrupt is.

**Threat note (unchanged):** host and agent share one sandbox, so an adversarial
agent with raw `bash` could write a grant file itself — the same conceded
boundary (a raw-bash agent can bypass MCP entirely). The grant makes the
*cooperative* flow correct (the model emits tool calls but cannot drop grant
files); it is not a wall against an adversarial agent, for which the boundary
stays inclusion + egress.

## Threat model (stated, not implied)

- **Cooperative-but-fallible agent** (prevent mistakes / provide HITL UX): the
  daemon gate is exactly right, and un-bypassable for any MCP-routed call.
- **Adversarial agent** (prevent evasion): no approval gate suffices — raw `bash`
  + network leaves the MCP path entirely. The boundary there is **tool inclusion**
  (don't grant raw shell/network) plus **sandbox egress lockdown**. `ask` composes
  on top of those; it does not replace them.

## Phasing

- **Phase 0 — config, cheap.** `mcp.servers[].policy` + `.toolPolicies`
  (`always_allow` / `always_ask`), default + override + tighten, `recipes check`
  validation, enforced at the daemon. When no host resolver is wired, **fail open
  + log** — an honest interim that is already useful for `always_allow` and makes
  `always_ask` observable.
- **Phase 1 — the back-channel.** Awaiting-marker + host interrupt + out-of-band
  single-use grant, local `ctx.ui` first, then remote AG-UI. This is where the
  real risk is (process boundary, forgeable-grant hazard), so it ships as its own
  reviewed change.

## Considered and rejected

- **A general tool-level policy gate (`allow`/`ask`/`deny` for every tool).**
  Redundant with tool inclusion for availability, userland-replicable for owned
  tools, and a leaky string-matching control for un-owned `bash` (a compound
  command can smuggle a second command past it). Dropped.
- **Gating the `mcp call` bash string at the host.** Moves the decision off the
  structured surface and back onto an obfuscatable string. Dropped in favor of the
  daemon deciding and the host only plumbing.
- **Blocking-and-awaiting inside the gate.** The runtime aborts the turn to raise
  an interrupt, which would abandon a blocked awaiter — and here it would block a
  detached subprocess the host is waiting on. Approval must flow through
  interrupt → resume → re-invoke, not a synchronous await.
