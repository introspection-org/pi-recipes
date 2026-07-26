# Recipes documentation

**Recipes is the open package format for complete, portable Pi agents.**

A Recipe keeps the agent-owned layer together as inspectable source. Pi runs
the agent; a compatible host supplies credentials, isolation, persistence,
task lifecycle, protocols, and deployment.

## Start here

| Goal | Document |
| --- | --- |
| Understand the portable artifact contract | [Recipe Format](recipe-format.md) |
| Embed a Recipe in a host | [Runtime library](runtime-library.md) |
| Run a Recipe in Pi | [Pi extension](pi-extension.md) |
| Compose agents and subagents | [Agent composition](agent-composition.md) |
| Ask for user input across hosts | [Interactions](interactions.md) |
| Declare capability policy and bindings | [MCP configuration](mcp-configuration.md) |
| Declare portable resource intent | [Deployment configuration](deployment-configuration.md) |
| Package quality definitions | [Recipe judges](recipe-judges.md) |
| Declare offline evaluation suites | [Recipe evals](recipe-evals.md) |
| Move from the previous package | [Migration](migration.md) |

## Boundary

```text
Recipe source
    │
    ▼
resolveRecipe()          format interpretation
    │
    ▼
createRecipeSession()    complete live Pi agent
    │
    ├── runRecipe()      one-turn convenience
    │
    └── host             tasks, persistence, auth, protocols, deployment
```

Recipes stops at the live session boundary. It does not ship a generic server,
task store, scheduler, sandbox, or provider-specific deployment adapter.

The first-party hosts are:

- the Pi terminal harness through the Recipes extension;
- Introspection's managed `runtime-agent`.

Other hosts implement the same session contract and can run the host
conformance suite.
