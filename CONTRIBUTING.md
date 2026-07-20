# Contributing to Pi Recipes

Contributions are welcome — bug reports, docs improvements, new checks for the
validator, and recipe tooling features alike.

## Development Setup

The repository is a pnpm workspace with a Rust crate alongside it. Install and
verify with:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` builds the TypeScript sources and the `recipe-check` binary before
running vitest, so a working Rust toolchain (stable) is required.

Install from a local clone into Pi:

```bash
pnpm build
pi install "$(pwd)"
```

Pi records the local package path in `~/.pi/agent/settings.json`. Re-run
`pnpm build` after changing extension source.

## Rust Validator (`pi-recipe-check`)

The recipe validation engine lives in
[`crates/pi-recipe-check`](crates/pi-recipe-check). For changes there, also
run:

```bash
cargo fmt --all --check
cargo clippy -p pi-recipe-check --all-targets
cargo test -p pi-recipe-check
cargo build -p pi-recipe-check --no-default-features
```

The last command guards the pure, I/O-free core: it must keep building without
the `fs`/`cli` features so the crate stays embeddable (native, wasm, Python).

## Python Bindings

The typed Python package and PyO3 extension live in
[`bindings/python`](bindings/python). Install
[`uv`](https://docs.astral.sh/uv/getting-started/installation/), then build and
test it from the repository root:

```bash
uv sync --project bindings/python --locked
uv run --project bindings/python --locked ruff format --check bindings/python/python bindings/python/tests
uv run --project bindings/python --locked ruff check bindings/python/python bindings/python/tests
uv run --project bindings/python --locked mypy --strict bindings/python/python bindings/python/tests
uv run --project bindings/python --locked maturin develop --manifest-path bindings/python/Cargo.toml
uv run --project bindings/python --no-sync pytest bindings/python/tests
```

The Python binding must depend on `pi-recipe-check` with default features
disabled so it cannot accidentally introduce filesystem access.

## Commits and Releases

- Use [Conventional Commit](https://www.conventionalcommits.org) messages:
  `fix:` for patches, `feat:` for minor changes, `feat!:` or a
  `BREAKING CHANGE:` footer for major changes.
- Releases follow SemVer and are cut automatically by release-please for both
  the npm package and the `pi-recipe-check` crate — never bump package
  versions by hand; let the release PRs do it.
- Beta prereleases use the `beta` npm dist-tag, stable releases use `latest`.

## Pull Requests

1. Fork the repository and create a branch.
2. Keep the verification commands above green.
3. Open a pull request with a Conventional Commit title and make sure CI
   passes.

## Reporting Issues

Open a GitHub issue with a descriptive title, reproduction steps (recipe
layout and the command you ran), the expected and actual behaviour, and any
relevant output from `recipes check --json`.
