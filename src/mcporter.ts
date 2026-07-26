/**
 * The config shape the bundled `mcp` CLI (mcporter) reads, kept off the
 * published surface.
 *
 * `./mcp` maps straight to `mcp.ts`, so anything exported there is public API.
 * These names describe a vendored dependency rather than the Recipe contract,
 * and no host should have to know them: swapping the CLI should not be a
 * breaking change for consumers.
 */
import { join } from "node:path";

export interface McporterServerConfig {
  baseUrl: string;
  headers: Record<string, string>;
  allowedTools?: string[];
  auth?: "oauth";
  tokenCacheDir?: string;
  clientName?: string;
  oauthClientId?: string;
  oauthClientSecretEnv?: string;
  oauthTokenEndpointAuthMethod?: string;
  oauthRedirectUrl?: string;
  oauthScope?: string;
  httpFetch?: "default" | "node-http1";
}

export interface McporterConfig {
  imports: string[];
  mcpServers: Record<string, McporterServerConfig>;
}

export function defaultMcporterConfigPath(cwd: string): string {
  return join(cwd, ".pi", "mcporter.json");
}
