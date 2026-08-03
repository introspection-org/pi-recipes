from __future__ import annotations

import introspection_recipe_check


def test_accepts_portable_runtime_requirements() -> None:
    report = introspection_recipe_check.check_recipe_files(
        {
            "files": [
                {
                    "path": "package.json",
                    "content": (
                        '{"name":"demo","pi":{"agents":["agents/*.yaml"],'
                        '"runtime":{"python":{"project":"python",'
                        '"lockfile":"python/uv.lock","version":">=3.14,<3.15",'
                        '"imports":["demo"]}}}}'
                    ),
                },
                {
                    "path": "agents/agent.yaml",
                    "content": "name: agent\nmodel:\n  name: test/model\n",
                },
                {"path": "python/pyproject.toml"},
                {"path": "python/uv.lock"},
            ]
        }
    )

    assert report.valid
    assert report.diagnostics == ()


def test_invalid_recipe_returns_typed_diagnostics() -> None:
    report = introspection_recipe_check.check_recipe_files({"files": []})

    assert not report.valid
    assert report.diagnostics[0].code == "package.manifest_missing"
    assert report.to_dict()["valid"] is False


def test_judge_parser_preserves_cloud_compatibility_surface() -> None:
    parsed = introspection_recipe_check.parse_judge_definitions(
        [
            {
                "path": "judges/helpful.yaml",
                "content": (
                    "name: helpful\n"
                    "instructions: Grade the answer.\n"
                    "llm:\n"
                    "  model: gpt-5\n"
                ),
            }
        ]
    )

    assert parsed[0].source_path == "judges/helpful.yaml"
    assert parsed[0].definition.to_dict()["name"] == "helpful"

    legacy = introspection_recipe_check.parse_judge_definitions(
        [
            {
                "path": "judges/legacy.yaml",
                "content": (
                    "judge: legacy\n"
                    "instructions: Grade the answer.\n"
                    "llm:\n"
                    "  model: gpt-5\n"
                ),
            }
        ]
    )
    assert legacy[0].definition.to_dict()["name"] == "legacy"
