import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  ensureMcpDaemon,
  exchangeMcpDaemon,
  mcpDaemonEnvironment,
} from "./mcp-daemon-client.js";
import type { McpCatalogServer } from "./mcp-daemon-protocol.js";

const DEFAULT_CATALOG_ATTEMPT_TIMEOUT_MS = 5_000;
const CATALOG_PRELOAD_BACKOFF_MS = [100, 250, 500, 1_000, 2_000] as const;
const catalogPreloads = new Map<string, Promise<McpCatalogServer[]>>();

function preloadKey(env: NodeJS.ProcessEnv): string {
  const { socketPath, fingerprint } = mcpDaemonEnvironment(env);
  return `${socketPath}\0${fingerprint}`;
}

export function preloadMcpCatalogs(options: {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
} = {}): Promise<McpCatalogServer[]> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CATALOG_ATTEMPT_TIMEOUT_MS;
  const key = preloadKey(env);
  const existing = catalogPreloads.get(key);
  if (existing) return existing;

  const requestCatalogs = async (): Promise<McpCatalogServer[]> => {
    await ensureMcpDaemon(env);
    const { token, fingerprint } = mcpDaemonEnvironment(env);
    const id = randomUUID();
    let catalogs: McpCatalogServer[] | undefined;
    let daemonError: string | undefined;
    await exchangeMcpDaemon(
      { type: "catalog", id, token, fingerprint, timeoutMs },
      (envelope, socket) => {
        if ("catalogs" in envelope) {
          catalogs = envelope.catalogs;
          socket.end();
        } else if ("error" in envelope) {
          daemonError = envelope.error;
          socket.end();
        }
      },
      env
    );
    if (daemonError) throw new Error(`MCP daemon: ${daemonError}`);
    if (!catalogs) throw new Error("MCP daemon returned no catalog result.");
    return catalogs;
  };
  const preload = (async () => {
    let latest: McpCatalogServer[] = [];
    let latestError: unknown;
    for (let attempt = 0; attempt <= CATALOG_PRELOAD_BACKOFF_MS.length; attempt += 1) {
      try {
        latest = await requestCatalogs();
        latestError = undefined;
        if (latest.every((server) => !server.error)) return latest;
      } catch (error) {
        latestError = error;
      }
      const backoffMs = CATALOG_PRELOAD_BACKOFF_MS[attempt];
      if (backoffMs === undefined) break;
      await delay(backoffMs);
    }
    if (latestError && latest.length === 0) throw latestError;
    return latest;
  })();
  catalogPreloads.set(key, preload);
  void preload.then(
    (catalogs) => {
      if (
        catalogs.some((server) => server.error) &&
        catalogPreloads.get(key) === preload
      ) {
        catalogPreloads.delete(key);
      }
    },
    () => {
      if (catalogPreloads.get(key) === preload) catalogPreloads.delete(key);
    }
  );
  return preload;
}

export function clearMcpCatalogPreload(env: NodeJS.ProcessEnv = process.env): void {
  try {
    catalogPreloads.delete(preloadKey(env));
  } catch {
    // An incomplete daemon environment has no preload state to clear.
  }
}

export type { McpCatalogServer } from "./mcp-daemon-protocol.js";
