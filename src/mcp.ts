#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolvePiPackageMcpManifestPaths,
  type RecipePackageManifest,
  type RecipePackageMcpConfig,
} from "./recipe-package.js";

export interface McpManifestTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface McpManifestServer {
  id: string;
  name?: string;
  host?: string;
  base_url: string;
  transport?: string;
  tools?: McpManifestTool[];
}

export interface McpManifest {
  servers?: McpManifestServer[];
}

interface LocalMcpServer {
  id?: string;
  name?: string;
  transport?: string;
  url?: string;
  headers?: Record<string, string>;
}

interface BootstrapEndpoint {
  id?: string;
  name?: string;
  host?: string;
  base_url?: string | null;
  kind?: string;
}

interface McpEndpointBinding {
  id: string;
  name: string;
  host: string;
  baseUrl: string;
  headers: Record<string, string>;
  requiresSessionToken: boolean;
}

interface McpCatalog {
  id: string;
  name: string;
  host: string;
  baseUrl: string;
  tools: RemoteMcpTool[];
}

export interface McpDiscoveryDiagnostic {
  serverId: string;
  url: string;
  stage: "config" | "initialize" | "tools/list" | "filter";
  message: string;
  status?: number;
}

interface RemoteMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface WritableLike {
  write(chunk: string): void;
}

