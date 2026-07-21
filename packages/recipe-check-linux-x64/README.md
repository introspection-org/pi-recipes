# @introspection-ai/recipe-check-linux-x64

Prebuilt `recipe-check` binary for `linux-x64`.

This package exists so consumers download one binary instead of all five. It is published as a per-platform `optionalDependency` of `@introspection-ai/pi-recipes`, and the installer selects it via the `os`/`cpu` fields. Do not depend on it directly.

The binary itself is built from `crates/pi-recipe-check` in CI and is not checked in.
