# Deploy templates

Each directory hosts the same server — `recipes serve` — in one deploy
target's own idiom. Nothing provider-specific lives in the package; a
template is a few dozen lines you copy next to your recipe.

Target requirements, everywhere:

- Node ≥ 24 and a writable POSIX filesystem with a real shell (the `bash`
  tool), which rules out edge/isolate runtimes.
- Outbound HTTPS to your model providers and any bound MCP endpoints.
- Unbuffered response streaming (SSE).

Configuration is environment-only:

| Env | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … | Provider credentials (see `recipes inspect --json` → `credential_env`) |
| the `${VAR}`s from `.pi/mcp.local.json` | MCP endpoint bindings (`recipes inspect --json` → `mcp_env`) |
| `RECIPES_SERVE_TOKEN` | Inbound bearer; unset → auth disabled |
| `PI_ASK_USER_AUTO_APPROVE` | Headless ask resolution |
| `OTEL_EXPORTER_OTLP_*` | Optional: export run traces (OTel GenAI semconv) to any OTLP backend |
| `INTROSPECTION_TOKEN` | Optional: export the same traces to Introspection (`INTROSPECTION_BASE_OTEL_URL` overrides the ingest URL) |

| Template | Notes |
| --- | --- |
| [`docker/`](docker) | The scaffolded Dockerfile; reference for Fly, Cloud Run, Railway, plain Kubernetes — anything that runs a container and exposes a port |
| [`modal/`](modal) | `modal.Image.from_dockerfile(...)` + `@modal.web_server(8888)` |
| [`daytona/`](daytona) | Snapshot from the image, `recipes serve` as the entry process, port via the preview URL |
| [`vercel-sandbox/`](vercel-sandbox) | Vercel **Sandbox** (not plain functions): recipes need a writable workspace and a real shell |