interface CliIO {
  stdout: WritableLike;
  stderr: WritableLike;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  fetch: typeof fetch;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc?: string;
  id?: unknown;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolsListResult {
  tools?: RemoteMcpTool[];
}

export interface MaterializeRecipeMcpOptions {
  cwd: string;
  recipeDir: string;
  manifest: RecipePackageManifest;
  agentTools: readonly string[];
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export interface MaterializedMcpManifest extends McpManifest {
  diagnostics?: McpDiscoveryDiagnostic[];
}

const PROTOCOL_VERSION = "2025-03-26";
const RECIPE_ENV_PREFIX = "PI_RECIPES_";
const LEGACY_RUNTIME_ENV_PREFIX = "INTRO" + "SPECTION_";
const MCP_MANIFEST_ENV = `${RECIPE_ENV_PREFIX}MCP_MANIFEST`;
const MCP_LOCAL_CONFIG_ENV = `${RECIPE_ENV_PREFIX}MCP_LOCAL_CONFIG`;
const MCP_BIN_DIR_ENV = `${RECIPE_ENV_PREFIX}MCP_BIN_DIR`;
const LEGACY_MCP_MANIFEST_ENV = `${LEGACY_RUNTIME_ENV_PREFIX}MCP_MANIFEST`;
const LEGACY_MCP_LOCAL_CONFIG_ENV = `${LEGACY_RUNTIME_ENV_PREFIX}MCP_LOCAL_CONFIG`;
const LEGACY_MCP_BIN_DIR_ENV = `${LEGACY_RUNTIME_ENV_PREFIX}MCP_BIN_DIR`;
const BOOTSTRAP_JSON_ENV = `${LEGACY_RUNTIME_ENV_PREFIX}BOOTSTRAP_JSON`;
const TOKEN_ENV = `${LEGACY_RUNTIME_ENV_PREFIX}TOKEN`;
const AGENT_SESSION_TOKEN_ENV = "AGENT_SESSION_TOKEN";

export function defaultMcpManifestPath(cwd: string): string {
  return join(cwd, ".pi", "mcp.json");
}

export function fallbackMcpManifestPath(): string {
  return join(tmpdir(), "pi-recipes", "mcp.json");
}

export function defaultMcpLocalConfigPath(cwd: string): string {
  return join(cwd, ".pi", "mcp.local.json");
}

export function resolveMcpLocalConfigPath(opts: {
  cwd: string;
  recipeDir: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = opts.env ?? process.env;
  const configured = env[MCP_LOCAL_CONFIG_ENV] || env[LEGACY_MCP_LOCAL_CONFIG_ENV];
  if (configured) return configured;

  const workspaceConfig = defaultMcpLocalConfigPath(opts.cwd);
  if (existsSync(workspaceConfig)) return workspaceConfig;

  const recipeConfig = defaultMcpLocalConfigPath(opts.recipeDir);
  return existsSync(recipeConfig) ? recipeConfig : undefined;
}

export function configureMcpLocalConfigPath(opts: {
  cwd: string;
  recipeDir: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = opts.env ?? process.env;
  const path = resolveMcpLocalConfigPath({ ...opts, env });
  if (!path) return undefined;
  env[MCP_LOCAL_CONFIG_ENV] = path;
  env[LEGACY_MCP_LOCAL_CONFIG_ENV] = path;
  return path;
}

export function defaultMcpBinDir(cwd: string): string {
  return join(cwd, ".pi", "bin");
}

export function mcpCliEntrypointPath(): string {
  return fileURLToPath(import.meta.url);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function prependPath(env: NodeJS.ProcessEnv, dir: string): void {
  const key = pathKey(env);
  const current = env[key] ?? "";
  const entries = current.split(delimiter).filter(Boolean);
  if (entries.includes(dir)) return;
  env[key] = [dir, current].filter(Boolean).join(delimiter);
}

export async function materializeSessionMcpCli(opts: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ binDir: string; shimPath: string }> {
  const env = opts.env ?? process.env;
  const binDir = defaultMcpBinDir(opts.cwd);
  const shimPath = join(binDir, "mcp");
  const script = [
    "#!/bin/sh",
    `exec ${shellQuote(process.execPath)} ${shellQuote(mcpCliEntrypointPath())} "$@"`,
    "",
  ].join("\n");
  await mkdir(binDir, { recursive: true });
  await writeFile(shimPath, script);
  await chmod(shimPath, 0o755);
  env[MCP_BIN_DIR_ENV] = binDir;
  env[LEGACY_MCP_BIN_DIR_ENV] = binDir;
  prependPath(env, binDir);
  return { binDir, shimPath };
}

function writeLine(stream: WritableLike, value = ""): void {
  stream.write(`${value}\n`);
}

function manifestPath(env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  return env[MCP_MANIFEST_ENV] || env[LEGACY_MCP_MANIFEST_ENV] || defaultMcpManifestPath(cwd);
}

function localMcpConfigPath(env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  return env[MCP_LOCAL_CONFIG_ENV] || env[LEGACY_MCP_LOCAL_CONFIG_ENV] || defaultMcpLocalConfigPath(cwd);
}

function safeServerId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "mcp";
}

function uniqueServerId(base: string, seen: Set<string>): string {
  const safe = safeServerId(base);
  let candidate = safe;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `${safe}-${suffix}`;
    suffix += 1;
  }
  seen.add(candidate);
  return candidate;
}

function hostForUrl(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function interpolateEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => env[name] ?? "");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function readManifest(env: NodeJS.ProcessEnv, cwd?: string): McpManifest | string {
  const path = manifestPath(env, cwd);
  if (!existsSync(path)) {
    return `No discovered MCP endpoint tools are available for this task (${path} is missing). Discovery may have failed during Pi session startup; check the Recipe MCP warning.`;
  }
  try {
    return readJson(path) as McpManifest;
  } catch (err) {
    return `Failed to read MCP manifest at ${path}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function readLocalMcpServers(env: NodeJS.ProcessEnv, cwd: string): LocalMcpServer[] {
  const path = localMcpConfigPath(env, cwd);
  if (!existsSync(path)) return [];
  try {
    const parsed = readJson(path) as { servers?: unknown };
    return Array.isArray(parsed.servers) ? (parsed.servers as LocalMcpServer[]) : [];
  } catch {
    return [];
  }
}

function bootstrapBindings(env: NodeJS.ProcessEnv): McpEndpointBinding[] {
  if (!env[BOOTSTRAP_JSON_ENV]) return [];
  let parsed: { endpoints?: BootstrapEndpoint[] };
  try {
    parsed = JSON.parse(env[BOOTSTRAP_JSON_ENV]) as { endpoints?: BootstrapEndpoint[] };
  } catch {
    return [];
  }
  return (parsed.endpoints ?? [])
    .filter((endpoint) => endpoint.kind === "mcp" && !!endpoint.base_url)
    .map((endpoint) => {
      const baseUrl = endpoint.base_url as string;
      const label = endpoint.name ?? endpoint.host ?? baseUrl;
      return {
        id: safeServerId(endpoint.id ?? label),
        name: label,
        host: endpoint.host ?? hostForUrl(baseUrl),
        baseUrl,
        headers: {},
        requiresSessionToken: true,
      };
    });
}

function localBindings(env: NodeJS.ProcessEnv, cwd: string): McpEndpointBinding[] {
  return readLocalMcpServers(env, cwd).flatMap((server) => {
    if (server.transport && server.transport !== "streamable_http") return [];
    const baseUrl = server.url ? interpolateEnv(server.url, env) : "";
    if (!baseUrl) return [];
    const label = (server.name ?? server.id ?? hostForUrl(baseUrl)) || "mcp";
    const headers = Object.fromEntries(
      Object.entries(server.headers ?? {}).map(([key, value]) => [
        key,
        interpolateEnv(value, env),
      ])
    );
    return [{
      id: safeServerId(server.id ?? label),
      name: label,
      host: hostForUrl(baseUrl),
      baseUrl,
      headers,
      requiresSessionToken: false,
    }];
  });
}

function endpointBindings(env: NodeJS.ProcessEnv, cwd: string): McpEndpointBinding[] {
  const seen = new Set<string>();
  const bindings: McpEndpointBinding[] = [];
  for (const binding of [...bootstrapBindings(env), ...localBindings(env, cwd)]) {
    const key = `${binding.id}:${binding.baseUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push(binding);
  }
  return bindings;
}

export function localMcpHeadersForServer(
  serverId: string,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
): Record<string, string> | null {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const id = safeServerId(serverId);
  const binding = localBindings(env, cwd).find((candidate) => candidate.id === id);
  return binding ? binding.headers : null;
}

function sessionToken(env: NodeJS.ProcessEnv): string {
  return env[TOKEN_ENV] || env[AGENT_SESSION_TOKEN_ENV] || "";
}

function parseJsonRpcBody<T>(body: string, contentType: string): JsonRpcResponse<T> | null {
  if (contentType.includes("text/event-stream")) {
    let parsed: JsonRpcResponse<T> | null = null;
    for (const line of body.split("\n")) {
      const stripped = line.trim();
      if (!stripped.startsWith("data:")) continue;
      const payload = stripped.slice(5).trim();
      if (!payload) continue;
      try {
        const event = JSON.parse(payload) as JsonRpcResponse<T>;
        if (event.result !== undefined || event.error) parsed = event;
      } catch {
        // Ignore non-JSON SSE data lines.
      }
    }
    return parsed;
  }

  try {
    return JSON.parse(body) as JsonRpcResponse<T>;
  } catch {
    return null;
  }
}

async function postJsonRpc<T>(
  io: Pick<CliIO, "env" | "fetch"> & { cwd?: string },
  server: McpManifestServer,
  payload: Record<string, unknown>,
  sessionId?: string
): Promise<
  | { parsed: JsonRpcResponse<T> | null; status: number; headers: Headers; body: string }
  | string
> {
  const localHeaders = localMcpHeadersForServer(server.id, { env: io.env, cwd: io.cwd });
  const token = sessionToken(io.env);
  if (!token && localHeaders === null) {
    return `${TOKEN_ENV} is not set; cannot call MCP endpoint tools.`;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
    ...(localHeaders ?? { Authorization: `Bearer ${token}` }),
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  let response: Response;
  try {
    response = await io.fetch(server.base_url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return `MCP transport error: ${err instanceof Error ? err.message : String(err)}`;
  }

  const body = await response.text().catch(() => "");
  const parsed = parseJsonRpcBody<T>(body, response.headers.get("content-type") ?? "");
  return { parsed, status: response.status, headers: response.headers, body };
}

function summarizeBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 1200) return trimmed;
  return `${trimmed.slice(0, 1200)}...`;
}

function rpcFailureMessage(body: string, parsed: JsonRpcResponse<unknown> | null): string {
  if (parsed?.error) return `MCP error: ${prettyJson(parsed.error)}`;
  const summary = summarizeBody(body);
  return summary ? `Response body: ${summary}` : "No response body.";
}

async function initializeSession(
  io: Pick<CliIO, "env" | "fetch"> & { cwd?: string },
  server: McpManifestServer
): Promise<{ sessionId?: string; diagnostic?: McpDiscoveryDiagnostic }> {
  const result = await postJsonRpc(io, server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "pi-recipes-mcp-cli", version: "1.0" },
    },
  });
  if (typeof result === "string" || result.status < 200 || result.status >= 300) {
    return {
      diagnostic: {
        serverId: server.id,
        url: server.base_url,
        stage: "initialize",
        ...(typeof result === "string"
          ? { message: result }
          : {
              status: result.status,
              message: rpcFailureMessage(result.body, result.parsed),
            }),
      },
    };
  }
  const sessionId = result.headers.get("mcp-session-id") ?? undefined;
  if (sessionId) {
    await postJsonRpc(
      io,
      server,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId
    ).catch(() => undefined);
  }
  return { sessionId };
}

async function listEndpointTools(
  binding: McpEndpointBinding,
  opts: { env: NodeJS.ProcessEnv; cwd: string; fetch: typeof fetch }
): Promise<{ tools: RemoteMcpTool[]; diagnostic?: McpDiscoveryDiagnostic }> {
  const manifestServer: McpManifestServer = {
    id: binding.id,
    name: binding.name,
    host: binding.host,
    base_url: binding.baseUrl,
    transport: "streamable_http",
    tools: [],
  };
  const initialized = await initializeSession(opts, manifestServer);
  if (initialized.diagnostic) return { tools: [], diagnostic: initialized.diagnostic };
  const result = await postJsonRpc<ToolsListResult>(
    opts,
    manifestServer,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    initialized.sessionId
  );
  if (typeof result === "string") {
    return {
      tools: [],
      diagnostic: {
        serverId: binding.id,
        url: binding.baseUrl,
        stage: "tools/list",
        message: result,
      },
    };
  }
  if (result.status < 200 || result.status >= 300) {
    return {
      tools: [],
      diagnostic: {
        serverId: binding.id,
        url: binding.baseUrl,
        stage: "tools/list",
        status: result.status,
        message: rpcFailureMessage(result.body, result.parsed),
      },
    };
  }
  if (!result.parsed || result.parsed.error || !result.parsed.result) {
    return {
      tools: [],
      diagnostic: {
        serverId: binding.id,
        url: binding.baseUrl,
        stage: "tools/list",
        message: rpcFailureMessage(result.body, result.parsed),
      },
    };
  }
  const tools = result.parsed.result.tools ?? [];
  if (tools.length === 0) {
    return {
      tools,
      diagnostic: {
        serverId: binding.id,
        url: binding.baseUrl,
        stage: "tools/list",
        message: "Server returned 0 tools.",
      },
    };
  }
  return { tools };
}

async function discoverMcpCatalogs(opts: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetch: typeof fetch;
}): Promise<{ catalogs: McpCatalog[]; diagnostics: McpDiscoveryDiagnostic[] }> {
  const catalogs: McpCatalog[] = [];
  const diagnostics: McpDiscoveryDiagnostic[] = [];
  const bindings = endpointBindings(opts.env, opts.cwd);
  if (bindings.length === 0) {
    diagnostics.push({
      serverId: "mcp",
      url: localMcpConfigPath(opts.env, opts.cwd),
      stage: "config",
      message: "No MCP endpoint bindings were found.",
    });
  }
  for (const binding of bindings) {
    if (binding.requiresSessionToken && !sessionToken(opts.env)) {
      diagnostics.push({
        serverId: binding.id,
        url: binding.baseUrl,
        stage: "config",
        message: `${TOKEN_ENV} is not set for this MCP endpoint binding.`,
      });
      continue;
    }
    const result = await listEndpointTools(binding, opts);
    if (result.diagnostic) diagnostics.push(result.diagnostic);
    if (result.tools.length === 0) continue;
    catalogs.push({
      id: binding.id,
      name: binding.name,
      host: binding.host,
      baseUrl: binding.baseUrl,
      tools: result.tools,
    });
  }
  return { catalogs, diagnostics };
}

