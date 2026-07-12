# pi-recipe-check

Pure validation engine for [Pi recipe](https://pi.recipes) packages: the
`package.json#pi` manifest, agent YAML files (required fields, `from`
inheritance, name conflicts), MCP tool include/exclude policy, evals pinning,
and dependency lockfile rules.

## Design: I/O-free core

The core API takes an in-memory snapshot and never touches the filesystem, so
the same engine can be embedded natively (e.g. by `introspection-cli`), bound
to wasm or Python later, or driven by a host that already holds file contents
(a webhook, a git tree):

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

The default `fs` feature adds `check_recipe(dir, profile)`, a front-end that
walks a recipe directory into a snapshot (following file/directory symlinks
one level, never recursively), and the `cli` feature builds the `recipe-check`
binary that ships inside the `@introspection-ai/pi-recipes` npm package.
Build with `--no-default-features` to get only the pure core.

A standalone `resources` module validates Kubernetes-style compute
overrides (`requests`/`limits` with `cpu`/`memory` quantities such as `500m`
or `1.5Gi`) so hosts that carry a resources block — e.g. an Introspection
manifest's `runtime.resources` — share one quantity grammar and consistency
rule.

Diagnostics carry a stable `code`, a recipe-relative `path`, an optional
1-based `span` (line/column, populated for JSON/YAML parse errors), a
`message`, and an optional `help` string. Profiles (`local`, `ci`, `publish`)
escalate advisory checks — e.g. a missing dependency lockfile is a warning
locally and an error in `ci`/`publish`.

## License

Apache-2.0
