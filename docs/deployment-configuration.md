# Deployment configuration

How a recipe declares what its tasks need from the platform that runs them —
compute resources and scratch disk — and what an implementing platform does
with those declarations.

This spec is defined here, in pi-recipes, because it describes *recipe
intent*: portable, platform-neutral declarations that any host can honor.
The validation grammar lives in `pi_recipe_check::resources`
(`validate_resources`, `validate_disk`) so every host — the recipes CLI, a
platform's manifest validator, wasm/Python bindings — applies identical
rules with stable diagnostic codes. Platform-specific enforcement (floors,
caps, billing) is the implementer's job, not part of the grammar.

## Where the declarations live

Recipe *package* contents (`package.json#pi`, `agents/*.yaml`) are
materialized inside a running sandbox, after the machine that runs them
already exists — so deployment configuration cannot live there. It lives in
the host's deployment manifest, the file the platform reads *before*
provisioning. On Introspection that is the repo-root
`.introspection/<slug>.yaml` manifest's `runtime:` block:

```yaml
runtime:
  resources:
    requests: { cpu: 500m, memory: 1.5Gi, storage: 10Gi }
    limits: { cpu: 1500m, memory: 1.5Gi }
```

## `resources`

Kubernetes-style `requests`/`limits` (`validate_resources`). Grammar:
`500m` millicores or decimal cores for CPU; bytes with binary
(`Ki`/`Mi`/`Gi`/`Ti`) or decimal (`k`/`M`/`G`/`T`) suffixes for memory and
storage (`0.1T` works). A request must not exceed its limit.

`storage` is the sandbox scratch-volume size and follows the PVC
convention (`spec.resources.requests.storage`): request-only — declaring
it under `limits` is rejected. Whether the scratch volume is persistent
(survives sandbox teardown for warm restore) or ephemeral stays a
*deployment* setting on the implementing platform — the recipe only sizes
it. Future io characteristics (e.g. a storage class) would be siblings in
the manifest, mirroring how Kubernetes expresses them outside the
quantity.

## How Introspection implements this

The reference implementation treats every declaration as an **upward
request** merged onto deployment-configured floors:

- cpu/memory requests: `max(recipe, deployment floor)`, capped by a
  schedulability guard; limits raise to the resolved request.
- `requests.storage`: taken as declared — rounded up to whole GiB
  (smaller scratch bills less; 1Gi is the validated minimum) and capped
  at 300 GiB; undeclared uses the deployment default (10 GiB). Applied to
  the sandbox's scratch volume (a persistent PVC when the deployment
  enables warm storage, ephemeral emptyDir at the same mount path
  otherwise).

Invalid declarations fail manifest validation at push — a recipe never
silently spawns with defaults because of a typo. Other platforms may
choose different enforcement; the declarations and their grammar are the
portable part.
