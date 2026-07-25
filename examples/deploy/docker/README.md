# Docker

The reference deployment — the same Dockerfile `recipes create` scaffolds.
Works verbatim on any port-exposing container host: Fly, Cloud Run,
Railway, plain Kubernetes.

```bash
cd my-recipe
docker build -t my-recipe .
docker run -p 8888:8888 \
  -e ANTHROPIC_API_KEY \
  -e RECIPES_SERVE_TOKEN=change-me \
  my-recipe
```

Smoke it:

```bash
curl http://127.0.0.1:8888/health
curl -H "Authorization: Bearer change-me" http://127.0.0.1:8888/config
curl -sS -X POST http://127.0.0.1:8888/v1/tasks \
  -H "Authorization: Bearer change-me" -H "content-type: application/json" \
  -d '{"prompt": "hello"}'
```

See [`Dockerfile`](Dockerfile). The container must not buffer responses —
if you front it with nginx, keep `proxy_buffering off` for `/v1/`.
