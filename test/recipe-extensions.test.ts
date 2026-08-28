import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadRecipeExtensionFactory,
  resolvePackageFromHost,
} from "../src/recipe-extensions.js";

describe("recipe extension package resolution", () => {
  const cleanups: string[] = [];

  afterEach(() => {
    for (const path of cleanups.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("resolves Pi peers from the active host installation", () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-host-peer-"));
    cleanups.push(root);
    const realHostEntry = join(
      root,
      "lib",
      "node_modules",
      "pi-host",
      "dist",
      "cli.js"
    );
    const hostEntry = join(root, "bin", "pi");
    const peerEntry = join(
      root,
      "lib",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "index.js"
    );
    mkdirSync(join(realHostEntry, ".."), { recursive: true });
    mkdirSync(join(hostEntry, ".."), { recursive: true });
    mkdirSync(join(peerEntry, ".."), { recursive: true });
    writeFileSync(realHostEntry, "");
    symlinkSync(realHostEntry, hostEntry);
    writeFileSync(peerEntry, "export {};");
    writeFileSync(
      join(peerEntry, "..", "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        version: "0.82.1",
        type: "module",
        exports: { ".": { import: "./index.js" } },
      })
    );

    expect(
      realpathSync(
        resolvePackageFromHost(
          "@earendil-works/pi-coding-agent",
          hostEntry
        ) ?? ""
      )
    ).toBe(realpathSync(peerEntry));
  });

  it("resolves Recipe helper subpaths from the recipe installation", async () => {
    const root = mkdtempSync(join(tmpdir(), "recipes-local-helper-"));
    cleanups.push(root);
    const packageRoot = join(
      root,
      "node_modules",
      "@introspection-ai",
      "recipes"
    );
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@introspection-ai/recipes",
        version: "999.0.0",
        type: "module",
        exports: { "./slack": "./slack.js" },
      })
    );
    writeFileSync(
      join(packageRoot, "slack.js"),
      "export const source = 'recipe-local';"
    );
    const extensionPath = join(root, "extension.mjs");
    writeFileSync(
      extensionPath,
      [
        "import { source } from '@introspection-ai/recipes/slack';",
        "export default function extension() { return source; }",
      ].join("\n")
    );

    const factory = await loadRecipeExtensionFactory(root, extensionPath);

    expect((factory as unknown as () => unknown)()).toBe("recipe-local");
  });
});
