#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.RECIPE_CHECK_PLATFORM ?? process.platform;
const arch = process.env.RECIPE_CHECK_ARCH ?? process.arch;
const exe = platform === "win32" ? "recipe-check.exe" : "recipe-check";
const cargoTarget = process.env.CARGO_BUILD_TARGET;
const source =
  process.env.RECIPE_CHECK_BIN ??
  resolve(root, "target", ...(cargoTarget ? [cargoTarget] : []), "release", exe);

if (!existsSync(source)) {
  throw new Error(`recipe-check build output not found: ${source}`);
}

// Into the per-platform package rather than vendor/, so each publish carries
// exactly one binary. The old layout put all five in the main tarball, and npm
// has no partial install: every consumer downloaded ~11MB to run one of them.
const targetDir = resolve(root, "packages", `recipe-check-${platform}-${arch}`);
if (!existsSync(resolve(targetDir, "package.json"))) {
  throw new Error(
    `No package for ${platform}-${arch} at ${targetDir}. Add it to packages/ and to optionalDependencies in the root package.json.`
  );
}
const target = resolve(targetDir, basename(exe));
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
if (platform !== "win32") chmodSync(target, 0o755);
console.log(`Packaged ${source} -> ${target}`);
