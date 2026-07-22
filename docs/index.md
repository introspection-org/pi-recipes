# Pi Recipes documentation

Pi Recipes is the open format and toolchain for portable agent systems built on
Pi. A recipe is an inspectable Git-backed package; Pi Recipes defines how to
compose it, validate it, resolve it, run it locally, and distribute it.

## Choose a path

| Goal | Start here |
| --- | --- |
| Create, install, customize, or publish | [Recipe flow](recipe-flow.md) |
| Use the `recipes` CLI | [Recipe CLI](recipe-cli.md) |
| Build agents with shared and specialized behavior | [Agent composition](agent-composition.md) |
| Declare and bind MCP capabilities | [MCP configuration](mcp-configuration.md) |
| Understand what the Pi extension loads | [Pi Recipes extension](pi-extension.md) |
| Package authored quality criteria | [Recipe judges](recipe-judges.md) |
| Pin an offline Harbor suite | [Recipe evals](recipe-evals.md) |

## Package anatomy

```text
my-recipe/
├── package.json          # package metadata and pi resource declarations
├── SYSTEM.md             # shared instructions for every selected agent
├── agents/*.yaml         # specialized profiles, inheritance, and capabilities
├── skills/**/SKILL.md    # reusable workflows and domain procedure
├── extensions/*.ts       # optional Pi extensions owned by the recipe
├── judges/*.yaml         # optional portable quality definitions
└── .pi/mcp.local.json    # optional local endpoint bindings; do not commit secrets
```

The package owns portable behavior and capability policy. The environment owns
credentials, endpoints, isolation, persistence, and execution lifecycle.

## Identity and distribution

- `name` is the package name and local recipe selector.
- `description` is human-facing package metadata.
- `version` is optional package/display metadata; missing versions resolve as
  `0.0.0` for compatibility.
- `license` is optional distribution metadata. Declare it when you intend to
  tell downstream users how they may reuse the package.
- A reproducible release is a Git source pinned to an immutable tag or commit.
  The public catalog records that source; it does not become the owner of the
  artifact.

## Portability boundary

Pi Recipes is sufficient to author, check, distribute, and run a recipe with
Pi. You can embed the resolver in your own host and deploy it on infrastructure
such as Fly.io, Vercel, or your own cluster without redefining package semantics.
For the first-party managed cloud—with isolated runtimes, production evidence,
and controlled improvement loops—see [Introspection documentation](https://docs.introspection.dev).
