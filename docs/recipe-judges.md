# Recipe Judges

Recipe judges live in `judges/*.yaml` beside the agent. They are local,
versioned checks over a rendered conversation transcript.

## Judge YAML

```yaml
judge: clarify_before_search
description: Did the agent clarify before starting an expensive search?
on:
  - event: tool
    match:
      name: deep_search
model:
  name: openai/gpt-4.1
  temperature: 0
instructions: |
  Grade one behavior. Return { reasoning, verdict }.

  pass: the agent clarified when needed, or the request was already specific.
  fail: the request was ambiguous and the agent searched without clarifying.
  not_applicable: there is no real task to judge.
```

The `on` gate is optional. It is an OR over event matchers. Fields inside one
`match` are ANDed against the same message, tool call, or feedback event. Dotted
paths can inspect JSON fields such as `args.command` or `result.status`.

## Calibration Dataset

Calibration rows are JSONL. Each row contains a human label and the same
`JudgeConversation` contract used by the local runner.

```json
{"conversation_id":"c1","label":"pass","split":"test","conversation":{"conversation_id":"c1","contract_version":"1.1","sequence_hash":"...","status":"ok","model":"openai/gpt-4.1","environment":"dev","runtime_group":null,"messages":[],"tool_calls":[],"feedback_events":[],"message_count":0,"tool_call_count":0,"feedback_count":0}}
```

Use a small, balanced train/dev/test set first. The useful loop is:

```bash
recipes judges ./my-recipe verify --dataset ./judges/clarify.calibration.jsonl
recipes judges ./my-recipe render --judge clarify_before_search --dataset ./judges/clarify.calibration.jsonl --split dev
OPENAI_API_KEY=... recipes judges ./my-recipe eval --judge clarify_before_search --dataset ./judges/clarify.calibration.jsonl --split test
```

`verify` catches malformed rows and prints label/split counts. `render` shows
the exact transcript the model grades. `eval` calls an OpenAI-compatible chat
completions endpoint and prints accuracy, Cohen kappa, sensitivity, specificity,
and a pass/fail confusion matrix.

## Gateway Configuration

For OpenAI directly, set:

```bash
OPENAI_API_KEY=...
```

For another OpenAI-compatible gateway, set:

```bash
RECIPES_JUDGE_BASE_URL=http://localhost:4000
RECIPES_JUDGE_API_KEY=...
```

You can also pass `--model` during local calibration to test a judge against a
different model without editing the recipe YAML.

## Run One Conversation

After calibration, run all recipe judges or one selected judge against a local
conversation JSON file:

```bash
recipes judges ./my-recipe run --conversation ./conversation.json
recipes judges ./my-recipe run --judge clarify_before_search --conversation ./conversation.json
```

The conversation file can be either a raw `JudgeConversation` object or a
calibration-style row with a top-level `conversation` field.
