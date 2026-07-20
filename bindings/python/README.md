# pi-recipe-check for Python

Native Python bindings for the pure, I/O-free
[`pi-recipe-check`](https://crates.io/crates/pi-recipe-check) validation engine.

```sh
pip install pi-recipe-check
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
python -m venv .venv
source .venv/bin/activate
python -m pip install "maturin==1.11.5" "mypy==2.3.0" pytest "ruff==0.15.22"
ruff format --check bindings/python/python bindings/python/tests
ruff check bindings/python/python bindings/python/tests
mypy --strict bindings/python/python bindings/python/tests
maturin develop --manifest-path bindings/python/Cargo.toml
python -m pytest bindings/python/tests
```
