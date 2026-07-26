#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.RECIPE_CHECK_PLATFORM ?? process.platform;
const arch = process.env.RECIPE_CHECK_ARCH ?? process.arch;
const executable = platform === "win32" ? "recipe-check.exe" : "recipe-check";
const cargoTarget = process.env.CARGO_BUILD_TARGET;
const source =
  process.env.RECIPE_CHECK_BIN ??
  resolve(
    root,
    "target",
    ...(cargoTarget ? [cargoTarget] : []),
    "release",
    executable
  );
if (!existsSync(source)) {
  throw new Error(`recipe-check build output not found: ${source}`);
}
const targetDir = resolve(
  root,
  "vendor",
  "recipe-check",
  `${platform}-${arch}`
);
const target = resolve(targetDir, executable);
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
if (platform !== "win32") chmodSync(target, 0o755);
console.log(`Packaged ${source} -> ${target}`);
