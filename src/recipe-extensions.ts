import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);

function resolvePackage(specifier: string): string | undefined {
  try {
    return import.meta.resolve(specifier);
  } catch {
    // Fall through to CommonJS resolution for packages that do not expose ESM exports.
  }
  try {
    return require.resolve(specifier);
  } catch {
    return undefined;
  }
}

function resolvePackageModuleRoot(specifier: string): string | undefined {
  const resolved = resolvePackage(specifier);
  if (!resolved) return undefined;
  return dirname(resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved);
}

function recipeExtensionAliases(): Record<string, string> {
  // Resolved through a published subpath: this package exposes subpaths only,
  // so there is no root entry to resolve. Any subpath lands in the same
  // directory, which is what the alias needs.
  const recipesRoot = resolvePackageModuleRoot(
    "@introspection-ai/recipes/interactions"
  );
  return Object.fromEntries(
    [
      // Jiti aliases are package-prefix mappings. They must point at the
      // directory containing a package's resolved modules, not an entry file,
      // so Jiti can append exported subpaths without corrupting the path.
      // The self-alias also keeps recipe interaction imports on this package
      // instance, sharing interrupt state with the child-agent runner.
      ["@introspection-ai/recipes", recipesRoot],

      ["@earendil-works/pi-coding-agent", resolvePackageModuleRoot("@earendil-works/pi-coding-agent")],
      ["@earendil-works/pi-agent-core", resolvePackageModuleRoot("@earendil-works/pi-agent-core")],
      ["@earendil-works/pi-ai", resolvePackageModuleRoot("@earendil-works/pi-ai")],
      ["typebox", resolvePackageModuleRoot("typebox")],
      ["@sinclair/typebox", resolvePackageModuleRoot("typebox")],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

function loadJiti(): { createJiti: (url: string, opts: Record<string, unknown>) => { import: (id: string, opts?: { default?: boolean }) => Promise<unknown> } } {
  try {
    return require("jiti") as ReturnType<typeof loadJiti>;
  } catch {
    const piAgentEntry = resolvePackage("@earendil-works/pi-coding-agent");
    if (!piAgentEntry) {
      throw new Error("Unable to resolve @earendil-works/pi-coding-agent for recipe extension loading");
    }
    const piRequire = createRequire(piAgentEntry);
    return piRequire("jiti") as ReturnType<typeof loadJiti>;
  }
}

/**
 * Load a recipe-declared extension module and return its factory. TS sources
 * load through jiti with package aliases pinned to this package's resolved
 * module instances, so recipe extensions share interaction/interrupt state
 * with their host.
 */
export async function loadRecipeExtensionFactory(
  recipeDir: string,
  extensionPath: string
): Promise<ExtensionFactory> {
  const { createJiti } = loadJiti();
  const recipeLoaderUrl = pathToFileURL(join(recipeDir, ".recipe-extension-loader.js")).href;
  const jiti = createJiti(recipeLoaderUrl, {
    moduleCache: false,
    alias: recipeExtensionAliases(),
  });
  const loaded = await jiti.import(extensionPath, { default: true });
  const factory =
    typeof loaded === "function"
      ? loaded
      : loaded && typeof loaded === "object" && "default" in loaded && typeof loaded.default === "function"
        ? loaded.default
        : undefined;
  if (!factory) {
    throw new Error(`Recipe extension does not export a factory function: ${extensionPath}`);
  }
  return factory as ExtensionFactory;
}
