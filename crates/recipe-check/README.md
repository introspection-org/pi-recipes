# recipe-check

Pure structural validation for [Recipe](https://pi.recipes) packages.

The checker validates the portable authored contract:

- the `package.json#pi` manifest and its resource paths;
- agent YAML shape, names, and `from` inheritance;
- each agent's explicit stable `name`, required resolved `model.name`, and any
  declared skill, subagent, or extension references;
- package and agent MCP authorization policy.

It deliberately does not validate host manifests, compute resources,
package-manager policy, publication metadata, licenses, or local endpoint
bindings.

## I/O-free API

The core API accepts an in-memory snapshot and never touches the filesystem:

```rust
use recipe_check::{check_recipe_files, RecipeFile, RecipeFiles};

let input = RecipeFiles {
    files: vec![
        RecipeFile::new(
            "package.json",
            r#"{ "name": "demo", "pi": { "agents": ["agents/*.yaml"] } }"#,
        ),
        RecipeFile::new("agents/agent.yaml", "name: agent\n..."),
    ],
    directories: Vec::new(),
};
let report = check_recipe_files(&input);
assert!(!report.valid);
```

The `recipe-check` binary is a private snapshot-in/snapshot-out bridge embedded
in the npm package so `pi --recipe` can run the same checker at startup. It is
not a user-facing filesystem CLI.

Diagnostics include a stable code, Recipe-relative path, optional 1-based
source span, message, and optional help text.

## License

Apache-2.0
