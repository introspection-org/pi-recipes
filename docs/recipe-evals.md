# Recipe eval declarations

A Recipe may pin offline evaluation suites without owning the evaluation
runner. The declaration makes quality inputs portable and reproducible; a host
or external tool decides when and where to execute them.

## Registry suite

```json
{
  "pi": {
    "evals": {
      "suites": [
        {
          "name": "smoke",
          "type": "registry",
          "dataset": "acme/coding-smoke",
          "version": "1.2.0"
        }
      ]
    }
  }
}
```

Registry suites MUST pin an exact dataset version. Mutable aliases such as
`latest` are invalid.

## Git suite

```json
{
  "pi": {
    "evals": {
      "suites": [
        {
          "name": "terminal",
          "type": "git",
          "repo": "https://github.com/acme/agent-evals.git",
          "rev": "4f7c2b0d6d8a...",
          "dataset": "terminal"
        }
      ]
    }
  }
}
```

Git suites SHOULD pin a commit SHA. The dataset path MUST stay inside the
checkout.

## Validation

```bash
introspection check
```

The validator checks declaration shape, unique suite names, immutable pins,
safe paths, and supported suite types without cloning or running the suite.

## Runtime boundary

Recipe sessions do not load or execute eval suites. The declaration belongs to
the portable artifact because it identifies the authored evidence associated
with that agent. Harbor, CI, Introspection, or another evaluation system may
adapt that declaration into its own execution model.

The selected Recipe agent remains the source of truth for model and behavior.
An eval runner MUST make any override explicit rather than silently changing
the agent under test.
