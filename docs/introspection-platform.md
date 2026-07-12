# Introspection platform extensions

[Introspection](https://introspection.dev) is a **Pi managed agent platform**: it
runs recipes authored in the standard Pi recipe format (see
[`pi-extension.md`](./pi-extension.md)) as deployed, observable agent runtimes,
and adds a small set of **platform-specific capabilities** on top of the core
format.

This page defines those extensions. They are **not part of the core Pi recipe
spec** and have no effect in a standalone Pi runtime — they only mean something
when a recipe is deployed on Introspection, which supplies the surrounding
services (identity, a connector broker, a Person Server, resource mounting,
telemetry). The Pi recipe loader parses and merges them everywhere so recipes
still **validate** off-platform; they simply do nothing there.

| Extension | Authored in the recipe? | Provided by the platform |
| --- | --- | --- |
| **Connectors** (`connectors:` on an agent) | yes — references + scopes | connector registry, `getToken` broker, Person Server, missions |
| **Managed resources** (repos / files / memories / skills / mounts) | no — injected at run time | the task/deployment context |
| **Managed runtime** (deployment, LLM mode, telemetry) | partly (`runtime.llm_mode`) | the deployment + observability plane |

Core Pi fields (`model`, `tools`, `skills`, `subagents`, `system_instructions`)
and the MCP-standard `mcp` block are documented in
[`pi-extension.md`](./pi-extension.md) and are **not** Introspection-specific.

---

## Connectors

Connectors let an agent act on an outbound provider (Gmail, a booking API, a
payments API) **on a customer's behalf**. They are the connector analogue of the
`mcp` block, with one key difference: the connector **definition** — endpoints,
client credentials, Person Server, and approval policy — lives **org-side in the
Introspection Control Plane**, never in the recipe. The recipe only **references**
connectors by slug and **scopes** what the agent may do with them (the same split
as an MCP server, which is registered in the org and merely referenced here).

Each agent declares its connector access in a `connectors` block, keyed by the
connector's org-side slug:

```yaml
# agents/agent.yaml
tools:
  - bash
connectors:
  booking:
    subject: person             # on whose authority the token is minted
    scopes:                     # subset of the connector's scopes
      - booking.reserve
  gmail:
    subject: person
    scopes:
      - gmail.send
    approval_policy: human      # optional, tighten-only (see below)
```

Selector fields:

- **`subject`** — whose authority the minted token carries: `app` (the org's own
  connection), `user`, or `person` (a customer the agent acts on behalf of). The
  platform binds the concrete identity; the recipe only names the *kind*.
- **`scopes`** — the subset of the connector's scopes this agent may request. It
  must be ⊆ the connector's org-side scopes; the platform enforces the
  intersection. Omitting `scopes` requests none.
- **`approval_policy`** *(optional)* — `human`, `judge_advises_human`, or
  `judge_auto_within_envelope`. A **tighten-only** override: an agent may demand
  *stronger* approval than the connector default (e.g. force `human` where the
  connector allows judge-auto) but can never loosen it. The org-side
  `connectors.approval_policy` is the hard ceiling; most agents omit it.

Selectors merge along the `from:` inheritance chain per connector, the same way
`mcp` selectors do. Omitting a connector gives the agent no access to it;
omitting the entire `connectors` block gives it no connector access.

The **mission** — the concrete per-action envelope (recipient, amount ceiling,
window) that a human approves — is *not* declared here. It is authored at run
time when the agent requests a token, because its values are specific to each
action. The recipe stops at *which connectors, on whose behalf, which scopes*.

> The runtime loader accepts and merges this block; end-to-end token minting is
> the separate `getToken` rail. Until that lands, an agent that declares
> connectors should describe the intended action and the approval it needs rather
> than assume a live token.

Canonical design: `introspection-cloud/docs/design/connectors-aauth-b2b2c.md`
(§4 data model, §18 the recipe block).

---

## Managed resources

When a recipe runs on Introspection, the platform mounts a set of **managed
resources** into the sandbox from the task/deployment context — the runtime
reports them at launch, e.g. `resources repos=1 files=0 memories=0 skills=0
files_mounts=1`:

- **repos** — git repositories linked to the project (the recipe repo, plus any
  additional linked repos), materialized read-only or checked out.
- **files** — Data-Plane files attached to the task.
- **memories** — the agent's persisted memories.
- **skills** — platform-provided skills (in addition to the recipe's own `skills`
  folder discovered via Pi `resources_discover`).
- **file mounts** — additional mounted paths.

These are **injected by the platform, not declared in `agent.yaml`** — the recipe
does not author them. The distinction from Pi's own `resources_discover` (the
`## Resources` section in [`pi-extension.md`](./pi-extension.md)) is that those
are recipe-local skill/prompt folders, whereas managed resources come from the
deployment. See `introspection-cloud/docs/design/task-spawn-contract.md` and
`sandbox-sessions.md` for how they are assembled.

---

## Managed runtime

A recipe deployed on Introspection becomes a **runtime** (a deployable agent
unit; multiple runtime rows share a runtime group as versions iterate). The
recipe's `.introspection/*.yaml` manifest carries the platform binding, e.g.:

```yaml
name: travel-agent
runtime_name: travel-agent
path: .
runtime:
  llm_mode: managed        # the platform provides + meters model access
```

The platform supplies managed LLM access (`llm_mode: managed`), OpenTelemetry
export, and the deployment lifecycle. These are deployment concerns rather than
recipe-format keys; the canonical references are the Introspection Control Plane
design docs (`layered-architecture.md`, `task-spawn-contract.md`).
