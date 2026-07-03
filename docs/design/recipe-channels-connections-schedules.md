# Recipe manifest extensions: `channels/`, `connections/`, `schedules/`

**Status: proposal (pending design sign-off).** Companion to
`introspection-cloud/docs/design/channels-v2-agent-presence.md`, which owns the
platform side (channel bindings, ingress, activities, automations seeding).
This doc owns the **recipe package format**: three new resource classes in the
`pi` manifest block, closing the parity gap with Eve's `channels/`,
`connections/`, and `schedules/` directories.

Design constraint carried throughout: **recipes declare capabilities and
behavior defaults — never credentials, endpoints URLs, or platform tokens.**
Recipe files are data (YAML), not code. Anything credential-bearing resolves
platform-side at release/spawn time (integrations, endpoints, grants), and
anything fallible executes platform-side (Restate). This is the deliberate
divergence from Eve, where channel/connection files are TypeScript running in
the trusted app runtime; our recipe code runs in the *sandbox*, which must
never hold platform secrets.

## 1. Manifest block

Three new resource keys, same conventions as the existing ones (globs relative
to the package, path-confinement enforced, convention-folder fallbacks):

```json
{
  "pi": {
    "agents": ["agents/*.yaml"],
    "skills": ["skills/**/SKILL.md"],
    "extensions": ["extensions/*.ts"],
    "channels": ["channels/*.yaml"],
    "connections": ["connections/*.yaml"],
    "schedules": ["schedules/*.yaml"]
  }
}
```

- Convention fallbacks: `channels/`, `connections/`, `schedules/` directories
  are picked up when the key is omitted (mirroring `agents`/`skills`/`prompts`).
- `pi.mcp` becomes a **deprecated alias**: at parse time each
  `pi.mcp.servers[]` entry is normalized into a synthetic connection
  (`kind: mcp`, same id/required/tools.allow). Declaring both `pi.mcp` and a
  `connections/` entry with the same id is a validation error.
- Identity = filename stem, unique per class (`channels/slack.yaml` → channel
  declaration `slack`), consistent with agent alias rules.

## 2. `channels/*.yaml` — channel behavior declarations

One file per **channel kind** the recipe supports. The platform's channel
*binding* (workspace/channel → runtime group) decides *where* the agent is
present; the recipe channel file decides *how the recipe behaves* there.

```yaml
# channels/slack.yaml
kind: slack               # slack | linear | github | (future: teams, email, ...)
agent: agent              # entrypoint agent for threads on this kind (default: recipe default)
context:
  thread_messages: 50     # thread backfill window on first dispatch
  channel_messages: 20    # context for bare channel mentions
reply: auto               # auto | agent_driven
elicitation: true         # recipe renders/handles HITL choices
```

Schema (parsed into `RecipeChannelDefinition`):

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `kind` | enum | required | one file per kind; duplicate kinds = validation error |
| `agent` | string | recipe default entrypoint | must resolve in `agents/` (same check as spawn contract) |
| `context.thread_messages` | int 0–200 | 50 | platform clamps |
| `context.channel_messages` | int 0–100 | 20 | |
| `reply` | `auto` \| `agent_driven` | `auto` | `auto`: platform posts the final assistant message as the thread response; `agent_driven`: the recipe posts via the channel tool |
| `elicitation` | bool | true | advertise HITL support to the binding UI |

Precedence: **binding overrides recipe file overrides schema defaults** (admin
over author). A recipe with *no* channel file still works in a binding under
pure defaults (`reply: auto`) — zero channel-specific recipe code is a
supported configuration, and the primary DX goal.

## 3. `connections/*.yaml` — external service requirements

Generalizes `pi.mcp` server policy into a first-class, endpoint-resolved
resource:

```yaml
# connections/linear.yaml
kind: mcp                 # mcp | api (OpenAPI; phase 2)
description: Linear workspace — issues, projects, comments.
endpoint: linear          # endpoint slug resolved in the bound project at spawn
required: true            # missing endpoint => spawn contract violation
auth: app                 # app | user
tools:
  allow:
    - list_issues
    - create_comment
```

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `kind` | `mcp` \| `api` | `mcp` | `api` = OpenAPI-backed endpoint (tool synthesis platform-side) |
| `description` | string | required | the model-facing routing signal (Eve's rule: write it for the model) |
| `endpoint` | string | file stem | project endpoint slug; the recipe never contains URLs or headers |
| `required` | bool | false | required + unresolvable = task fails at spawn head, zero pods |
| `auth` | `app` \| `user` | `app` | `user` = per-subject grant; no grant triggers the platform OAuth elicitation flow |
| `tools.allow` / `tools.block` | string[] | allow-all | exactly one of the two (Eve rule; prefer allow) |

Agent opt-in stays as today: `mcp:<connection>/<tool>` entries in
`agents/*.yaml` `tools`, which remain policy refs stripped from executable
tools. Validation cross-checks that every `mcp:` ref names a declared
connection (or legacy `pi.mcp` server) and, when an allow-list exists, an
allowed tool.

## 4. `schedules/*.yaml` — declarative recurring work

```yaml
# schedules/daily-triage.yaml
cron: "0 9 * * 1-5"       # 5-field cron, UTC
agent: triage             # must resolve in agents/
prompt: |
  Review observations from the last 24 hours and open issues for new clusters.
deliver_to:               # optional proactive channel delivery
  channel: slack
  scope: "channel:C0123ABC"
enabled: true             # seed state; users can toggle platform-side
```

Markdown form also supported (Eve parity): `schedules/daily-triage.md` with
`cron:` (and optional `agent:`) frontmatter, body = prompt.

Execution semantics are **entirely platform-owned**: on release, the control
plane seeds one automation per schedule file for the runtime group (dedupe-keyed
so re-releases update rather than duplicate, and user edits — disable, cron
tweak — survive). Local `pi` runs ignore `schedules/` (there is no local cron;
`recipes doctor` validates the files, nothing fires). `deliver_to` requires the
recipe to also declare the matching `channels/<kind>.yaml` (validation warning
otherwise); without it, the schedule runs as a plain task.

## 5. Validation (`recipes doctor` + cloud validator)

New checks, added to both `validateRecipeDirectory` here and the cloud's
`validatePiPackageManifest` (they must stay in lockstep — the cloud validator
is a near-copy by design):

1. Resource paths confined to the package (existing rule, applied to the three
   new globs).
2. `channels/`: valid `kind` enum, one file per kind, `agent` resolves,
   numeric ranges.
3. `connections/`: `description` present; `tools.allow` xor `tools.block`;
   no id collision with legacy `pi.mcp`; every agent `mcp:` ref resolves to a
   declared connection + allowed tool.
4. `schedules/`: parseable 5-field cron; `agent` resolves; `deliver_to.channel`
   has a matching channel declaration (warn).
5. No credentials heuristic: reject keys named `token`, `secret`,
   `authorization`, `headers`, `url` in `connections/` files — the misuse we
   most expect from users porting Eve projects.

## 6. Out of scope

- `hooks/` as a declarative class — Pi extensions already subscribe to the
  session lifecycle; a second hook system is deferred until a concrete need.
- OpenAPI (`kind: api`) tool synthesis — phase 2, after the MCP path ships.
- Local execution of schedules or channel webhooks — platform-only by design.
