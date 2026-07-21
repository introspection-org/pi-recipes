#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const rootManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const platformPackages = Object.keys(
  rootManifest.optionalDependencies ?? {},
).filter((name) => name.startsWith("@introspection-ai/recipe-check-"));

if (platformPackages.length === 0) {
  throw new Error("No recipe-check platform packages found in package.json");
}

const packDirectory = mkdtempSync(join(tmpdir(), "pi-recipes-pack-"));
try {
  const packResult = JSON.parse(
    execFileSync(
      "pnpm",
      ["pack", "--pack-destination", packDirectory, "--json"],
      { cwd: repositoryRoot, encoding: "utf8" },
    ),
  );
  const archive = resolve(packDirectory, packResult.filename);
  const packedManifest = JSON.parse(
    execFileSync("tar", ["-xOf", archive, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  const packedOptional = packedManifest.optionalDependencies ?? {};

  for (const name of platformPackages) {
    if (packedOptional[name] !== rootManifest.version) {
      throw new Error(
        `${name} must be pinned to ${rootManifest.version} in the packed manifest; found ${packedOptional[name] ?? "no dependency"}.`,
      );
    }
  }

  const leakedWorkspaceRanges = Object.entries(packedOptional).filter(
    ([name, range]) =>
      name.startsWith("@introspection-ai/recipe-check-") &&
      String(range).startsWith("workspace:"),
  );
  if (leakedWorkspaceRanges.length > 0) {
    throw new Error(
      `Packed manifest contains workspace ranges: ${leakedWorkspaceRanges
        .map(([name, range]) => `${name}@${range}`)
        .join(", ")}`,
    );
  }

  console.log(
    `packed recipe-check dependencies pinned at ${rootManifest.version} (${platformPackages.length} platforms)`,
  );
} finally {
  rmSync(packDirectory, { recursive: true, force: true });
}