export interface AgentMcpToolRef {
  serverId: string;
  toolName: string;
  raw: string;
}

export function parseAgentMcpToolRef(value: string): AgentMcpToolRef | null {
  if (!value.startsWith("mcp:")) return null;
  const body = value.slice("mcp:".length).trim();
  const slash = body.indexOf("/");
  if (slash <= 0 || slash === body.length - 1) return null;
  const serverId = body.slice(0, slash).trim();
  const toolName = body.slice(slash + 1).trim();
  if (!serverId || !toolName) return null;
  return { serverId: safeServerId(serverId), toolName, raw: value };
}

export function agentMcpToolAllowlist(tools: readonly string[]): Map<string, Set<string>> {
  const allow = new Map<string, Set<string>>();
  for (const tool of tools) {
    const parsed = parseAgentMcpToolRef(tool);
    if (!parsed) continue;
    const serverTools = allow.get(parsed.serverId) ?? new Set<string>();
    serverTools.add(parsed.toolName);
    allow.set(parsed.serverId, serverTools);
  }
  return allow;
}

export function executableRecipeToolNames(tools: readonly string[]): string[] {
  return tools.filter((tool) => !parseAgentMcpToolRef(tool));
}

export function formatMcpDiscoveryDiagnostics(
  diagnostics: readonly McpDiscoveryDiagnostic[],
  limit = 3
): string {
  const selected = diagnostics.slice(0, limit);
  const lines = selected.map((diagnostic) => {
    const status = diagnostic.status ? ` HTTP ${diagnostic.status}` : "";
    return `${diagnostic.serverId} ${diagnostic.stage}${status}: ${diagnostic.message}`;
  });
  const remaining = diagnostics.length - selected.length;
  if (remaining > 0) lines.push(`${remaining} more MCP discovery failure(s).`);
  return lines.join("\n");
}

