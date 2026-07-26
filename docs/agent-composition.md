# Agent Composition

A recipe separates behavior into package-wide context and agent-specific
configuration. Use that separation to share one operating model across a team
of agents without making every agent identical.

## The Three Layers

| Layer | Scope | Use it for |
| --- | --- | --- |
| `package.json#pi` | Entire Recipe package | Declaring available agents, extensions, skills, prompts, and MCP servers |
| `SYSTEM.md` | Every root and delegated agent in the recipe | Shared mission, terminology, policies, and workflow rules |
| `agents/*.yaml` | One selected agent | Model, tools, selected skills, visible subagents, extension/MCP selection, and role-specific instructions |

`SYSTEM.md` is the shared recipe instruction layer. A root agent and every
delegated subagent start from the same recipe-level content. Put instructions
there when they should remain true regardless of which agent is selected.

Each agent's `system_instructions` specializes that shared layer:

```yaml
system_instructions:
  mode: append
  content: |
    Review the evidence and return a release recommendation.
```

- `append` adds the agent-specific content after the shared recipe prompt.
- `replace` intentionally replaces the current prompt, including `SYSTEM.md`.

When a Recipe has no `SYSTEM.md`, Pi's normal base prompt is the starting
prompt. When `SYSTEM.md` exists, it becomes the recipe-wide starting prompt.
Recipes then applies the selected agent's `system_instructions` mode.

## Derive Agents With `from:`

Use `from:` to derive a named agent from another agent in the same recipe. This
is useful for model variants, constrained roles, and subagents that share most
of a base configuration.

```yaml
# agents/agent.yaml
name: agent
description: Main release coordinator
model:
  name: anthropic/claude-sonnet-4-6
  thinking_level: medium
tools: [read, bash]
skills: [release-policy]
subagents: [reviewer]
extensions:
  include: [release-tools]
system_instructions:
  mode: append
  content: Coordinate the complete release decision.
```

```yaml
# agents/reviewer.yaml
name: reviewer
from: agent
model:
  thinking_level: high
tools: [read]
subagents: []
system_instructions:
  mode: append
  content: Independently review the evidence. Do not make changes.
```

The derived agent inherits the base model name and selected skill, overrides
the thinking level and tool allowlist, clears its visible subagents, and uses
its own specialized instructions. Both agents still receive `SYSTEM.md`.

`from:` chains may contain multiple levels. The referenced name must resolve to
another agent in the same recipe. Missing bases and cycles are validation
errors. A filename stem can resolve as an alias for an explicitly named agent,
but explicit stable `name` values are recommended and required for portable
child-agent definitions.

Inheritance and delegation are separate. `from: reviewer-base` inherits a
definition; it does not expose the derived agent for delegation. A root agent
must still name that agent in its `subagents` list.

## Inheritance Rules

Omission means "inherit" for a derived agent. Declaring a field means
"override or merge" according to its type.

| Field | Derived-agent behavior |
| --- | --- |
| `description` | Child value replaces the base; omission inherits it |
| `model` | Merges by key; nested stream/provider sections also merge by key |
| `tools` | Child array replaces the inherited allowlist; `[]` clears it |
| `skills` | Child array replaces the inherited selection; `[]` clears it |
| `subagents` | Child array replaces inherited visibility; `[]` clears it |
| `extensions` | `include` and `exclude` inherit independently; a declared child list replaces that list |
| `mcp` | Servers merge by id; each server's `include` and `exclude` inherit independently and a declared child list replaces that list |
| `system_instructions` | The whole child block replaces the inherited block; omission inherits it |

Agent instruction blocks are not concatenated along a `from:` chain. If a
child declares `system_instructions`, its block replaces the base agent's block.
The child's `mode: append` applies to the recipe-wide `SYSTEM.md` (or Pi base
prompt), not to the base agent's instructions. Put truly shared instructions in
`SYSTEM.md` or a shared skill.

Arrays never merge item by item. This makes capability boundaries reviewable:
a derived agent that declares `tools: [read]` receives only `read`, not the
base agent's other tools.

## Model Configuration

Beyond `name` and `thinking_level`, the `model` block accepts request and
transport tuning and provider routing. Set only what a case needs.

```yaml
model:
  name: anthropic/claude-sonnet-4-6
  thinking_level: medium        # or reasoning_effort (an alias; a conflicting value errors)
  temperature: 0.2
  max_tokens: 4096
  cache_retention: short        # none | short | long
  timeout_ms: 60000
  max_retries: 2
  max_retry_delay_ms: 8000
  providers:
    anthropic:
      betas: [context-1m]
      context_management: {}
    openrouter:
      routing:                  # allow_fallbacks, require_parameters, data_collection,
        order: [anthropic]      # zdr, order, only, ignore, quantizations, sort, max_price,
        sort: throughput        # preferred_min_throughput, preferred_max_latency, …
```

All keys are optional and merge by key along a `from:` chain. Use `reasoning_effort`
or `thinking_level`, not both with different values.

## Instruction Shorthand

A top-level `prompt:` string on an agent is shorthand for append-mode
`system_instructions` — the text is appended to `SYSTEM.md` for that agent. Use
the explicit `system_instructions` block when you need `mode: replace`.

## Resources and Capabilities

The manifest declares what the package can provide; the selected agent narrows
what is active:

- `package.json#pi.skills` declares physical skill resources. `agent.skills`
  selects the skill names Pi discovers for that agent.
- `package.json#pi.extensions` declares recipe-owned extensions.
  `agent.extensions` filters which declared extensions load.
- `package.json#pi.mcp` defines the package's upper-bound MCP policy.
  `agent.mcp` narrows tool access per server.
- `agent.tools` is the exact allowlist for Pi built-ins and tools registered by
  loaded recipe extensions.
- `agent.subagents` controls which other recipe agents are visible through the
  `agent` tool.
- Prompt templates declared by the package are recipe resources; they are not
  specialized through `from:`.

Skill and subagent selection controls prompt exposure and active capability,
not filesystem isolation. All agents run in the same Recipe package and current
workspace. Use sandboxing and external authorization for security boundaries.

## Root Agents and Subagents

An agent selected with `--agent` is a root agent. If its effective `subagents`
list is non-empty, Recipes enables the `agent` tool and exposes only those
named agents.

A delegated subagent resolves its own complete effective definition:

1. follow its `from:` chain;
2. apply its model, tools, skills, extensions, MCP, and instruction overrides;
3. start from the same recipe `SYSTEM.md` as the root agent; and
4. append or replace with its effective `system_instructions`.

Delegation is one level deep. A definition may expose subagents when selected
directly as a root agent, but the same definition does not receive the `agent`
tool while running as a delegated child.

## Recommended Structure

- Put shared identity, policies, terminology, and workflow invariants in
  `SYSTEM.md`.
- Put role-specific duties and response contracts in the relevant agent's
  `system_instructions`.
- Put reusable detailed judgment in skills and select only the skills each
  agent needs.
- Use `from:` for real variants, not merely to avoid a few repeated lines.
- Declare narrow tool, extension, MCP, and subagent lists at the point where a
  role's capability boundary changes.
- Run `introspection check` after changing inheritance, then prove each important
  root agent and delegated path in a fresh Pi session.
