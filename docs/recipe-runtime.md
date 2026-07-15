# Recipe Runtime Kernel

`pi-recipes` exposes one portable runtime boundary for local Pi, managed hosts,
and eval harnesses:

1. `compileRecipe({ recipeDir })` validates and resolves the package into a
   versioned `CompiledRecipeArtifact`.
2. `createRecipeHarness(...)` turns a selected compiled agent into a
   `RecipeAgentSessionPlan`.
3. A `RecipeHostAdapter` materializes that plan as a Pi `AgentSession`.

The recipe kernel owns package parsing, `from:` inheritance, model policy,
system instructions, resource selection, tool allowlists, MCP policy, and
subagent definitions. A host owns credentials, model transport, workspace and
sandbox lifecycle, persistence, identity, telemetry export, and presentation.

## Compiled artifact

```ts
import { compileRecipe } from "@introspection-ai/pi-recipes";

const artifact = compileRecipe({ recipeDir: "/path/to/recipe" });
console.log(artifact.version); // 1
console.log(artifact.digest);  // sha256:...
```

Managed hosts that bake recipe workspaces can use `compileRecipeToFile()` and
`readCompiledRecipeArtifact()`. Writes are atomic, and reads verify both the
format version and digest before returning the artifact.

The artifact contains:

- resolved, de-aliased agent definitions and their filename aliases;
- resolved model configuration and executable tool allowlists;
- package and per-agent MCP policies;
- relative resource paths and SHA-256 hashes for every selected file;
- the recipe system prompt and pinned eval suites;
- deterministic tool and normalized MCP-server collision diagnostics.

Absolute paths and compile timestamps are intentionally excluded, so identical
recipe trees compile to the same artifact and digest in different locations.
The artifact keeps file hashes rather than embedding source contents; hosts
materialize its relative paths against the recipe directory they admitted.

Artifacts are fail-closed. Invalid manifests, agent inheritance, required agent
fields, model policies, MCP policies, or eval pins prevent compilation.
`assertCompiledRecipeArtifact()` verifies the format version and digest before a
host accepts a cached or transported artifact.

## Host adapter

```ts
import {
  createRecipeHarness,
  type RecipeHostAdapter,
} from "@introspection-ai/pi-recipes";

const hostAdapter: RecipeHostAdapter = {
  async createSession(plan) {
    // Resolve plan.modelSpec through the host model proxy, attach host auth,
    // create the Pi session, apply plan.executableTools and prompt policy,
    // bind extensions, then return the ready session.
    return createManagedSession(plan);
  },
};

const harness = createRecipeHarness({
  recipeDir,
  workspaceDir,
  hostAdapter,
});

const runner = harness.createAgentRunner({ agentName: "researcher" });
const answer = await runner.prompt("Investigate the failure");
await runner.shutdown();
```

The built-in adapter preserves the existing local Pi child-agent behavior. A
managed runtime supplies an adapter instead of reimplementing recipe parsing or
agent resolution. `harness.plan(agentName)` is also available for admission,
policy checks, eval provenance, and adapter conformance tests without starting
a session.

The artifact format is versioned independently from the npm package. Hosts must
reject unsupported versions rather than guessing how to interpret them.