function recipeMcpAllow(mcp: RecipePackageMcpConfig): {
  hasServers: boolean;
  required: Set<string>;
  tools: Map<string, Set<string>>;
} {
  return {
    hasServers: mcp.servers.length > 0,
    required: new Set(
      mcp.servers
        .filter((server) => server.required)
        .map((server) => safeServerId(server.id))
    ),
    tools: new Map(
      mcp.servers.map((server) => [
        safeServerId(server.id),
        new Set(server.tools.allow),
      ])
    ),
  };
}

function filterTools(
  serverId: string,
  tools: McpManifestTool[],
  recipeAllow: Map<string, Set<string>>,
  agentAllow: Map<string, Set<string>>
): McpManifestTool[] {
  const recipeTools = recipeAllow.get(serverId);
  const agentTools = agentAllow.get(serverId);
  const shouldApplyAgentAllow = recipeAllow.size > 0 || agentAllow.size > 0;
  return tools.filter((tool) => {
    const name = tool.name.trim();
    if (recipeTools && recipeTools.size > 0 && !recipeTools.has(name)) return false;
    if (shouldApplyAgentAllow && (!agentTools || !agentTools.has(name))) return false;
    return true;
  });
}

function normalizeManifest(manifest: McpManifest, mcp: RecipePackageMcpConfig, agentTools: readonly string[]): McpManifest {
  const recipeAllow = recipeMcpAllow(mcp);
  const agentAllow = agentMcpToolAllowlist(agentTools);
  const seenServerIds = new Set<string>();
  const matched = new Set<string>();
  const servers: McpManifestServer[] = [];

  for (const server of manifest.servers ?? []) {
    if (!server.id || !server.base_url) continue;
    const serverId = safeServerId(server.id);
    if (recipeAllow.hasServers && !recipeAllow.tools.has(serverId)) continue;
    matched.add(serverId);
    const seenTools = new Set<string>();
    const tools = filterTools(
      serverId,
      server.tools ?? [],
      recipeAllow.tools,
      agentAllow
    ).filter((tool) => {
      const name = tool.name.trim();
      if (!name || seenTools.has(name)) return false;
      seenTools.add(name);
      return true;
    });
    if (tools.length === 0) continue;
    servers.push({
      id: uniqueServerId(serverId, seenServerIds),
      name: server.name ?? server.id,
      host: server.host ?? hostForUrl(server.base_url),
      base_url: server.base_url,
      transport: server.transport ?? "streamable_http",
      tools,
    });
  }

  const missingRequired = [...recipeAllow.required].filter((serverId) => !matched.has(serverId));
  if (missingRequired.length > 0) {
    throw new Error(`Required MCP server binding(s) missing: ${missingRequired.join(", ")}`);
  }
  return { servers };
}

