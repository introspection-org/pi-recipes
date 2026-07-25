# Modal

Host the served recipe as a Modal web server. Modal builds the recipe's
own Dockerfile; secrets carry the provider keys.

```bash
pip install modal
modal secret create recipe-secrets \
  ANTHROPIC_API_KEY=sk-... RECIPES_SERVE_TOKEN=change-me
modal deploy modal_app.py
```

See [`modal_app.py`](modal_app.py). The URL Modal prints is the Tasks API
base URL; pass `RECIPES_SERVE_TOKEN` as the bearer.
