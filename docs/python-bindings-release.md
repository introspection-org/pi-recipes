# Python bindings release

The `pi-recipe-check` Rust crate and Python distribution are two artifacts of
one validator product and always use the same version. The binding's Cargo
package and dependency on the core must both match the core crate version.
`scripts/check-recipe-check-versions.mjs` enforces this invariant in CI.

Release Please owns both versions, changelogs, component tags, and GitHub
releases. Its `linked-versions` plugin advances both components to the same
version whenever either has a releasable change. The `cargo-workspace` plugin
keeps the local dependency current, but leaves candidate merging to
`linked-versions`. A Python-only fix therefore creates a patch release for
both artifacts, and a core release always includes a matching Python release.
Routine releases must not bump either Cargo version manually.

When Release Please creates a Python binding release, the release workflow:

1. Builds `abi3` wheels compatible with CPython 3.10 and newer for Linux
   x86-64 and ARM64, macOS Apple Silicon and Intel, and Windows x86-64.
2. Builds a source distribution containing the local Rust workspace
   dependency.
3. Publishes all artifacts to PyPI through trusted publishing.

## One-time PyPI setup

Before the first release, create a pending trusted publisher for the unclaimed
`pi-recipe-check` project on PyPI with:

- Owner: `introspection-org`
- Repository: `pi-recipes`
- Workflow: `release-please.yml`
- Environment: `publish`

The GitHub `publish` environment should retain its existing deployment
protection. No long-lived PyPI API token is required.

Local release artifact checks use the locked development environment and the
same pinned maturin version as CI:

```sh
uv sync --project bindings/python --locked
uv run --project bindings/python --locked maturin build --locked --release --out dist \
  --manifest-path bindings/python/Cargo.toml
uv run --project bindings/python --locked maturin sdist --out dist \
  --manifest-path bindings/python/Cargo.toml
```
