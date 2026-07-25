"""Serve a recipe on Modal.

Place this file next to your recipe's Dockerfile (`recipes create`
scaffolds one) and `modal deploy modal_app.py`.
"""

import modal

app = modal.App("recipe-serve")

image = modal.Image.from_dockerfile("Dockerfile")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("recipe-secrets")],
    # A Pi session per task; keep the container warm between turns.
    scaledown_window=600,
)
@modal.web_server(8888, startup_timeout=120)
def serve() -> None:
    # The image CMD does not run under @modal.web_server; start explicitly.
    import subprocess

    subprocess.Popen(
        ["npx", "recipes", "serve", ".", "--host", "0.0.0.0", "--port", "8888"],
        cwd="/recipe",
    )
