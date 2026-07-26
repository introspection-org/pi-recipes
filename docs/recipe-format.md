# Recipe Format

**Status:** Open format, version 1  
**Reference implementation:** `@introspection-ai/recipes`  
**Validator:** `introspection check`

The Recipe Format is a Git-native package contract for complete Pi agents. It
defines the agent-owned inputs that a compatible host must interpret the same
way. It does not define deployment infrastructure or a network protocol.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## Compatibility scope

A conforming Recipe is **Pi-native and host-portable**:

- it MUST produce the same resolved agent configuration in compatible Pi hosts;
- it MUST NOT depend on an Introspection-managed runtime;
- it MAY declare host requirements that a particular host cannot satisfy;
- a host MUST fail closed when a required capability cannot be bound.

This format does not claim interoperability with non-Pi agent harnesses.

## Package root

A Recipe MUST be a directory containing `package.json`. At minimum, its
manifest contains a package name and a `pi` object:

```json
{
  "name": "acme-research",
  "pi": {}
}
```

A fuller package may declare distribution metadata and explicit resource
paths:

```json
{
  "name": "acme-research",
  "version": "1.0.0",
  "description": "Research an account and produce a sourced brief.",
  "pi": {
    "agents": ["agents/*.yaml"],
    "skills": ["skills/**/SKILL.md"],
    "extensions": ["extensions/*.ts"],
    "prompts": ["prompts/*.md"]
  }
}
```

`name` is the package identity. `version` is optional distribution metadata and
defaults to `0.0.0` when omitted. `description` is optional human-facing
metadata. When resource arrays are omitted, conventional `agents/`, `skills/`,
and `prompts/` directories are discovered when present. Executable extensions
and MCP servers are never discovered by convention and MUST be declared
explicitly.

Omission and an explicit empty array are different:

- an omitted `agents`, `skills`, or `prompts` key opts into its documented
  conventional directory;
- an explicit `[]` resolves no resources of that kind;
- every explicitly authored path or glob MUST match.

Resource paths:

- MUST be relative to the package root;
- MUST NOT resolve outside the package, including through symlinks;
- MAY be files, directories, or supported glob patterns;
- preserve declaration order, with matches inside each glob ordered
  lexically.

Unknown top-level `package.json` fields retain normal npm semantics. Unknown
Recipe fields inside supported `pi` structures are validation errors unless a
later format version explicitly defines them.

## Agents

`pi.agents` may declare YAML agent definitions explicitly. When omitted,
direct `.yaml` and `.yml` children of `agents/` are discovered. A resolved
Recipe MUST contain at least one agent.

```yaml
name: agent
description: Produce a sourced research brief.
model:
  name: openrouter/anthropic/claude-sonnet-4.5
  thinking_level: high
tools: [read, bash]
skills: [research]
subagents: [reviewer]
system_instructions:
  mode: append
  content: Verify every material claim.
```

An agent MAY inherit from another named agent with `from`. Inheritance MUST be
acyclic. Child fields override inherited scalar fields; documented collection
fields use the merge or replacement behavior in
[Agent composition](agent-composition.md).

Every agent YAML MUST declare a package-unique lowercase kebab-case `name`.
This is its
stable identity for selection, subagent references, artifacts, and telemetry;
the filename has no semantic meaning.

Every fully resolved agent MUST also define `model.name` as
`<provider>/<model_id>`. The model may be declared directly or inherited with
`from`.

All remaining agent fields are optional. Omitted `tools`, `skills`, and
`subagents` resolve to empty lists. Omitted `model.thinking_level` preserves the
provider or session default. Omitted agent instructions preserve `SYSTEM.md`
when present, or Pi's normal base prompt otherwise.

`tools` MUST NOT contain `agent`. The host materializes that session-generated
tool for a root session whose effective `subagents` list is non-empty.

The default agent is named `agent`. If no `agent` exists, a host MAY select the
only declared agent. When multiple agents exist without `agent`, the caller
MUST select one explicitly.

## Instructions, skills, prompts, and extensions

