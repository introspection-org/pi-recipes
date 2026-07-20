# pi-recipe-check for Python

Native Python bindings for the pure, I/O-free
[`pi-recipe-check`](https://crates.io/crates/pi-recipe-check) validation engine.

```sh
uv add pi-recipe-check
```

```python
from pi_recipe_check import check_recipe_files

report = check_recipe_files(
    {
        "files": [
            {
                "path": "package.json",
                "content": '{"name":"demo","pi":{}}',
            }
        ],
        "directories": [],
    },
    profile="ci",
)

for diagnostic in report.diagnostics:
    print(diagnostic.code, diagnostic.path, diagnostic.message)
```

The snapshot represents the complete recipe tree. File paths are relative to
the recipe root and use `/` separators. Omit `content`, or set it to `None`,
when the file exists but its contents were not supplied. Ancestor directories
are inferred; `directories` is only needed for empty directories.

Invalid recipes return a `Report` with `valid=False`. Malformed input and
unknown validation profiles raise `ValueError`. The binding performs no
filesystem I/O and does not include the Rust crate's `fs` or `cli` features.

## Development

```sh
uv sync --project bindings/python --locked
uv run --project bindings/python --locked ruff format --check bindings/python/python bindings/python/tests
uv run --project bindings/python --locked ruff check bindings/python/python bindings/python/tests
uv run --project bindings/python --locked mypy --strict bindings/python/python bindings/python/tests
uv run --project bindings/python --locked maturin develop --manifest-path bindings/python/Cargo.toml
uv run --project bindings/python --no-sync pytest bindings/python/tests
```
