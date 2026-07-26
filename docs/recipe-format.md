# Recipe Format

**Status:** Open format, version 1  
**Reference implementation:** `@introspection-ai/recipes`  
**Validator:** `pi-recipe-check`

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

A Recipe MUST be a directory containing `package.json`. The manifest MUST have:

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

`name` is the package identity. `version` is distribution metadata and defaults
to `0.0.0` when omitted for compatibility. `description` is human-facing.

Resource paths:

- MUST be relative to the package root;
- MUST NOT traverse outside the package;
- MAY be files, directories, or supported glob patterns;
- are resolved deterministically in lexical order.

Unknown top-level `package.json` fields retain normal npm semantics. Unknown
Recipe fields inside supported `pi` structures are validation errors unless a
later format version explicitly defines them.

## Agents

`pi.agents` declares YAML agent definitions. A resolved Recipe MUST contain at
least one agent.

```yaml
name: agent
description: Produce a sourced research brief.
model:
  name: openrouter/anthropic/claude-sonnet-4.5
  thinking_level: high
tools: [read, bash]
skills: [research]
subagents: [reviewer]
extensions:
  include: [citations]
system_instructions:
  mode: append
  content: Verify every material claim.
```

An agent MAY inherit from another named agent with `from`. Inheritance MUST be
acyclic. Child fields override inherited scalar fields; documented collection
fields use the merge or replacement behavior in
[Agent composition](agent-composition.md).

Every fully resolved agent MUST define:

- `model.name` as `<provider>/<model_id>`;
- `model.thinking_level`;
- `tools`;
- `system_instructions`.

Omitted `skills` and `subagents` resolve to empty lists.

The default agent is named `agent`. If no `agent` exists, a host MAY select the
only declared agent. When multiple agents exist without `agent`, the caller
MUST select one explicitly.

## Instructions, skills, prompts, and extensions

`SYSTEM.md`, when present, is package-wide instruction source. Agent
`system_instructions.mode` determines whether agent instructions append to or
replace the current prompt.

Skills follow the [Agent Skills](https://agentskills.io) directory convention
and are selected from the resources declared by `pi.skills`.

Prompt templates are declared by `pi.prompts`.

Recipe-owned Pi extensions are declared by `pi.extensions`. An agent MAY select
declared extensions with `extensions.include` and `extensions.exclude`. A host
MUST NOT load undeclared Recipe extension source.

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

## Quality and resource intent

Recipe-owned judge YAML expresses portable quality definitions. Hosts MAY use
those definitions online or offline, but MUST preserve their authored identity
and semantics.

`pi.evals` MAY pin external evaluation suites. The format records the pin; an
evaluation runner remains an external tool.

Portable resource intent is declared under the documented runtime resource
grammar. A host decides whether it can satisfy that intent and MUST report
unsupported required resources rather than silently weakening them.

## Host responsibilities

The Recipe Format owns:

- package and agent interpretation;
- instruction composition;
- model and tool selection;
- skill, prompt, and extension selection;
- subagent visibility;
- capability policy;
- quality definitions and resource intent.

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

## Conformance

There are two conformance layers:

1. `pi-recipe-check` validates authored package snapshots without executing
   them.
2. `@introspection-ai/recipes/test-utils` verifies that a host constructs and
   disposes Recipe sessions with the required semantics.

A host SHOULD run both layers in CI.

## Evolution

The format follows additive evolution while version 1 is active:

- new optional fields MAY be added;
- existing field meaning MUST NOT change incompatibly;
- required fields MUST NOT be added without a new major format version;
- hosts MUST ignore only extension points explicitly documented as open.

The implementation package follows SemVer independently. Package version and
format version are not the same thing.
