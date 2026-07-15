// Best-effort telemetry for the recipes directory at https://pi.recipes.
// Installs send only anonymous counters. Public publishes submit public package
// metadata so the directory can catalogue recipes. Telemetry never blocks or
// fails a recipe command.

import type { InstalledRecipe } from "./recipe-store.js";
import type { RecipePackageResources } from "./recipe-package.js";
import { piRecipesPackageMetadata } from "./package-info.js";

export const DEFAULT_TELEMETRY_ENDPOINT = "https://pi.recipes/api/installs";
export const DEFAULT_CATALOG_ENDPOINT = "https://pi.recipes/api/catalog/recipes";

const TELEMETRY_TIMEOUT_MS = 1500;

export type FetchImpl = typeof fetch;

export interface InstallTelemetryOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
}

export interface PublishTelemetryOptions extends InstallTelemetryOptions {
  endpoint?: string;
}

export interface PublishTelemetryRecipe {
  name: string;
  version: string;
  description?: string;
  source: string;
  resources: Record<keyof RecipePackageResources, number>;
}

/**
 * Returns true when the user has opted out of recipe telemetry.
 * Honors the cross-tool `DO_NOT_TRACK` convention plus a package-specific
 * `PI_RECIPES_NO_TELEMETRY` escape hatch.
 */
export function telemetryDisabled(env: NodeJS.ProcessEnv): boolean {
  return isTruthy(env.DO_NOT_TRACK) || isTruthy(env.PI_RECIPES_NO_TELEMETRY);
}

export function telemetryEndpoint(env: NodeJS.ProcessEnv): string {
  const configured = env.PI_RECIPES_TELEMETRY_ENDPOINT?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_TELEMETRY_ENDPOINT;
}

export function catalogEndpoint(env: NodeJS.ProcessEnv): string {
  const configured = env.PI_RECIPES_CATALOG_ENDPOINT?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_CATALOG_ENDPOINT;
}

/**
 * Send a single anonymous install ping. Resolves once the request settles or
 * the timeout elapses; all network and serialization errors are swallowed so a
 * telemetry failure can never break `recipes install`.
 */
export async function sendInstallTelemetry(
  recipe: InstalledRecipe,
  opts: InstallTelemetryOptions = {}
): Promise<void> {
  const piRecipesVersion = piRecipesPackageMetadata().version;
  await postTelemetry(telemetryEndpoint(opts.env ?? process.env), {
    event: "install",
    id: recipe.id,
    name: recipe.name,
    version: recipe.version,
    piRecipesVersion,
  }, opts);
}

/**
 * Submit a public recipe for marketplace cataloguing. The backend owns
 * trust/moderation fields such as `official`; clients submit only public
 * package metadata derived from the GitHub repository and recipe manifest.
 */
export async function sendPublishTelemetry(
  recipe: PublishTelemetryRecipe,
  opts: PublishTelemetryOptions = {}
): Promise<void> {
  const env = opts.env ?? process.env;
  const piRecipesVersion = piRecipesPackageMetadata().version;
  await postTelemetry(opts.endpoint ?? catalogEndpoint(env), {
    event: "publish",
    piRecipesVersion,
    ...recipe,
  }, opts);
}

async function postTelemetry(
  endpoint: string,
  body: Record<string, unknown>,
  opts: InstallTelemetryOptions
): Promise<void> {
  const env = opts.env ?? process.env;
  if (telemetryDisabled(env)) return;

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  try {
    await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Telemetry is best-effort. Never surface failures to the caller.
  } finally {
    clearTimeout(timer);
  }
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}
