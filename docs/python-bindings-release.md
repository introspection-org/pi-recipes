# Python bindings release

The `pi-recipe-check` Python distribution is versioned independently from the
Rust crate and npm package. Release Please owns its version in
`bindings/python/Cargo.toml`, changelog, `pi-recipe-check-python-v*` tags, and
GitHub releases. Routine releases must not bump the Cargo version manually.
Its versioned workspace dependency on the Rust engine allows Release Please's
existing `cargo-workspace` plugin to patch-release the Python distribution
whenever a new embedded `pi-recipe-check` version must be shipped.

The binding is intentionally absent from `.release-please-manifest.json` in
its bootstrap change. Release Please will create the initial `0.1.0` release
entry when its first release PR is merged; subsequent releases update the
manifest normally.

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
