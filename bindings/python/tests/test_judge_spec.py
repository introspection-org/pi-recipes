from __future__ import annotations

import pi_recipe_check
import pytest

HELPFUL_JUDGE = """\
judge: helpful
description: Scores whether the assistant actually helped.
instructions: |
  Judge whether the assistant resolved the user's request.
llm:
  model: gpt-5
"""


def test_parses_sources_and_applies_spec_defaults() -> None:
    parsed = pi_recipe_check.parse_judge_definitions(
        [{"path": "judges/helpful.yaml", "content": HELPFUL_JUDGE}],
    )

    assert len(parsed) == 1
    assert parsed[0].source_path == "judges/helpful.yaml"
    definition = parsed[0].definition
    assert definition.judge == "helpful"
    assert definition.description == "Scores whether the assistant actually helped."
    assert definition.on == {}
    assert definition.llm.provider == "openai"
    assert definition.llm.model == "gpt-5"
    assert definition.llm.request.temperature == 0.0
    assert definition.llm.request.max_tokens is None
    assert definition.llm.transport.timeout_ms == 60_000
    assert definition.llm.local is None
    assert definition.instructions.startswith("Judge whether")
    assert definition.to_dict()["judge"] == "helpful"


def test_sources_are_parsed_in_path_order() -> None:
    parsed = pi_recipe_check.parse_judge_definitions(
        [
            {
                "path": "judges/b.yaml",
                "content": "judge: b\ninstructions: Grade b.\nllm:\n  model: gpt-5\n",
            },
            {
                "path": "judges/a.yaml",
                "content": "judge: a\ninstructions: Grade a.\nllm:\n  model: gpt-5\n",
            },
        ],
    )
    assert [item.source_path for item in parsed] == ["judges/a.yaml", "judges/b.yaml"]


def test_gate_and_local_endpoint_round_trip() -> None:
    content = """\
judge: gated
instructions: Grade the discount decision.
on:
  - event: tool
    match:
      name: apply_discount
llm:
  model: gpt-5
  local:
    base_url: http://[::1]:4000/v1
    api_key_env: MODEL_API_KEY
"""
    parsed = pi_recipe_check.parse_judge_definitions(
        [{"path": "judges/gated.yaml", "content": content}],
    )
    definition = parsed[0].definition
    assert definition.on == [{"event": "tool", "match": {"name": "apply_discount"}}]
    assert definition.llm.local is not None
    assert definition.llm.local.base_url == "http://[::1]:4000/v1"


def test_duplicate_judge_names_are_rejected() -> None:
    with pytest.raises(ValueError, match="duplicate judge name"):
        pi_recipe_check.parse_judge_definitions(
            [
                {"path": "judges/a.yaml", "content": HELPFUL_JUDGE},
                {"path": "judges/b.yaml", "content": HELPFUL_JUDGE},
            ],
        )


def test_invalid_definitions_raise_for_the_whole_batch() -> None:
    with pytest.raises(ValueError, match="empty instructions"):
        pi_recipe_check.parse_judge_definitions(
            [
                {
                    "path": "judges/empty.yaml",
                    "content": "judge: empty\nllm:\n  model: gpt-5\n",
                }
            ],
        )


def test_unknown_fields_are_rejected_with_source_path() -> None:
    with pytest.raises(ValueError, match="judges/typo.yaml"):
        pi_recipe_check.parse_judge_definitions(
            [
                {
                    "path": "judges/typo.yaml",
                    "content": HELPFUL_JUDGE + "surprise: true\n",
                }
            ],
        )


def test_judge_definition_schema_names_authored_fields() -> None:
    schema = pi_recipe_check.judge_definition_schema()

    properties = schema["properties"]
    assert isinstance(properties, dict)
    for field in ("judge", "description", "on", "llm", "instructions"):
        assert field in properties, field
    assert schema["additionalProperties"] is False
    required = schema["required"]
    assert isinstance(required, list)
    assert "judge" in required
    assert "llm" in required
    assert "instructions" in required
    instructions = properties["instructions"]
    assert isinstance(instructions, dict)
    assert instructions["type"] == "string"
    assert instructions["minLength"] == 1
    assert instructions["pattern"] == r"\S"

    judge = properties["judge"]
    assert isinstance(judge, dict)
    assert judge["maxLength"] == 255
    assert judge["pattern"] == r"\S"

    defs = schema["$defs"]
    assert isinstance(defs, dict)
    request = defs["JudgeLlmRequest"]
    assert isinstance(request, dict)
    temperature = request["properties"]["temperature"]
    assert temperature["minimum"] == 0.0
    assert temperature["maximum"] == 2.0
