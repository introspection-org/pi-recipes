from __future__ import annotations

import pi_recipe_check
import pytest


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
