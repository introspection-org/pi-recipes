# Daytona

Run the served recipe in a Daytona sandbox: build a snapshot from the
recipe image, start `recipes serve` as the entry process, and reach it
through the sandbox preview URL.

```bash
pip install daytona
export DAYTONA_API_KEY=...
python daytona_app.py
```

See [`daytona_app.py`](daytona_app.py). Daytona's preview link fronts port
8888; pass `RECIPES_SERVE_TOKEN` as the bearer when calling the Tasks API.
