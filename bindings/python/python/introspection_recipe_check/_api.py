from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import TypedDict, cast

from . import _native


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
    code: str
    path: str
    message: str
    span: Span | None = None
    help: str | None = None


@dataclass(frozen=True, slots=True)
class Report:
    valid: bool
    diagnostics: tuple[Diagnostic, ...]
    resources: dict[str, int]

    def to_dict(self) -> dict[str, object]:
        return cast(dict[str, object], asdict(self))


def check_recipe_files(snapshot: RecipeFiles) -> Report:
    """Validate an in-memory Recipe tree without filesystem access."""
    raw = cast(
        dict[str, object],
        json.loads(
            _native.check_recipe_files_json(
                json.dumps(snapshot, separators=(",", ":")),
            )
        ),
    )
    return Report(
        valid=cast(bool, raw["valid"]),
        diagnostics=tuple(
            _diagnostic(cast(dict[str, object], item))
            for item in cast(list[object], raw["diagnostics"])
        ),
        resources=cast(dict[str, int], raw.get("resources", {})),
    )


class JudgeSource(TypedDict):
    path: str
    content: str


@dataclass(frozen=True, slots=True)
class JudgeDefinition:
    value: dict[str, object]

    def to_dict(self) -> dict[str, object]:
        return self.value.copy()


@dataclass(frozen=True, slots=True)
class ParsedJudgeDefinition:
    source_path: str
    definition: JudgeDefinition


def parse_judge_definitions(
    sources: list[JudgeSource],
) -> tuple[ParsedJudgeDefinition, ...]:
    raw = cast(
        list[dict[str, object]],
        json.loads(
            _native.parse_judge_definitions_json(
                json.dumps(sources, separators=(",", ":")),
            )
        ),
    )
    return tuple(
        ParsedJudgeDefinition(
            source_path=cast(str, item["source_path"]),
            definition=JudgeDefinition(cast(dict[str, object], item["definition"])),
        )
        for item in raw
    )


def judge_definition_schema() -> dict[str, object]:
    return cast(
        dict[str, object],
        json.loads(_native.judge_definition_schema_json()),
    )


def _diagnostic(raw: dict[str, object]) -> Diagnostic:
    raw_span = cast(dict[str, object] | None, raw.get("span"))
    return Diagnostic(
        code=cast(str, raw["code"]),
        path=cast(str, raw["path"]),
        message=cast(str, raw["message"]),
        span=(
            Span(
                line=cast(int, raw_span["line"]),
                column=cast(int, raw_span["column"]),
            )
            if raw_span is not None
            else None
        ),
        help=cast(str | None, raw.get("help")),
    )
