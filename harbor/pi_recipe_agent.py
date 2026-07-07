"""Harbor adapter that runs the recipe under test through Pi."""

from __future__ import annotations

import json
import os
import shlex
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)


def _env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if not value:
        raise RuntimeError(f"{name} is required for Pi recipe Harbor evals")
    return value


def _quote(value: str) -> str:
    return shlex.quote(value)


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except TypeError:
        return str(value)


def _output_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value if isinstance(value, str) else _stringify(value)


def _json_object(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _timestamp(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )
    return None


def _content_parts(message: dict[str, Any]) -> list[Any]:
    content = message.get("content")
    if isinstance(content, list):
        return content
    if content is None:
        return []
    return [content]


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks: list[str] = []
        for part in content:
            if isinstance(part, str):
                chunks.append(part)
            elif isinstance(part, dict):
                part_type = part.get("type")
                if part_type == "text" and isinstance(part.get("text"), str):
                    chunks.append(part["text"])
                elif part_type == "image":
                    chunks.append("[image]")
                elif part_type not in {"toolCall", "thinking"}:
                    chunks.append(_stringify(part))
            else:
                chunks.append(_stringify(part))
        return "\n".join(chunk for chunk in chunks if chunk)
    return _stringify(content)


def _message_text(message: dict[str, Any]) -> str:
    return _content_text(message.get("content"))


def _reasoning_content(message: dict[str, Any]) -> str | None:
    chunks: list[str] = []
    for part in _content_parts(message):
        if not isinstance(part, dict) or part.get("type") != "thinking":
            continue
        thinking = part.get("thinking")
        if isinstance(thinking, str) and thinking:
            chunks.append(thinking)
            continue
        signature = _json_object(part.get("thinkingSignature"))
        summary = signature.get("summary")
        if isinstance(summary, list):
            for item in summary:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    chunks.append(item["text"])
    return "\n\n".join(chunks) or None


def _tool_calls(message: dict[str, Any]) -> list[ToolCall] | None:
    calls: list[ToolCall] = []
    for index, part in enumerate(_content_parts(message), start=1):
        if not isinstance(part, dict) or part.get("type") != "toolCall":
            continue
        tool_call_id = _stringify(part.get("id") or f"tool_call_{index}")
        function_name = _stringify(part.get("name") or "tool")
        arguments = part.get("arguments")
        calls.append(
            ToolCall(
                tool_call_id=tool_call_id,
                function_name=function_name,
                arguments=arguments if isinstance(arguments, dict) else {},
                extra={
                    key: value
                    for key, value in {
                        "raw_arguments": None
                        if isinstance(arguments, dict)
                        else arguments,
                    }.items()
                    if value is not None
                }
                or None,
            )
        )
    return calls or None


def _observation(tool_results: Any) -> Observation | None:
    if not isinstance(tool_results, list) or not tool_results:
        return None
    results: list[ObservationResult] = []
    for result in tool_results:
        if not isinstance(result, dict):
            results.append(ObservationResult(content=_stringify(result)))
            continue
        results.append(
            ObservationResult(
                source_call_id=result.get("toolCallId"),
                content=_message_text(result),
                extra={
                    key: value
                    for key, value in {
                        "tool_name": result.get("toolName"),
                        "is_error": result.get("isError"),
                    }.items()
                    if value is not None
                }
                or None,
            )
        )
    return Observation(results=results)


def _metrics(message: dict[str, Any]) -> Metrics | None:
    usage = _json_object(message.get("usage"))
    if not usage:
        return None

    prompt_tokens = sum(
        value
        for value in [
            usage.get("input"),
            usage.get("cacheRead"),
            usage.get("cacheWrite"),
        ]
        if isinstance(value, int)
    )
    completion_tokens = usage.get("output")
    cached_tokens = usage.get("cacheRead")
    cost = _json_object(usage.get("cost")).get("total")
    extra = {
        key: value
        for key, value in {
            "pi_cache_write_tokens": usage.get("cacheWrite"),
            "pi_total_tokens": usage.get("totalTokens"),
        }.items()
        if value is not None
    }
    return Metrics(
        prompt_tokens=prompt_tokens or None,
        completion_tokens=completion_tokens if isinstance(completion_tokens, int) else None,
        cached_tokens=cached_tokens if isinstance(cached_tokens, int) else None,
        cost_usd=cost if isinstance(cost, (int, float)) else None,
        extra=extra or None,
    )


def _final_metrics(steps: list[Step]) -> FinalMetrics:
    prompt_tokens = 0
    completion_tokens = 0
    cached_tokens = 0
    cost_usd = 0.0
    has_cost = False

    for step in steps:
        metrics = step.metrics
        if metrics is None:
            continue
        prompt_tokens += metrics.prompt_tokens or 0
        completion_tokens += metrics.completion_tokens or 0
        cached_tokens += metrics.cached_tokens or 0
        if metrics.cost_usd is not None:
            cost_usd += metrics.cost_usd
            has_cost = True

    return FinalMetrics(
        total_prompt_tokens=prompt_tokens or None,
        total_completion_tokens=completion_tokens or None,
        total_cached_tokens=cached_tokens or None,
        total_cost_usd=cost_usd if has_cost else None,
        total_steps=len(steps),
    )


def _parse_events(jsonl: str) -> tuple[list[dict[str, Any]], list[str]]:
    events: list[dict[str, Any]] = []
    skipped: list[str] = []
    for line in jsonl.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            skipped.append(stripped[:500])
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
        else:
            skipped.append(stripped[:500])
    return events, skipped


def _pi_events_to_trajectory(
    events: list[dict[str, Any]],
    *,
    instruction: str,
    recipe_name: str,
    recipe_agent: str | None,
    adapter_version: str,
    skipped_lines: list[str],
) -> Trajectory:
    session = next((event for event in events if event.get("type") == "session"), {})
    session_id = session.get("id") if isinstance(session.get("id"), str) else None
    model_name: str | None = None
    steps = [
        Step(
            step_id=1,
            timestamp=_timestamp(session.get("timestamp")),
            source="user",
            message=instruction,
        )
    ]

    for event in events:
        event_type = event.get("type")
        if event_type == "model_change":
            provider = event.get("provider")
            model_id = event.get("modelId")
            if isinstance(provider, str) and isinstance(model_id, str):
                model_name = f"{provider}/{model_id}"
        if event_type != "turn_end":
            continue

        message = _json_object(event.get("message"))
        metrics = _metrics(message)
        steps.append(
            Step(
                step_id=len(steps) + 1,
                timestamp=_timestamp(event.get("timestamp"))
                or _timestamp(message.get("timestamp")),
                source="agent",
                model_name=model_name,
                message=_message_text(message),
                reasoning_content=_reasoning_content(message),
                tool_calls=_tool_calls(message),
                observation=_observation(event.get("toolResults")),
                metrics=metrics,
                llm_call_count=1,
            )
        )

    notes = None
    if skipped_lines:
        notes = (
            "Some stdout lines from `pi --mode json` were not valid JSON and were "
            "omitted from the trajectory. See pi-events-skipped.log."
        )

    return Trajectory(
        schema_version="ATIF-v1.7",
        session_id=session_id,
        trajectory_id=f"pi-recipe-{session_id}" if session_id else None,
        agent=Agent(
            name=PiRecipeAgent.name(),
            version=adapter_version,
            model_name=model_name,
            extra={
                "recipe_name": recipe_name,
                **({"recipe_agent": recipe_agent} if recipe_agent else {}),
            },
        ),
        steps=steps,
        notes=notes,
        final_metrics=_final_metrics(steps),
        extra={
            "source_format": "pi-json-event-stream",
            "source_command": "pi --mode json",
        },
    )


def _command_env() -> dict[str, str]:
    names = [
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "OPENROUTER_API_KEY",
    ]
    return {name: os.environ[name] for name in names if os.environ.get(name)}


class PiRecipeAgent(BaseInstalledAgent):
    """Install pi-recipes and run the selected recipe for each Harbor task."""

    VERSION = "0.1.0"

    @staticmethod
    def name() -> str:
        return "pi-recipe"

    def __init__(
        self,
        logs_dir: Any | None = None,
        model_name: str | None = None,
        logger: Any | None = None,
        **kwargs: Any,
    ) -> None:
        extra_env = _command_env()
        harbor_extra_env = kwargs.pop("extra_env", None)
        if harbor_extra_env:
            extra_env.update(harbor_extra_env)
        super().__init__(
            logs_dir=logs_dir,
            version=self.VERSION,
            extra_env=extra_env,
            model_name=model_name,
            logger=logger,
            **kwargs,
        )

    async def install(self, environment: Any) -> None:
        recipe_source = _env("PI_RECIPE_SOURCE")
        recipe_runtime = os.environ.get("PI_RECIPE_RUNTIME")
        root_commands = [
            "command -v curl >/dev/null || (command -v apt-get >/dev/null && apt-get update && apt-get install -y curl ca-certificates gnupg)",
            "node -e \"process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)\" >/dev/null 2>&1 || (command -v apt-get >/dev/null && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs)",
        ]
        if not recipe_runtime:
            root_commands.append(
                "command -v npm >/dev/null || (command -v apt-get >/dev/null && apt-get update && apt-get install -y npm)"
            )
        runtime_commands = [
            f"test -x {_quote(recipe_runtime)}/node_modules/.bin/recipes",
            f"test -x {_quote(recipe_runtime)}/node_modules/.bin/pi",
            f"ln -sf {_quote(recipe_runtime)}/node_modules/.bin/recipes /usr/local/bin/recipes",
            f"ln -sf {_quote(recipe_runtime)}/node_modules/.bin/pi /usr/local/bin/pi",
        ] if recipe_runtime else [
            "npm i -g @introspection-ai/pi-recipes",
            "command -v pi >/dev/null || npm i -g @earendil-works/pi-coding-agent",
        ]
        agent_commands = [
            f"recipes install {_quote(recipe_source)} --no-setup",
            "recipes setup",
        ]

        for command in root_commands:
            await self.exec_as_root(environment, command)
        for command in runtime_commands:
            await self.exec_as_root(environment, command)
        for command in agent_commands:
            await self.exec_as_agent(environment, command)

    @with_prompt_template
    async def run(self, instruction: str, environment: Any, context: Any = None) -> None:
        recipe_name = _env("PI_RECIPE_NAME")
        agent_name = os.environ.get("PI_RECIPE_AGENT")
        command = ["pi", "--mode", "json", "--recipe", recipe_name]
        if agent_name:
            command.extend(["--agent", agent_name])
        command.extend(["-p", instruction])
        result = await self.exec_as_agent(
            environment, " ".join(_quote(part) for part in command)
        )
        self._write_trajectory(
            stdout=_output_text(result.stdout or ""),
            stderr=_output_text(result.stderr or ""),
            instruction=instruction,
            recipe_name=recipe_name,
            recipe_agent=agent_name,
            context=context,
        )

    def populate_context_post_run(self, context: Any) -> None:
        return None

    def _write_trajectory(
        self,
        *,
        stdout: str,
        stderr: str,
        instruction: str,
        recipe_name: str,
        recipe_agent: str | None,
        context: Any,
    ) -> None:
        logs_dir = Path(self.logs_dir or ".")
        logs_dir.mkdir(parents=True, exist_ok=True)
        (logs_dir / "pi-events.jsonl").write_text(stdout, encoding="utf-8")
        if stderr:
            (logs_dir / "pi-stderr.log").write_text(stderr, encoding="utf-8")

        events, skipped_lines = _parse_events(stdout)
        if skipped_lines:
            (logs_dir / "pi-events-skipped.log").write_text(
                "\n".join(skipped_lines), encoding="utf-8"
            )

        trajectory = _pi_events_to_trajectory(
            events,
            instruction=instruction,
            recipe_name=recipe_name,
            recipe_agent=recipe_agent,
            adapter_version=self.VERSION,
            skipped_lines=skipped_lines,
        )
        (logs_dir / "trajectory.json").write_text(
            json.dumps(trajectory.to_json_dict(), indent=2), encoding="utf-8"
        )

        if context is not None and trajectory.final_metrics is not None:
            context.n_input_tokens = trajectory.final_metrics.total_prompt_tokens
            context.n_cache_tokens = trajectory.final_metrics.total_cached_tokens
            context.n_output_tokens = trajectory.final_metrics.total_completion_tokens
            context.cost_usd = trajectory.final_metrics.total_cost_usd
            context.metadata = {
                **(context.metadata or {}),
                "trajectory_path": str(logs_dir / "trajectory.json"),
            }
