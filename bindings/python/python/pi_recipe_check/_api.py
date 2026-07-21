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


class JudgeSource(TypedDict):
    path: str
    content: str


@dataclass(frozen=True, slots=True)
class JudgeLlmRequest:
    temperature: float
    max_tokens: int | None
    reasoning_effort: str | None


@dataclass(frozen=True, slots=True)
class JudgeLlmTransport:
    timeout_ms: int
    max_retries: int
    max_retry_delay_ms: int


@dataclass(frozen=True, slots=True)
class JudgeLlmLocal:
    base_url: str
    api_key_env: str


@dataclass(frozen=True, slots=True)
class JudgeLlmConfig:
    provider: str
    model: str
    request: JudgeLlmRequest
    transport: JudgeLlmTransport
    local: JudgeLlmLocal | None


@dataclass(frozen=True, slots=True)
class JudgeDefinition:
    """One authored judge definition in its normalized spec form.

    This is the portable authored contract only — spec defaults applied,
    no platform identity. ``on`` is the raw applicability gate value:
    ``{}`` (always) or a list of ``{event, match?}`` matchers.
    """

    judge: str
    description: str | None
    on: list[dict[str, object]] | dict[str, object]
    llm: JudgeLlmConfig
    instructions: str

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-compatible copy suitable for persistence."""
        return cast(dict[str, object], asdict(self))


@dataclass(frozen=True, slots=True)
class ParsedJudgeDefinition:
    source_path: str
    definition: JudgeDefinition


def parse_judge_definitions(
    sources: list[JudgeSource],
) -> tuple[ParsedJudgeDefinition, ...]:
    """Strictly parse judge YAML sources into normalized definitions.

    Unlike recipe checking, judge parsing is strict: any invalid definition
    (malformed YAML, unknown fields, empty instructions, duplicate names,
    invalid llm config or gate) raises ``ValueError`` for the whole batch.
    """
    parsed = cast(
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
            definition=_judge_definition(cast("dict[str, object]", item["definition"])),
        )
        for item in parsed
    )


def judge_definition_schema() -> dict[str, object]:
    """JSON Schema for the authored judge definition."""
    return cast(dict[str, object], json.loads(_native.judge_definition_schema_json()))


def _judge_definition(raw: dict[str, object]) -> JudgeDefinition:
    llm = cast(dict[str, object], raw["llm"])
    request = cast(dict[str, object], llm["request"])
    transport = cast(dict[str, object], llm["transport"])
    raw_local = cast(dict[str, object] | None, llm.get("local"))
    local = None
    if raw_local is not None:
        local = JudgeLlmLocal(
            base_url=cast(str, raw_local["base_url"]),
            api_key_env=cast(str, raw_local["api_key_env"]),
        )
    return JudgeDefinition(
        judge=cast(str, raw["judge"]),
        description=cast(str | None, raw.get("description")),
        on=cast("list[dict[str, object]] | dict[str, object]", raw["on"]),
        llm=JudgeLlmConfig(
            provider=cast(str, llm["provider"]),
            model=cast(str, llm["model"]),
            request=JudgeLlmRequest(
                temperature=cast(float, request["temperature"]),
                max_tokens=cast(int | None, request.get("max_tokens")),
                reasoning_effort=cast(str | None, request.get("reasoning_effort")),
            ),
            transport=JudgeLlmTransport(
                timeout_ms=cast(int, transport["timeout_ms"]),
                max_retries=cast(int, transport["max_retries"]),
                max_retry_delay_ms=cast(int, transport["max_retry_delay_ms"]),
            ),
            local=local,
        ),
        instructions=cast(str, raw["instructions"]),
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
