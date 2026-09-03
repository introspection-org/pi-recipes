import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadRecipeConnectors } from "../src/connector-tools.js";
import {
  readPiPackageManifest,
  type RecipePackageManifest,
} from "../src/recipe-package.js";

describe("Recipe connector packages", () => {
  const cleanups: string[] = [];

  afterEach(() => {
    for (const path of cleanups.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("accepts public manifests created before connectors were added", async () => {
    const manifest: RecipePackageManifest = {
      name: "existing-recipe",
      version: "1.0.0",
      path: "/tmp/existing-recipe",
      resources: { agents: [], extensions: [], skills: [], prompts: [] },
      mcp: { manifests: [], servers: [] },
    };

    await expect(
      loadRecipeConnectors(manifest, [], { recipeDir: manifest.path })
    ).resolves.toEqual({
      loadout: {
        toolNames: [],
        initialActiveToolNames: [],
        deferredToolNames: [],
        declaredToolNames: [],
      },
      extensions: [],
    });
  });

  it("loads provider and tool metadata from the declared package", async () => {
    const recipeDir = mkdtempSync(join(tmpdir(), "recipe-channel-package-"));
    cleanups.push(recipeDir);
    const channelPackage = "@introspection-ai/recipe-channel-custom";
    const channelDir = join(
      recipeDir,
      "node_modules",
      "@introspection-ai",
      "recipe-channel-custom"
    );
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "custom-connector-recipe",
        version: "0.1.0",
        dependencies: { [channelPackage]: "0.1.0" },
        pi: {
          connectors: [{ provider: "custom" }],
        },
      })
    );
    writeFileSync(
      join(channelDir, "package.json"),
      JSON.stringify({
        name: channelPackage,
        version: "0.1.0",
        type: "module",
        exports: { import: "./index.js" },
      })
    );
    writeFileSync(
      join(channelDir, "index.js"),
      [
        "export default {",
        '  provider: "custom",',
        "  tools: [",
        '    { id: "ping", name: "package_owned_ping", defaultActive: false },',
        "  ],",
        "  createExtension() { return () => {}; },",
        "};",
        "",
      ].join("\n")
    );

    const loaded = await loadRecipeConnectors(
      readPiPackageManifest(recipeDir),
      ["package_owned_ping"],
      { recipeDir }
    );

    expect(loaded.loadout).toEqual({
      toolNames: ["package_owned_ping"],
      initialActiveToolNames: [],
      deferredToolNames: ["package_owned_ping"],
      declaredToolNames: ["package_owned_ping"],
    });
    expect(loaded.extensions).toHaveLength(1);
  });
});
