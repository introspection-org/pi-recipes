# Introspection platform extensions

[Introspection](https://introspection.dev) is a **Pi managed agent platform**: it
runs recipes authored in the standard Pi recipe format (see
[`pi-extension.md`](./pi-extension.md)) as deployed, observable agent runtimes,
and adds a small set of **platform-specific capabilities** on top of the core
format.

This page defines those extensions. They are **not part of the core Pi recipe
spec** and have no effect in a standalone Pi runtime — they only mean something
when a recipe is deployed on Introspection. The Pi recipe loader parses and merges
them everywhere so recipes still **validate** off-platform; they simply do nothing
there. Each is detailed in its own section below.

"You declare it" = the recipe author writes it into the recipe files
(`agent.yaml` / the `.introspection` manifest). "Platform provides" = supplied
automatically at deploy/run time without being written in the recipe.

| Extension | You declare it in the recipe | Platform provides |
| --- | --- | --- |
| **Connectors** (`connectors:` on an agent) | **yes** — reference + scope connectors in `agent.yaml` | the connector token broker + per-action human approval |
| **Policies** (`policies/*.cedar`) | **yes** — Cedar policy files at the recipe root | deterministic evaluation on every connector token request |
| **Runtime** (the `.introspection` manifest) | **yes** — `name` / `path` / `runtime.llm_mode` / optional `runtime.resources` | the deployment + versioning, managed LLM access, telemetry, the sized sandbox |

Core Pi fields (`model`, `tools`, `skills`, `subagents`, `system_instructions`)
and the MCP-standard `mcp` block are documented in
[`pi-extension.md`](./pi-extension.md) and are **not** Introspection-specific.

---

## Connectors

Connectors let an agent act on an outbound provider (Gmail, a booking API, a
payments API) **on a customer's behalf**. They are the connector analogue of the
`mcp` block, with one key difference: the connector **definition** — endpoints,
credentials, and approval policy — is configured in your Introspection
organization, never in the recipe. The recipe only **references** connectors by
slug and **scopes** what the agent may do with them (the same split as an MCP
server, which is registered in the org and merely referenced here).

Each agent declares its connector access in a `connectors` block, **keyed by the
connector's slug** — the stable identifier of a connector configured in your
Introspection org (here `booking` and `gmail`). A key that doesn't match a
configured connector grants no access.

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
  must be ⊆ the connector's scopes; the platform enforces the intersection.
  Omitting `scopes` requests none.
- **`approval_policy`** *(optional)* — `human`, `judge_advises_human`, or
  `judge_auto_within_envelope`. A **tighten-only** override: an agent may demand
  *stronger* approval than the connector default but can never loosen it. The
  connector's configured policy is the hard ceiling; most agents omit it.

Selectors merge along the `from:` inheritance chain per connector, the same way
`mcp` selectors do. Omitting a connector gives the agent no access to it;
omitting the entire `connectors` block gives it no connector access.

The concrete per-action approval (recipient, amount ceiling, window) that a human
grants is **not** declared here — it happens at run time when the agent requests a
token, because it is specific to each action. The recipe stops at *which
connectors, on whose behalf, which scopes*.

> The runtime loader accepts and merges this block; requesting a token at run time
> is a separate runtime capability. Until it is available, an agent that declares
> connectors should describe the intended action and the approval it needs rather
> than assume a live token.

---

## Policies

`policies/*.cedar` are [Cedar](https://www.cedarpolicy.com/) policy files at the
recipe root — deterministic guardrails the platform evaluates on **every
connector token request**, versioned with the agent's code. Where the per-action
human approval is semantic (and may be advised by a model), policies are the
hard rail around it: written ahead of time, evaluated deterministically, immune
to prompt injection.

If the directory exists, connector use is **default-deny**: only what a policy
explicitly permits can mint a token. Policies can only *narrow* what the
org-side connector definition allows, never widen it, and a changed policy takes
effect only when the new commit is deployed.

```cedar
// policies/payments.cedar — cap any charge at $500, single-use,
// regardless of what was approved upstream.
permit (
  principal,
  action == Action::"connector:use",
  resource == Connector::"stripe"   // the connector's slug
)
when {
  context.mission.granted &&
  context.mission.subject == "person" &&
  context.mission has amount_cents && context.mission.amount_cents <= 50000 &&
  context.mission has single_use && context.mission.single_use
};
```

The `context` the platform supplies is defined by a schema file
(`policies/schema.cedarschema`) shipped alongside the policies: the granted
mission envelope (`context.mission.*`) and the deployed recipe identity
(`context.recipe.slug` / `context.recipe.commit` — platform-bound, never
recipe-supplied). Validate locally or in CI with the Cedar CLI:

```bash
cat policies/*.cedar > /tmp/policyset.cedar
cedar validate --schema policies/schema.cedarschema --policies /tmp/policyset.cedar
```

An invalid policy set fails **closed** on the platform — it denies, never falls
open. `connector:use` is the first action family; the same shape is designed to
extend to other platform-mediated actions (e.g. tool invocation, egress) as they
gain enforcement points.

---

## Runtime

A recipe deployed on Introspection becomes a **runtime** (a deployable agent
unit; versions iterate as the recipe changes). The `.introspection/*.yaml`
manifest carries the platform binding:

```yaml
name: travel-agent
runtime_name: travel-agent
path: .
runtime:
  llm_mode: managed          # the platform provides + meters model access
  # resources: ...           # optional sandbox compute overrides — see Resources below
```

`name` / `path` / `runtime.llm_mode` are recipe-authored; the platform supplies
managed LLM access (`llm_mode: managed`), telemetry, and the deployment +
versioning lifecycle. `runtime.resources` is an optional block, covered below.

### Resources

`runtime.resources` declares **Kubernetes-style compute overrides** for the
sandbox the agent runs in. It is recipe-authored and validated by `recipe-check`
(the `resources` module), so the same rules apply in the CLI and any other host
that embeds the validator.

```yaml
runtime:
  resources:
    requests:              # guaranteed floor
      cpu: 500m            # millicores (500m) or decimal cores (0.5, 1, 2)
      memory: 1.5Gi        # Ki/Mi/Gi/Ti (binary) or k/M/G/T (decimal)
      storage: 10Gi        # optional scratch-volume size (request-only)
    limits:                # burst ceiling
      cpu: 1500m
      memory: 1.5Gi
```

Rules `recipe-check` enforces (shape, quantity grammar, internal consistency):

- Only `requests` and `limits` sections (unknown keys are flagged).
- `requests` accepts `cpu`, `memory`, and `storage`; `limits` accepts `cpu` and
  `memory` only — `storage` is **request-only** (a scratch-volume size, like a
  PVC), never a limit.
- `requests.cpu` may not exceed `limits.cpu`, and likewise for `memory`.
- CPU is millicores or decimal cores; memory and `storage` take binary
  (`Ki`/`Mi`/`Gi`/`Ti`) or decimal (`k`/`M`/`G`/`T`) suffixes.

`recipe-check` validates the *shape*; the platform applies its own limits and
metering when the recipe is deployed.
