# Recipe judge definitions

Recipe judges are optional, recipe-owned LLM grading definitions. Author them
as direct children of `judges/` using a lowercase `.yaml` or `.yml` extension:

```text
my-recipe/
  judges/
    helpful.yaml
```

Nested files such as `judges/calibration/helpful.yaml` are not judge sources.
The standalone `recipe-check` binary and in-memory bindings discover the same
direct-child set. The npm `recipes check` command intentionally omits judge
diagnostics and resource counts from its user-facing output; hosted import
validation consumes the unfiltered binding report.

## Ownership boundary

`pi-recipe-check` owns the portable authored YAML specification and its static,
file-oriented diagnostics. The I/O-free `check_recipe_files` core is shared by
the filesystem checker, serialized snapshot API, and Python binding. The npm
CLI invokes the filesystem checker but filters judge results at its presentation
boundary; this does not change the underlying report used by hosted validators.

The Introspection judge engine owns runtime evaluation: applicability
execution, conversation assembly and transcript protection, model request
construction, retries, verdict normalization, and evaluation identity. Runtime
implementations should consume or remain explicitly compatible with the
authored specification defined here; new authored fields must land in this
checker and its contract tests rather than being introduced only in a runtime
parser.

The Rust checker and Python binding return a `Report` containing diagnostics
and, when judges exist, a `resources.judges` source count. The report does not
contain a normalized judge definition, `judge_id`, `definition_hash`, or
registry projection. Migrating project-scoped registry projection away from
the runtime parser is a separate platform change and must not add project or
tenant context to this portable API.

## Definition shape

The minimal definition is:

```yaml
judge: helpful

instructions: |
  Determine whether the assistant answered the user correctly.

llm:
  model: gpt-5
```

`judge`, `instructions`, and `llm.model` are required and non-empty. Judge names
must be unique across all judge files in one recipe. `llm.provider` defaults to
`openai` at runtime.

The canonical expanded definition is:

```yaml
judge: helpful
description: Did the assistant answer correctly?

on:
  - event: message
    match:
      role: assistant

instructions: |
  Determine whether the assistant answered the user correctly.

llm:
  provider: openai
  model: gpt-5
  request:
    temperature: 0
    max_tokens: 1024
    reasoning_effort: medium
  transport:
    timeout_ms: 60000
    max_retries: 2
    max_retry_delay_ms: 5000
  local:
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
```

Unknown fields are errors at every level. The obsolete top-level `model:`
block is rejected.

### LLM settings

- `provider` is a 1-64 byte lowercase slug containing ASCII letters, digits,
  and hyphens. The portable checker does not restrict it to managed platform
  providers because custom slugs can be used with an explicit local endpoint.
- `model` is a trimmed, non-empty string of at most 255 bytes.
- `request.temperature` is a finite number from 0 through 2 and defaults to 0.
- `request.max_tokens` is an integer from 1 through 131072 when present;
  explicit `null` is treated as omitted.
- `request.reasoning_effort` is a 1-64 byte lowercase slug containing ASCII
  letters and hyphens; explicit `null` is treated as omitted.
- `transport.timeout_ms` is an integer from 1 through 600000 and defaults to
  60000.
- `transport.max_retries` is an integer from 0 through 10 and defaults to 0.
- `transport.max_retry_delay_ms` is an integer from 0 through 60000 and
  defaults to 5000.
- `local` requires both `base_url` and `api_key_env`. The URL must be HTTP(S),
  have a host, contain no embedded credentials, query, or fragment, and use
  HTTPS unless it targets `localhost`, `127.0.0.1`, or `::1`. `api_key_env` is
  an environment-variable name, not a credential value.

Transport and local settings affect execution but not authored grading
identity. The platform judge engine remains responsible for applying defaults,
building requests, and enforcing runtime routing.

## Applicability

`on` is optional. Omission, an empty mapping, or an empty list makes the judge
applicable to every conversation selected for judging. Otherwise it is an
OR-list of matchers. Supported events are `message`, `tool`, and `feedback`;
fields within one `match` mapping are ANDed by the runtime engine.

```yaml
on:
  - event: message
    match:
      role: user
      text: /refund|invoice/i
  - event: tool
    match:
      name: shell
      args.command: /pytest/i
  - event: feedback
    match:
      sentiment: negative
```

Match keys are non-empty field paths. Regex literals use Rust regex syntax and
support unique `i`, `m`, `s`, and `u` flags. `environment`, `runtime_group`, and
paths ending in `pattern_id` are platform-owned and cannot appear as authored
match fields. The runtime engine owns dotted-path traversal and actual gate
evaluation.

## Diagnostics

Invalid recipe content is reported through the normal `Report`/`Diagnostic`
model. Judge diagnostics use stable `judge.*` codes, recipe-relative source
paths, useful help text, and deterministic ordering. YAML syntax failures use
`judge.yaml_malformed` and include a 1-based source span when the parser
provides one. Invalid definitions do not raise a separate content exception in
the Python binding; they return `Report(valid=False, ...)` like other recipe
errors.
