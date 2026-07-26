# Recipes extension for Pi

The Recipes extension teaches [Pi](https://pi.dev/docs/latest) to load a
Recipe package with:

```bash
pi --recipe ./path/to/recipe --agent agent
```

Pi is the harness. The extension resolves the selected Recipe, configures its
model and tools, loads its skills and extensions, materializes its declared
capabilities, and registers its subagents. Every launch with `--recipe`
validates the authored package first.

## Installation

The recommended workflow lets the Introspection CLI provision compatible
versions:

```bash
npm install -g @introspection-ai/cli
introspection init
introspection local
```

For direct Pi use:

```bash
pi install npm:@introspection-ai/recipes
```

Recipes currently requires Node.js 24 or later and Pi `^0.82`.

## Selection

`--recipe` accepts a local directory:

```bash
pi --recipe . --agent agent
pi --recipe ./recipes/research --agent researcher
```

The extension no longer maintains a separate installed-Recipe store. Git,
package managers, and ordinary paths own distribution.

The selected path and agent are exposed to Recipe-owned tools as
`PI_RECIPE_DIR` and `PI_AGENT_NAME`.

## What is loaded

For the selected agent, the extension:

1. reads the root `package.json#pi` resource declarations;
2. resolves the agent YAML, including `from:` inheritance;
3. selects the model, thinking level, and tool allowlist;
4. loads selected skills, prompts, and Recipe-owned extensions;
5. materializes declared MCP bindings from host or local configuration;
6. exposes only the declared subagents through the shared `agent` tool.

See [Recipe Format](recipe-format.md) for the authored contract and
[Agent composition](agent-composition.md) for inheritance and selection.

## Local capability bindings

Recipe source may include `.pi/mcp.local.example.json`, but secrets belong in
the environment or an ignored `.pi/mcp.local.json`. A host may synthesize the
same bindings in memory.

Bindings are resolved fail-closed for required servers. Optional servers may
remain unavailable. See [MCP configuration](mcp-configuration.md).

## Recipe-owned extensions

TypeScript extension sources declared by `package.json#pi.extensions` are
loaded relative to the Recipe. Agent-level `extensions.include` and
`extensions.exclude` select which declared extensions participate.

Recipe extensions can import shared APIs from `@introspection-ai/recipes`.

## Validation

Every `pi --recipe` launch automatically runs the shared Recipe Format
validator with its local profile. Errors are rendered in Pi and stop the
session before any model call; warnings are rendered and launch continues.

For an explicit manual or CI check, run:

```bash
introspection check
```

Both paths use the same Rust validation core. The binary embedded in the npm
package is an internal bridge for Pi startup, not a second user-facing CLI.

## Host parity

The Pi extension and embedded hosts consume the same resolver and session
semantics. Hosts should run the conformance cases exported from
`@introspection-ai/recipes/test-utils`.
