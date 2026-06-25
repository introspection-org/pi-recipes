// Anonymous, fire-and-forget install telemetry for the recipes directory at
// https://pi.recipes. We send only the canonical recipe id, name, and version
// so the directory can rank recipes by install count. No paths, no user
// identifiers, no PII. Telemetry never blocks or fails an install.

import type { InstalledRecipe } from "./recipe-store.js";

export const DEFAULT_TELEMETRY_ENDPOINT = "https://pi.recipes/api/installs";

const TELEMETRY_TIMEOUT_MS = 1500;

export type FetchImpl = typeof fetch;

export interface InstallTelemetryOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
}

/**
 * Returns true when the user has opted out of anonymous install telemetry.
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

/**
 * Send a single anonymous install ping. Resolves once the request settles or
 * the timeout elapses; all network and serialization errors are swallowed so a
 * telemetry failure can never break `recipes install`.
 */
export async function sendInstallTelemetry(
  recipe: InstalledRecipe,
  opts: InstallTelemetryOptions = {}
): Promise<void> {
  const env = opts.env ?? process.env;
  if (telemetryDisabled(env)) return;

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  try {
    await fetchImpl(telemetryEndpoint(env), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "install",
        id: recipe.id,
        name: recipe.name,
        version: recipe.version,
      }),
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
