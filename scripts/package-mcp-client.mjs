#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.MCP_CLIENT_PLATFORM ?? process.platform;
const arch = process.env.MCP_CLIENT_ARCH ?? process.arch;
if (platform === "win32") {
  console.log("Skipping native MCP client packaging on Windows; the Node client remains available.");
  process.exit(0);
}
const exe = "mcp-client";
const cargoTarget = process.env.CARGO_BUILD_TARGET;
const source =
  process.env.MCP_CLIENT_BIN ??
  resolve(root, "target", ...(cargoTarget ? [cargoTarget] : []), "release", exe);

if (!existsSync(source)) {
  throw new Error(`mcp-client build output not found: ${source}`);
}

const targetDir = resolve(root, "vendor", "mcp-client", `${platform}-${arch}`);
const target = resolve(targetDir, basename(exe));
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
if (platform !== "win32") chmodSync(target, 0o755);
console.log(`Packaged ${source} -> ${target}`);
