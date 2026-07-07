# Recipe Evals

Recipes can declare Harbor offline eval suites in `package.json#pi.evals`.
The recipe does not vendor eval datasets. Instead, it records exact references
to external Harbor datasets, so a recipe commit determines the eval bytes
without bloating installs or image builds.

## Manifest

Use `pi.evals.suites`:

```json
{
  "name": "coding-agent",
  "version": "0.1.0",
  "pi": {
    "evals": {
      "suites": [
        {
          "name": "smoke",
          "type": "registry",
          "dataset": "acme/coding-smoke",
          "version": "1.0.0"
        },
        {
          "name": "terminal-bench-2-1",
          "type": "registry",
          "dataset": "terminal-bench/terminal-bench-2-1",
          "version": "6"
        },
        {
          "name": "repo-tasks",
          "type": "git",
          "repo": "https://github.com/acme/coding-agent-evals.git",
          "rev": "abcdef1234567890",
          "dataset": "smoke"
        }
      ]
    }
  }
}
```

Registry suites use:

- `name`: unique suite name in this recipe.
- `type`: `registry`.
- `dataset`: Harbor registry dataset, such as `org/dataset`.
- `version`: explicit Harbor registry tag, such as `1.0.0` or `6`.

Harbor dataset versions are registry tags, not necessarily SemVer. For example,
Terminal-Bench 2.1 is published as `terminal-bench/terminal-bench-2-1@6` on
Harbor Hub. Recipe manifests must pin the tag explicitly instead of relying on
the mutable `latest` alias.

Git suites use:

- `name`: unique suite name in this recipe.
- `type`: `git`.
- `repo`: Git repository containing a Harbor `registry.json`.
- `rev`: exact 7 to 40 character hex commit SHA.
- `dataset`: dataset name inside the Harbor registry.

`recipes doctor` validates the schema offline. It rejects registry aliases such
as `latest`, version ranges, wildcard versions, branch-like Git refs, missing
registry datasets, malformed suite entries, and duplicate suite names. It does
not contact Git or the Harbor registry; missing repositories or datasets surface
when Harbor runs.

## Exact Pins

Treat `pi.evals.suites` like a lock. For registry suites, pin a concrete Harbor
tag and do not use `latest`, ranges, or wildcards. For Git suites, pin a commit
SHA instead of a branch or tag. The convention is the one-variable rule: a
commit changes either recipe behavior or an eval pin, but not both. When you
intentionally update an eval pin, make that its own commit or pull request,
re-run the baseline, and record the changed results in the review notes.

Pin-bump linting and comparison tooling are intentionally deferred. For now,
the rule is documented and enforced during review.

## Run Evals

Run all pinned suites:

```bash
recipes evals run ./coding-agent
```

Run one suite:

```bash
recipes evals run ./coding-agent --suite smoke
```

Inspect commands without executing Harbor:

```bash
recipes evals run ./coding-agent --dry-run
recipes evals run ./coding-agent --dry-run --json
```

List declared suites:

```bash
recipes evals list ./coding-agent
```

Clone git-backed eval suites for local editing:

```bash
recipes evals clone ./coding-agent ./evals --suite smoke
```

During eval development, bypass manifest pins and run a local Harbor dataset
directory:

```bash
recipes evals run ./coding-agent --dataset-path ~/recipe-examples/coding-agent-evals --dry-run
```

This is dev mode. It is useful before a dataset repository has a stable commit
SHA, but release-ready recipes should use pinned suites in `package.json`.

When a local eval set is ready to share, publish the dataset separately from the
recipe. For Git-hosted evals, commit the Harbor registry repository and pin the
commit SHA in a `git` suite. For Harbor Hub evals, publish the dataset and pin
the registry tag in a `registry` suite. The dataset contains task definitions,
instructions, tests, Dockerfiles, or prebuilt image references; it does not
contain recipe-specific bind mounts.

Arguments after `--` are passed through to the underlying `harbor run`
invocation. This is useful for local filters and environment experiments:

```bash
recipes evals run ./coding-agent --suite smoke -- --task acme/one
```

Keep these passthrough arguments out of the recipe manifest. Published recipe
eval suites should be runnable by the selected Harbor environment without
recipe-specific environment mutation; use passthrough args or direct Harbor runs
for local platform, compose, or cloud sandbox experiments.

## Harbor Adapter

`recipes evals` runs Harbor with the packaged Pi adapter:

```text
harbor run ... --agent pi_recipe_agent:PiRecipeAgent
```

The CLI passes Harbor flags for:

- the selected pinned registry, pinned Git registry, or local development
  dataset.
- `--agent pi_recipe_agent:PiRecipeAgent`.
- `--mounts`: read-only bind mounts for the local recipe source and, during
  executed runs, the host-prepared Pi runtime. Dry runs do not prepare the
  runtime and therefore only print the recipe source mount.

The CLI sets these environment variables for the Harbor process:

- `PI_RECIPE_SOURCE`: container path for the mounted recipe source.
- `PI_RECIPE_NAME`: package name from `package.json`.
- `PI_RECIPE_AGENT`: optional selected recipe agent when provided by the
  environment.
- `PI_RECIPE_RUNTIME`: container path for the mounted Pi runtime.
- `PYTHONPATH`: the packaged `harbor/` adapter directory.

The bind mounts are an invocation detail. They are not written into local,
Git-hosted, or Harbor-published datasets. This keeps eval datasets reusable
against any recipe checkout while letting the harness evaluate the local recipe
and local `pi-recipes` implementation under test.

Inside the Harbor task container, the adapter links the mounted Pi runtime,
registers `PI_RECIPE_SOURCE`, and runs:

```bash
pi --mode json --recipe "$PI_RECIPE_NAME" -p "$instruction"
```

The adapter converts Pi's documented JSON event stream into Harbor's Agent
Trajectory Interchange Format (ATIF) and writes:

```text
<recipe>/jobs/<job>/<trial>/agent/trajectory.json
<recipe>/jobs/<job>/<trial>/agent/pi-events.jsonl
```

`trajectory.json` drives the Harbor trajectory viewer. `pi-events.jsonl` is kept
as the source event stream for debugging adapter conversions.

Harbor owns result storage and reporting. The recipe CLI only resolves suites,
validates pins, and launches Harbor. By default Harbor runs with the recipe
directory as its working directory, so results are written under
`<recipe>/jobs/...` and can be viewed with:

```bash
harbor view ./jobs
```

The recipe agent YAML owns model selection. `recipes evals run` does not expose a
model override knob because Harbor should evaluate the recipe as declared. To
test another model, change the recipe agent in a separate commit and run evals
against that recipe revision.

The recipe harness does not attempt to solve task image architecture
compatibility. If a published Harbor task declares a prebuilt Docker image, that
image must already be runnable by the selected Harbor environment. Use a
compatible local Docker setup or a compatible cloud/sandbox environment for
those datasets.
