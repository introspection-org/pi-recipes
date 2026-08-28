import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadRecipeConnectors } from "../src/connector-tools.js";
import { readPiPackageManifest } from "../src/recipe-package.js";

describe("Recipe connector packages", () => {
  const cleanups: string[] = [];

  afterEach(() => {
    for (const path of cleanups.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("loads provider and tool metadata from the declared package", async () => {
    const recipeDir = mkdtempSync(join(tmpdir(), "recipe-connector-package-"));
    cleanups.push(recipeDir);
    const connectorPackage = "@example/recipe-connector-custom";
    const connectorDir = join(
      recipeDir,
      "node_modules",
      "@example",
      "recipe-connector-custom"
    );
    mkdirSync(connectorDir, { recursive: true });
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "custom-connector-recipe",
        version: "0.1.0",
        dependencies: { [connectorPackage]: "0.1.0" },
        pi: {
          connectors: [
            {
              provider: "custom",
              package: connectorPackage,
              tools: { include: ["ping"] },
            },
          ],
        },
      })
    );
    writeFileSync(
      join(connectorDir, "package.json"),
      JSON.stringify({
        name: connectorPackage,
        version: "0.1.0",
        type: "module",
        exports: "./index.js",
      })
    );
    writeFileSync(
      join(connectorDir, "index.js"),
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
    });
    expect(loaded.extensions).toHaveLength(1);
  });
});
