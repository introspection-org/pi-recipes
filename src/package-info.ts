import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_PACKAGE_NAME = "@introspection-ai/pi-recipes";
const FALLBACK_PACKAGE_VERSION = "0.0.0";

interface PackageMetadata {
  name: string;
  version: string;
}

let cachedMetadata: PackageMetadata | undefined;

function packageRoot(): string {
  const filename = fileURLToPath(import.meta.url);
  return resolve(dirname(filename), "..");
}

export function piRecipesPackageMetadata(): PackageMetadata {
  if (cachedMetadata) return cachedMetadata;
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    cachedMetadata = {
      name: typeof pkg.name === "string" ? pkg.name : FALLBACK_PACKAGE_NAME,
      version: typeof pkg.version === "string" ? pkg.version : FALLBACK_PACKAGE_VERSION,
    };
  } catch {
    cachedMetadata = {
      name: FALLBACK_PACKAGE_NAME,
      version: FALLBACK_PACKAGE_VERSION,
    };
  }
  return cachedMetadata;
}
