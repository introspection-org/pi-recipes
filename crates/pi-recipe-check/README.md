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

Diagnostics carry a stable `code`, a recipe-relative `path`, an optional
1-based `span` (line/column, populated for JSON/YAML parse errors), a
`message`, and an optional `help` string. Profiles (`local`, `ci`, `publish`)
escalate advisory checks — e.g. a missing dependency lockfile is a warning
locally and an error in `ci`/`publish`.

## Why serde-saphyr and not serde_yaml

This crate previously parsed agent YAML with `serde_yaml`. That dependency
was removed deliberately and should not be reintroduced:

- **`serde_yaml` is archived and unmaintained.** Upstream development stopped
  and the repository was archived in 2024, so it receives no fixes, including
  security fixes.
- **`serde-saphyr` is a maintained, pure-Rust replacement** — `unsafe`-free,
  panic-free on malformed input, no C bindings — which keeps the core
  embeddable in wasm and other hosts.
- **One value tree for everything.** YAML is deserialized directly into
  `serde_json::Value` (`serde_saphyr::from_str::<serde_json::Value>`), so
  `package.json` and agent YAML flow through the same helpers instead of
  parallel YAML/JSON code paths. There is no intermediate YAML value and no
  conversion step.
- **Stricter where a validator should be.** Duplicate mapping keys and
  YAML-only constructs that do not fit the JSON data model (non-string keys,
  tags) are rejected as malformed rather than silently accepted, matching the
  behaviour of the `introspection-recipe-manifest` validator in
  `introspection-cli`.

## License

MIT
