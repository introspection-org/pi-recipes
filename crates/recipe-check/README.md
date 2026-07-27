# recipe-check

Pure structural validation for [Recipe](https://pi.recipes) packages.

The checker validates the portable authored contract:

- the `package.json#pi` manifest and its resource paths;
- agent YAML shape, names, and `from` inheritance;
- each agent's explicit stable `name`, required resolved `model.name`, and any
  declared skill or subagent references;
- package and agent MCP authorization policy;
- direct-child `judges/*.yaml` definitions and their typed authored schema;
- dependency lockfile presence and npm lockfile identity;
- exclusion of local capability configuration from distributable snapshots.

It deliberately does not validate host manifests, credentials, deployment
resources, licenses, or local endpoint bindings. The exported `resources`
module separately provides the shared, pure Kubernetes-style quantity checker
used by hosts; those values are not part of the Recipe Format.

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

`recipe_check::spec` exports the normalized judge types and, with the optional
`schema` feature, their JSON Schema. Judge execution remains host-owned.

## License

Apache-2.0
