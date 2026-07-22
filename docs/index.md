# Pi Recipes documentation

A **recipe** is a portable agent-system package. **Pi Recipes** is the open
format and toolchain for creating, validating, running, and distributing those
packages. **Introspection** is the first-party managed cloud for operating and
improving them.

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
| Ask for user input or approval across hosts | [Recipe interactions](interactions.md) |
| Declare portable runtime resource intent | [Deployment configuration](deployment-configuration.md) |

## Package anatomy

```text
my-recipe/
├── package.json          # package metadata and pi resource declarations
├── SYSTEM.md             # shared instructions for every selected agent
├── agents/*.yaml         # specialized profiles, inheritance, and capabilities
├── skills/**/SKILL.md    # reusable workflows and domain procedure
├── extensions/*.ts       # optional Pi extensions owned by the recipe
├── judges/*.yaml         # optional portable quality definitions
└── .pi/mcp.local.example.json # optional distributable binding template
```

The package owns portable behavior, capability policy, and any portable endpoint
or catalog declarations. The environment owns credentials and may override
endpoints; the host owns isolation, persistence, and execution lifecycle.

## Identity and distribution

- `name` is the package identity. Installed recipes can also resolve by source,
  normalized scoped identity, or an unambiguous short-name alias; local recipes
  can be launched by path.
- `description` is human-facing package metadata.
- `version` is optional package/display metadata; missing versions resolve as
  `0.0.0` for compatibility.
- `license` is optional distribution metadata. When a publishable recipe declares
  a license other than `UNLICENSED`, include the matching root license file (or
  use a valid `SEE LICENSE IN ...` reference).
- A reproducible release is a Git source pinned to a commit SHA, or to a tag
  protected by an immutable-release policy.
  The public catalog records that source; it does not become the owner of the
  artifact.

## Portability boundary

Pi Recipes is sufficient to author, check, distribute, and run a recipe with
Pi. You can embed the resolver in your own compatible Pi host and deploy that
host wherever its runtime requirements are supported, without redefining package
semantics. Pi Recipes does not provide provider-specific deployment adapters.
For the first-party managed cloud—with isolated runtimes, production evidence,
and controlled improvement loops—see [Introspection documentation](https://docs.introspection.dev).
For guided coding-agent workflows around this toolchain (create, migrate,
improve, deploy), install the
[Introspection plugin](https://github.com/introspection-org/introspection-plugin)
in Claude Code or Codex.