function manifestFromCatalogs(catalogs: McpCatalog[]): McpManifest {
  return {
    servers: catalogs.map((catalog) => ({
      id: catalog.id,
      name: catalog.name,
      host: catalog.host,
      base_url: catalog.baseUrl,
      transport: "streamable_http",
      tools: catalog.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        ...(tool.inputSchema ? { input_schema: tool.inputSchema } : {}),
      })),
    })),
  };
}

function filterDiagnostics(
  rawManifest: McpManifest,
  mcp: RecipePackageMcpConfig,
  agentTools: readonly string[]
): McpDiscoveryDiagnostic[] {
  const recipeAllow = recipeMcpAllow(mcp);
  const agentAllow = agentMcpToolAllowlist(agentTools);
  const diagnostics: McpDiscoveryDiagnostic[] = [];

  for (const server of rawManifest.servers ?? []) {
    const serverId = safeServerId(server.id);
    const discovered = (server.tools ?? []).map((tool) => tool.name).filter(Boolean).sort();
    if (discovered.length === 0) continue;

    const recipeExpected = [...(recipeAllow.tools.get(serverId) ?? new Set<string>())].sort();
    const agentExpected = [...(agentAllow.get(serverId) ?? new Set<string>())].sort();
    const expected = agentExpected.length > 0 ? agentExpected : recipeExpected;
    diagnostics.push({
      serverId,
      url: server.base_url,
      stage: "filter",
      message: [
        `Discovered ${discovered.length} tool(s): ${discovered.join(", ")}.`,
        expected.length > 0
          ? `Recipe expected: ${expected.join(", ")}.`
          : "Recipe did not allow any tools for this server.",
      ].join(" "),
    });
  }

  return diagnostics;
}

