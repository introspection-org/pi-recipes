from __future__ import annotations

import pi_recipe_check
import pytest


def _valid_recipe_files() -> list[pi_recipe_check.RecipeFile]:
    return [
        {
            "path": "package.json",
            "content": (
                '{"name":"demo","description":"Demo","pi":{"agents":["agents/*.yaml"]}}'
            ),
        },
        {
            "path": "agents/agent.yaml",
            "content": (
                "name: agent\n"
                "description: Test agent\n"
                "model:\n"
                "  name: test/provider-model\n"
                "  thinking_level: low\n"
                "tools: []\n"
                "skills: []\n"
                "subagents: []\n"
                "system_instructions:\n"
                "  content: Test instructions\n"
            ),
        },
    ]


def test_validates_snapshot_without_filesystem_io() -> None:
    report = pi_recipe_check.check_recipe_files(
        {
            "files": [
                {
                    "path": "package.json",
                    "content": '{"name":"demo","pi":{}}',
                }
            ]
        }
    )

    assert not report.valid
    assert report.profile == "local"
    assert report.recipe_dir == "."
    assert any(
        item.code == "package.description_missing" for item in report.diagnostics
    )


def test_invalid_recipe_returns_diagnostics_instead_of_raising() -> None:
    report = pi_recipe_check.check_recipe_files({"files": []}, profile="ci")

    assert not report.valid
    assert report.profile == "ci"
    assert report.diagnostics[0].code == "package.manifest_missing"
    assert report.to_dict()["valid"] is False


def test_missing_content_is_distinct_from_missing_file() -> None:
    report = pi_recipe_check.check_recipe_files({"files": [{"path": "package.json"}]})

    assert [item.code for item in report.diagnostics] == ["package.manifest_unreadable"]


def test_parse_diagnostic_exposes_source_span() -> None:
    report = pi_recipe_check.check_recipe_files(
        {"files": [{"path": "package.json", "content": "{"}]}
    )

    diagnostic = report.diagnostics[0]
    assert diagnostic.code == "package.manifest_malformed"
    assert diagnostic.span == pi_recipe_check.Span(line=1, column=1)


def test_judge_validation_returns_structured_diagnostics() -> None:
    report = pi_recipe_check.check_recipe_files(
        {
            "files": [
                *_valid_recipe_files(),
                {
                    "path": "judges/broken.yml",
                    "content": (
                        "judge: helpful\ninstructions: Grade it.\nllm:\n  model: ''\n"
                    ),
                },
            ]
        },
        profile="ci",
    )

    assert not report.valid
    assert report.resources["judges"] == 1
    diagnostic = next(
        item for item in report.diagnostics if item.code == "judge.llm.model_invalid"
    )
    assert diagnostic.path == "judges/broken.yml"
    assert diagnostic.severity == "error"
    assert diagnostic.help is not None


def test_judge_validation_matches_engine_parser_optional_null_semantics() -> None:
    report = pi_recipe_check.check_recipe_files(
        {
            "files": [
                *_valid_recipe_files(),
                {
                    "path": "judges/parser-parity.yaml",
                    "content": (
                        "judge: parser-parity\n"
                        "instructions: Grade it.\n"
                        "on:\n"
                        "  - event: message\n"
                        "    match:\n"
                        "      event: message\n"
                        "llm:\n"
                        "  model: gpt-5\n"
                        "  request:\n"
                        "    max_tokens: null\n"
                        "    reasoning_effort: null\n"
                    ),
                },
            ]
        },
        profile="ci",
    )

    assert report.valid
    assert not any(item.code.startswith("judge.") for item in report.diagnostics)


def test_malformed_judge_yaml_exposes_source_span() -> None:
    report = pi_recipe_check.check_recipe_files(
        {
            "files": [
                {
                    "path": "judges/broken.yaml",
                    "content": "judge: okay\nllm:\n  model: [broken\n",
                }
            ]
        }
    )

    diagnostic = next(
        item for item in report.diagnostics if item.code == "judge.yaml_malformed"
    )
    assert diagnostic.path == "judges/broken.yaml"
    assert diagnostic.span is not None
    assert diagnostic.span.line >= 1


def test_unknown_profile_raises_value_error() -> None:
    with pytest.raises(ValueError, match="expected local, ci, or publish"):
        pi_recipe_check.check_recipe_files(
            {"files": []},
            profile="staging",  # type: ignore[arg-type]
        )


def test_non_serializable_snapshot_raises_type_error() -> None:
    with pytest.raises(TypeError):
        pi_recipe_check.check_recipe_files(
            {
                "files": [
                    {
                        "path": "package.json",
                        "content": object(),  # type: ignore[typeddict-item]
                    }
                ]
            }
        )


def test_malformed_snapshot_raises_value_error() -> None:
    with pytest.raises(ValueError, match="invalid recipe snapshot"):
        pi_recipe_check.check_recipe_files(
            {"files": "not-a-list"}  # type: ignore[typeddict-item]
        )
