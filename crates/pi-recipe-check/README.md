# pi-recipe-check

Pure validation library for [Recipe](https://pi.recipes) packages: the
`package.json#pi` manifest, agent YAML files (required fields, `from`
inheritance, name conflicts), direct-child judge YAML definitions, MCP tool
include/exclude policy, and dependency lockfile rules.

## I/O-free API

The core API takes an in-memory snapshot and never touches the filesystem, so
`introspection check` can validate the files it already discovered:

```rust
use pi_recipe_check::{check_recipe_files, CheckProfile, RecipeFile, RecipeFiles};

let input = RecipeFiles {
    files: vec![
        RecipeFile::new("package.json", r#"{ "name": "demo", "pi": { "agents": ["agents/*.yaml"] } }"#),
        RecipeFile::new("agents/agent.yaml", "name: agent\n..."),
    ],
    directories: Vec::new(), // ancestors of file paths are implied
};
let report = check_recipe_files(&input, CheckProfile::Ci);
assert!(!report.valid);
```

This crate is shared by the Introspection CLI and the Recipes extension. Its
core remains I/O-free. The crate's `recipe-check` binary is a private
snapshot-in/snapshot-out bridge embedded in the npm package so `pi --recipe`
can run the same validator at startup; it is not a user-facing Recipes CLI and
does not walk the filesystem.

The crate also exposes a standalone `resources` module for validating
Kubernetes-style compute overrides in host manifests. That utility is not part
of the Recipe Format; it is co-located here so hosts can share one pure
quantity grammar and consistency rule.

Diagnostics carry a stable `code`, a recipe-relative `path`, an optional
1-based `span` (line/column, populated for JSON/YAML parse errors), a
`message`, and an optional `help` string. Profiles (`local`, `ci`, `publish`)
escalate advisory checks — e.g. a missing dependency lockfile is a warning
locally and an error in `ci`/`publish`.

Judge sources are optional and discovered only at `judges/*.yaml` and
`judges/*.yml`; nested YAML is ignored. The library validates the portable
authored contract and returns `judge.*` diagnostics plus a
`resources.judges` count. It does not expose normalized registry projections
or project-scoped identity. See the
[Recipe judge specification](https://github.com/introspection-org/pi-recipes/blob/main/docs/recipe-judges.md)
for the complete schema and the boundary with judge execution.

## License

Apache-2.0