function readConfiguredManifests(recipeDir: string, manifest: RecipePackageManifest): McpManifest {
  const servers: McpManifestServer[] = [];
  for (const path of resolvePiPackageMcpManifestPaths(manifest)) {
    const parsed = readJson(path) as McpManifest;
    servers.push(...(parsed.servers ?? []));
  }
  if (servers.length === 0 && existsSync(join(recipeDir, "mcp.json"))) {
    const parsed = readJson(join(recipeDir, "mcp.json")) as McpManifest;
    servers.push(...(parsed.servers ?? []));
  }
  return { servers };
}

async function writeMcpManifest(
  path: string,
  serialized: string,
  defaultPath: string
): Promise<string> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serialized);
    return path;
  } catch (err) {
    if (path !== defaultPath) throw err;
    const fallback = fallbackMcpManifestPath();
    await mkdir(dirname(fallback), { recursive: true });
    await writeFile(fallback, serialized);
    return fallback;
  }
}

async function clearDefaultMcpManifest(env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  delete env[MCP_MANIFEST_ENV];
  delete env[LEGACY_MCP_MANIFEST_ENV];
  await rm(defaultMcpManifestPath(cwd), { force: true });
}

export async function materializeRecipeMcpManifest(
  opts: MaterializeRecipeMcpOptions
): Promise<MaterializedMcpManifest> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const hasConfiguredManifest =
    opts.manifest.mcp.manifests.length > 0 ||
    existsSync(join(opts.recipeDir, "mcp.json"));

  let rawManifest: McpManifest;
  let diagnostics: McpDiscoveryDiagnostic[] = [];
  if (hasConfiguredManifest) {
    rawManifest = readConfiguredManifests(opts.recipeDir, opts.manifest);
  } else {
    const discovery = await discoverMcpCatalogs({
      env,
      cwd: opts.cwd,
      fetch: fetchImpl,
    });
    diagnostics = discovery.diagnostics;
    rawManifest = manifestFromCatalogs(discovery.catalogs);
  }
  const mcpManifest = normalizeManifest(rawManifest, opts.manifest.mcp, opts.agentTools);
  if ((mcpManifest.servers ?? []).length === 0) {
    if (diagnostics.length === 0) {
      diagnostics = filterDiagnostics(rawManifest, opts.manifest.mcp, opts.agentTools);
    }
    await clearDefaultMcpManifest(env, opts.cwd);
    return { ...mcpManifest, diagnostics };
  }

  const defaultPath = defaultMcpManifestPath(opts.cwd);
  const target = manifestPath(env, opts.cwd);
  const writtenPath = await writeMcpManifest(
    target,
    `${JSON.stringify(mcpManifest, null, 2)}\n`,
    defaultPath
  );
  env[MCP_MANIFEST_ENV] = writtenPath;
  env[LEGACY_MCP_MANIFEST_ENV] = writtenPath;
  return { ...mcpManifest, diagnostics };
}

