from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Literal, TypedDict, cast

from . import _native

CheckProfile = Literal["local", "ci", "publish"]
Severity = Literal["error", "warning"]


class _RecipeFileOptional(TypedDict, total=False):
    content: str | None


class RecipeFile(_RecipeFileOptional):
    path: str


class _RecipeFilesOptional(TypedDict, total=False):
    directories: list[str]


class RecipeFiles(_RecipeFilesOptional):
    files: list[RecipeFile]


@dataclass(frozen=True, slots=True)
class Span:
    line: int
    column: int


@dataclass(frozen=True, slots=True)
class Diagnostic:
    severity: Severity
    code: str
    path: str
    message: str
    span: Span | None = None
    help: str | None = None


@dataclass(frozen=True, slots=True)
class Report:
    valid: bool
    profile: CheckProfile
    recipe_dir: str
    package_name: str | None
    diagnostics: tuple[Diagnostic, ...]
    resources: dict[str, int]

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-compatible copy suitable for persistence."""
        return cast(dict[str, object], asdict(self))


def check_recipe_files(
    snapshot: RecipeFiles,
    profile: CheckProfile = "local",
) -> Report:
    """Validate an in-memory recipe tree without filesystem access.

    Invalid recipes return a report with ``valid=False``. Malformed snapshots
    and unknown profiles raise ``ValueError``.
    """
    report = cast(
        dict[str, object],
        json.loads(
            _native.check_recipe_files_json(
                json.dumps(snapshot, separators=(",", ":")),
                profile,
            )
        ),
    )
    diagnostics = tuple(
        _diagnostic(cast(dict[str, object], raw))
        for raw in cast(list[object], report["diagnostics"])
    )
    return Report(
        valid=cast(bool, report["valid"]),
        profile=cast(CheckProfile, report["profile"]),
        recipe_dir=cast(str, report["recipe_dir"]),
        package_name=cast(str | None, report.get("package_name")),
        diagnostics=diagnostics,
        resources=cast(dict[str, int], report["resources"]),
    )


def _diagnostic(raw: dict[str, object]) -> Diagnostic:
    raw_span = cast(dict[str, object] | None, raw.get("span"))
    span = None
    if raw_span is not None:
        span = Span(
            line=cast(int, raw_span["line"]),
            column=cast(int, raw_span["column"]),
        )
    return Diagnostic(
        severity=cast(Severity, raw["severity"]),
        code=cast(str, raw["code"]),
        path=cast(str, raw["path"]),
        message=cast(str, raw["message"]),
        span=span,
        help=cast(str | None, raw.get("help")),
    )