`SYSTEM.md`, when present, is package-wide instruction source. Agent
`system_instructions.mode` determines whether agent instructions append to or
replace the current prompt.

Skills follow the [Agent Skills](https://agentskills.io) directory convention
and are selected from the resources declared by `pi.skills`. A skill is named
by its `SKILL.md` frontmatter `name`, then by its containing directory; a
root-level unnamed `SKILL.md` uses the portable fallback name `skill`.

Prompt templates are declared by `pi.prompts`. They retain Pi's normal SDK and
TUI behavior: hosts expose them through `AgentSession.promptTemplates`, and a
caller invokes one by prompting with its slash command and arguments.

Recipe-owned Pi extensions are declared by `pi.extensions`. The deterministically
resolved set forms the package's executable trust boundary and loads for every
root and child session. Package membership means execution; agent YAML cannot
select or remove extensions.

An extension declaration may name a module or directory. A directory index
(`index.ts`, `index.tsx`, `index.js`, `index.jsx`, `index.mjs`, or `index.cjs`,
in that precedence order) owns the directory. Without an index, Recipes loads
its direct extension modules and the indexes of its immediate child
directories, both in lexical order. Discovery is intentionally shallow;
declare deeper modules explicitly.

Programmatic root and child sessions invoke the closure's factories for their
own Pi runtime. Interactive Pi keeps one extension runtime for the selected
Recipe launch and does not retry a partially failed closure without rebuilding
that runtime. Extension load failures stop the agent before a model call.
Recipe extensions MUST NOT override host or Pi built-in tool names; use a
distinct tool name when behavior differs. Extension code retains its non-tool
behavior even when none of its tools appear in the selected agent's `tools`
allowlist.

The package extension closure is complete with respect to Recipe source, not
the surrounding host process. A host MAY supply extensions, settings, or other
runtime policy. Interactive Pi may already have trusted global or project
resources loaded; compatible hosts MUST keep those additions distinguishable
from Recipe-owned inputs. `tools` limits model-callable tools, not extension
hook execution.

## Tools, subagents, and capabilities

`tools` is an allowlist. A host MUST expose no undeclared Pi or extension tool
through this field.

`subagents` names agents the selected agent may invoke. A host MUST expose only
those resolved definitions through the shared `agent` tool. How child work is
scheduled or isolated belongs to the host.

The `pi.mcp` package block declares capability servers and package-level tool
policy. Agent `mcp` blocks narrow those declarations. Credentials and concrete
endpoint bindings MUST NOT be required in distributable Recipe source. A host
MUST reject an unbound required server before the session begins.

See [MCP configuration](mcp-configuration.md) for the complete authored and
binding grammar.

## Host responsibilities

The Recipe Format owns:

- package and agent interpretation;
- instruction composition;
- model and tool selection;
- skill and prompt selection plus the package extension closure;
- subagent visibility;
- capability policy;

The host owns:

- credentials and secret resolution;
- workspaces and filesystem isolation;
- task and process lifecycle;
- persistence and recovery;
- scheduling and concurrency enforcement;
- network protocols and user authentication;
- telemetry export policy;
- deployment.

Those host concerns MUST NOT become mandatory Recipe source fields.

Recipe packages are trusted application code. In particular, authored
TypeScript extensions execute inside the Pi process with its authority. A host
that accepts third-party Recipes MUST review or isolate them before execution;
the format and Host API are not a sandbox boundary.

## Conformance

There are two conformance layers:

1. A Recipe checker validates authored Recipe source without executing it.
2. `@introspection-ai/recipes/test-utils` verifies that a host constructs and
   disposes Recipe sessions with the required semantics.

Pi also runs the same validator automatically whenever it launches with
`--recipe`. Other hosts SHOULD run both layers in CI.

## Evolution

The format follows additive evolution while version 1 is active:

- new optional fields MAY be added;
- existing field meaning MUST NOT change incompatibly;
- required fields MUST NOT be added without a new major format version;
- hosts MUST ignore only extension points explicitly documented as open.

The implementation package follows SemVer independently. Package version and
format version are not the same thing.