function serverById(manifest: McpManifest, id: string): McpManifestServer | string {
  const wanted = safeServerId(id);
  const server = (manifest.servers ?? []).find(
    (candidate) => safeServerId(candidate.id) === wanted
  );
  return server ?? `Unknown MCP server: ${id}`;
}

function toolByName(server: McpManifestServer, name: string): McpManifestTool | string {
  const tool = (server.tools ?? []).find((candidate) => candidate.name === name);
  return tool ?? `Unknown MCP tool: ${server.id}.${name}`;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderResult(value: unknown): string {
  const result = value as {
    content?: unknown;
    structuredContent?: unknown;
  };
  const parts: string[] = [];
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    } else {
      parts.push(prettyJson(record));
    }
  }
  if (result?.structuredContent !== undefined) parts.push(prettyJson(result.structuredContent));
  return parts.length > 0 ? parts.join("\n\n") : prettyJson(value);
}

function transportErrorMessage(prefix: string, status: number, body: string, parsed: JsonRpcResponse<unknown> | null): string {
  const lines = [`${prefix}: HTTP ${status}`];
  if (parsed?.error) {
    lines.push(`MCP error: ${prettyJson(parsed.error)}`);
  } else {
    const summary = summarizeBody(body);
    if (summary) lines.push(`Response body: ${summary}`);
  }
  return lines.join("\n");
}

function printHelp(io: CliIO): number {
  writeLine(
    io.stdout,
    `mcp - call MCP endpoint tools configured for this recipe

Usage:
  mcp tools sources
  mcp tools search "<query>"
  mcp tools describe <server> <tool>
  mcp tools describe <server>.<tool>
  mcp call <server> <tool> '<json-args>'`
  );
  return 0;
}

function toolsSources(io: CliIO): number {
  const manifest = readManifest(io.env, io.cwd);
  if (typeof manifest === "string") {
    writeLine(io.stderr, manifest);
    return 1;
  }
  for (const server of manifest.servers ?? []) {
    writeLine(
      io.stdout,
      `${server.id}\t${server.name ?? server.id}\t${server.host ?? ""}\t${server.tools?.length ?? 0} tools`
    );
  }
  return 0;
}

function toolsSearch(io: CliIO, query: string): number {
  const manifest = readManifest(io.env, io.cwd);
  if (typeof manifest === "string") {
    writeLine(io.stderr, manifest);
    return 1;
  }
  const q = query.toLowerCase();
  for (const server of manifest.servers ?? []) {
    for (const tool of server.tools ?? []) {
      const haystack = `${server.id}.${tool.name} ${tool.description ?? ""}`.toLowerCase();
      if (!q || haystack.includes(q)) {
        writeLine(
          io.stdout,
          `${server.id}.${tool.name}${tool.description ? ` - ${tool.description}` : ""}`
        );
      }
    }
  }
  return 0;
}

