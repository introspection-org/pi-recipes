"""Serve a recipe in a Daytona sandbox.

Build the recipe image locally first (see ../docker), push it somewhere
Daytona can pull, then run this once to create the snapshot + sandbox.
"""

import os

from daytona import CreateSandboxFromSnapshotParams, CreateSnapshotParams, Daytona, Image

RECIPE_IMAGE = os.environ.get("RECIPE_IMAGE", "registry.example.com/my-recipe:latest")

daytona = Daytona()

daytona.snapshot.create(
    CreateSnapshotParams(name="my-recipe", image=Image.base(RECIPE_IMAGE)),
    on_logs=print,
)

sandbox = daytona.create(
    CreateSandboxFromSnapshotParams(
        snapshot="my-recipe",
        env_vars={
            "ANTHROPIC_API_KEY": os.environ["ANTHROPIC_API_KEY"],
            "RECIPES_SERVE_TOKEN": os.environ.get("RECIPES_SERVE_TOKEN", ""),
        },
    )
)

sandbox.process.exec(
    "sh -c 'cd /recipe && npx recipes serve . --host 0.0.0.0 --port 8888 &'"
)
print(sandbox.get_preview_link(8888).url)