function parseDescribeArgs(args: string[]): [string, string] | string {
  if (args.length >= 2) return [args[0]!, args[1]!];
  const [combined] = args;
  if (combined?.includes(".")) {
    const [server, tool] = combined.split(".", 2);
    if (server && tool) return [server, tool];
  }
  return "Usage: mcp tools describe <server> <tool>";
}

function toolsDescribe(io: CliIO, args: string[]): number {
  const parsedArgs = parseDescribeArgs(args);
  if (typeof parsedArgs === "string") {
    writeLine(io.stderr, parsedArgs);
    return 1;
  }
  const manifest = readManifest(io.env, io.cwd);
  if (typeof manifest === "string") {
    writeLine(io.stderr, manifest);
    return 1;
  }
  const server = serverById(manifest, parsedArgs[0]);
  if (typeof server === "string") {
    writeLine(io.stderr, server);
    return 1;
  }
  const tool = toolByName(server, parsedArgs[1]);
  if (typeof tool === "string") {
    writeLine(io.stderr, tool);
    return 1;
  }
  writeLine(io.stdout, prettyJson(tool));
  return 0;
}

export async function callMcpTool(
  io: Pick<CliIO, "env" | "fetch" | "stderr"> & { cwd?: string },
  serverId: string,
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<{ ok: true; text: string; result: unknown } | { ok: false; error: string }> {
  const manifest = readManifest(io.env, io.cwd);
  if (typeof manifest === "string") return { ok: false, error: manifest };
  const server = serverById(manifest, serverId);
  if (typeof server === "string") return { ok: false, error: server };
  const tool = toolByName(server, toolName);
  if (typeof tool === "string") return { ok: false, error: tool };

  const initialized = await initializeSession(io, server);
  if (initialized.diagnostic) {
    return {
      ok: false,
      error: `MCP initialize failed: ${initialized.diagnostic.message}`,
    };
  }
  const result = await postJsonRpc<unknown>(
    io,
    server,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: tool.name, arguments: args },
    },
    initialized.sessionId
  );
  if (typeof result === "string") return { ok: false, error: result };
  if (result.status < 200 || result.status >= 300) {
    return {
      ok: false,
      error: transportErrorMessage(
        "MCP call failed",
        result.status,
        result.body,
        result.parsed
      ),
    };
  }
  if (!result.parsed) return { ok: false, error: "MCP call failed: response was not JSON-RPC." };
  if (result.parsed.error) return { ok: false, error: `MCP error: ${prettyJson(result.parsed.error)}` };
  return {
    ok: true,
    text: renderResult(result.parsed.result),
    result: result.parsed.result,
  };
}

async function callTool(io: CliIO, args: string[]): Promise<number> {
  const [serverId, toolName, rawArgs] = args;
  if (!serverId || !toolName) {
    writeLine(io.stderr, "Usage: mcp call <server> <tool> '<json-args>'");
    return 1;
  }

  let parsedArgs: Record<string, unknown> = {};
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected object");
      }
      parsedArgs = parsed as Record<string, unknown>;
    } catch {
      writeLine(io.stderr, "Tool arguments must be valid JSON.");
      return 1;
    }
  }

  const result = await callMcpTool(io, serverId, toolName, parsedArgs);
  if (!result.ok) {
    writeLine(io.stderr, result.error);
    return 1;
  }
  writeLine(io.stdout, result.text);
  return 0;
}

export async function main(
  argv = process.argv.slice(2),
  io: CliIO = {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    fetch: globalThis.fetch,
  }
): Promise<number> {
  const [group, command, ...rest] = argv;
  if (!group || group === "help" || group === "--help" || group === "-h") {
    return printHelp(io);
  }
  if (group === "tools" && command === "sources") return toolsSources(io);
  if (group === "tools" && command === "search") return toolsSearch(io, rest.join(" "));
  if (group === "tools" && command === "describe") return toolsDescribe(io, rest);
  if (group === "call") return callTool(io, [command ?? "", ...rest]);
  printHelp(io);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
