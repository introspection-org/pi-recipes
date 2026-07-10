#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { stdin as input, stderr, stdout } from "node:process";
import { Worker } from "node:worker_threads";
import { createCallResult, createRuntime } from "mcporter";
import { isDirectEntry } from "./direct-cli.js";
import {
  defaultMcporterConfigPath,
  defaultMcpManifestPath,
  mcporterCliEntrypointPath,
  type McpManifest,
  type McpManifestTool,
} from "./mcp.js";
import {
  createMcpCliSessionPolicy,
  validateDelegatedMcpCommand,
} from "./mcp-cli-policy.js";

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RUN_TOOL_CALLS = 100;
const DEFAULT_MAX_CONCURRENT_TOOL_CALLS = 16;
const MAX_SEARCH_DESCRIPTION_CHARS = 600;
const MCP_MANIFEST_ENV = "PI_RECIPES_MCP_MANIFEST";

export interface ToolSearchMatch {
  ref: string;
  server: string;
  tool: string;
  description: string;
  required: string[];
  score: number;
  inspect: string;
  call: string;
  annotations?: Record<string, unknown>;
}

type ToolCallOutcome = "pending" | "succeeded" | "failed" | "outcome_unknown";

interface ToolCallRecord {
  ref: string;
  observed: boolean;
  outcome: ToolCallOutcome;
  error?: string;
  promise: Promise<unknown>;
}

type McpRunResultFormat =
  | "json"
  | "text"
  | "markdown"
  | "images"
  | "content"
  | "structuredContent"
  | "raw";

interface McpRunToolFunction {
  (args?: Record<string, unknown>): Promise<unknown>;
  text(args?: Record<string, unknown>): Promise<unknown>;
  markdown(args?: Record<string, unknown>): Promise<unknown>;
  images(args?: Record<string, unknown>): Promise<unknown>;
  content(args?: Record<string, unknown>): Promise<unknown>;
  structuredContent(args?: Record<string, unknown>): Promise<unknown>;
  raw(args?: Record<string, unknown>): Promise<unknown>;
}

export class McpRunUsageError extends Error {}

export class McpRunTimeoutError extends Error {
  readonly outcome = "unknown";
  constructor(message: string) {
    super(message);
    this.name = "McpRunTimeoutError";
  }
}

export interface McpRunRemoteErrorDetails extends Record<string, unknown> {
  code?: string;
  message: string;
  retryable?: boolean;
  action?: string;
  outcome?: string;
}

class McpRemoteToolResultError extends Error {
  constructor(readonly details: McpRunRemoteErrorDetails) {
    super(details.message);
    this.name = "McpRemoteToolResultError";
  }
}

export class McpRunToolError extends Error {
  readonly kind = "tool_execution";
  readonly details?: McpRunRemoteErrorDetails;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly action?: string;
  readonly outcome?: string;

  constructor(
    readonly server: string,
    readonly tool: string,
    message: string,
    options?: ErrorOptions & { details?: McpRunRemoteErrorDetails }
  ) {
    super(message, options);
    this.name = "McpRunToolError";
    this.details = options?.details;
    this.code = options?.details?.code;
    this.retryable = options?.details?.retryable;
    this.action = options?.details?.action;
    this.outcome = options?.details?.outcome;
  }
}

export function mcpCliHelpText(): string {
  return [
    "mcp - use available MCP tools",
    "Supported: search, list, call, and run.",
    "Run `mcp <command> --help` for complete command syntax.",
    "Use this session-local `mcp` command, not `mcporter` or `npx mcporter`; it enforces the materialized recipe capabilities.",
    "",
    "Find tools:",
    "  mcp search \"what you need\"",
    "  mcp search \"tool|argument\" --regex --json",
    "  mcp list",
    "  mcp list <server>",
    "  mcp list <server.tool> --schema",
    "  Add --brief for compact signatures, --all-parameters for every optional input, or --json for machine output.",
    "",
    "Call one tool:",
    "  mcp call <server>.<tool> key=value ...",
    "  mcp call '<server>.<tool>(key: \"value\")'",
    "  Calls support --args/--json payloads, --output text|markdown|json|raw, --save-images, --timeout, and @file.",
    "  Quote argument tokens containing shell operators, especially multi-value |; JSON stdin avoids shell quoting.",
    "  Use --output json for machine-readable success and failure envelopes.",
    "",
    "Run a short workflow:",
    "  mcp run --var ID=abc123 <<'EOF'",
    '  const result = await tools["server"]["tool"]({ sessionId: vars.ID, key: "value" })',
    "  console.log(JSON.stringify(result, null, 2))",
    "  EOF",
    "  Keep the heredoc quoted (<<'EOF'); pass dynamic values with --var KEY=value (read as vars.KEY).",
    "  Calls return decoded JSON by default. Use tool.text(args), tool.markdown(args), tool.images(args), tool.content(args), tool.structuredContent(args), or tool.raw(args) only when the tool documentation calls for another shape.",
    "",
    "When to use:",
    "  Use search when you do not know the right tool.",
    "  Inspect the exact tool before supplying arguments: mcp list <server.tool> --schema.",
    "  Use mcp call for a single simple operation.",
    "  Use mcp run for multiple calls, filtering, ranking, or dedupe.",
    "  Use @file for long text and --output json when piping call output.",
    "  Tool commands are always headless. If authentication is required, ask the user to authenticate the MCP connection outside the agent session, then retry.",
    "",
    "Availability:",
    "  Search and list expose only tools callable in this session.",
    "  Only exact tool names returned by mcp list are callable.",
    "  Descriptions may mention related tools that are not exposed; mentions do not grant access.",
    "  If no listed tool supports an action, report that the connected capability is unavailable.",
    "  MCP resources and mcporter configuration, ad-hoc transport, code-generation, record/replay, daemon, and serve commands are not exposed.",
  ].join("\n");
}

export function mcpListHelpText(): string {
  return [
    "Usage: mcp list [server | server.tool] [flags]",
    "",
    "Delegates listing and schema rendering to mcporter for servers materialized in this recipe session.",
    "",
    "Flags:",
    "  --brief, --signatures     Compact signatures only.",
    "  --all-parameters          Include every optional parameter.",
    "  --schema                  Include the input schema and, for one exact tool, its output schema.",
    "  --json                    Emit mcporter's machine-readable output unchanged.",
    "  --status                  Show concise status for an exact server target.",
    "  --quiet, --exit-code      Health checks for an exact server target.",
    "  --timeout <ms>            Override discovery timeout for an exact target.",
    "  --no-oauth                Use cached credentials without starting OAuth.",
    "",
    "URLs, ad-hoc transports, config overrides, and persistence are unavailable in recipe sessions.",
  ].join("\n");
}

export function mcpCallHelpText(): string {
  return [
    "Usage: mcp call <server>.<tool> [arguments] [flags]",
    "",
    "Delegates argument parsing and tool execution to mcporter for exact tools materialized in this recipe session.",
    "",
    "Arguments:",
    "  key=value / key:value     Named arguments with mcporter's schema-aware coercion.",
    "  --key value               Named schema arguments supported by mcporter.",
    "  key=@path                 Read an exact UTF-8 string; use @@ for a literal @.",
    "  --args <json|->, --json <json|->  Supply a JSON object directly or from stdin.",
    "  '<server>.<tool>(...)'    Function-call syntax for nested values.",
    "  --                         Treat remaining values as literal positional inputs.",
    "  Quote argument tokens containing shell operators such as |, <, >, &, or ;. JSON stdin avoids nested shell quoting.",
    "",
    "Output/runtime flags:",
    "  --output text|markdown|json|raw",
    "  --save-images <dir>",
    "  --timeout <ms>",
    "  --no-oauth, --oauth-timeout <ms>",
    "  --raw-strings, --no-coerce",
    "  Machine-readable output is forwarded unchanged.",
    "",
    "URLs, ad-hoc transports, config overrides, and persistence are unavailable in recipe sessions.",
  ].join("\n");
}

export function mcpSearchHelpText(): string {
  return [
    'Usage: mcp search "what you need" [--limit N] [--json] [--regex]',
    "",
    "Searches only MCP tools available in this session.",
    "Results include the exact tool ref, required fields, an inspection command, and a call example.",
    "Try broader or alternate terms when no result matches.",
    "Use `mcp list <server>` only to identify exact tool names, then inspect one candidate with `mcp list <server.tool> --schema`.",
  ].join("\n");
}

export function mcpRunHelpText(): string {
  return [
    "Usage: mcp run [--var KEY=value] [--json-errors] [file]",
    "",
    'Runs a short JavaScript workflow with available MCP tools such as `tools["server"]["tool"]`.',
    "With no file, code is read from stdin. Keep heredocs quoted and pass dynamic values with --var.",
    "Scripts are killed after 120s by default (override with PI_RECIPES_MCP_RUN_TIMEOUT_MS).",
    "Each tool call is capped at 60s; workflows allow at most 100 calls and run 16 at a time by default.",
    "Extra calls wait in a FIFO queue and inherit the remaining workflow deadline.",
    "Always await or return tool-call chains.",
    "Detached .then/.catch calls fail if still pending when the script exits.",
    "Structured MCP errors retain code, retryable, action, request_id, and outcome fields when supplied.",
    "Calls return decoded JSON by default, so read response fields directly from the awaited value.",
    "Only when a tool documents another response type, call the format on the tool itself: tool.text(args), tool.markdown(args), tool.images(args), tool.content(args), tool.structuredContent(args), or tool.raw(args).",
    "Use --var/vars for dynamic input; process.argv is intentionally unavailable inside workflows.",
    "--json-errors emits a structured error object on stderr while preserving the nonzero exit code.",
    "MCP calls are always headless. If authentication is required, ask the user to authenticate the connection outside the agent session, then retry.",
    "A synchronous busy-loop is force-killed at the deadline.",
    "Code runs with the same OS privileges as the active shell sandbox; mcp run is not a separate security boundary.",
    "",
    "Example:",
    "  mcp run --var ID=abc123 <<'EOF'",
    '  const result = await tools["server"]["tool"]({ id: vars.ID })',
    "  console.log(JSON.stringify(result, null, 2))",
    "  EOF",
  ].join("\n");
}

function isHelpArg(value: string | undefined): boolean {
  return value === "--help" || value === "-h" || value === "help";
}

function readStdin(): Promise<string> {
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let data = "";
    input.on("data", (chunk) => {
      data += chunk;
    });
    input.on("error", reject);
    input.on("end", () => resolve(data));
  });
}

function checkedCallResult(
  callResult: ReturnType<typeof createCallResult>
): ReturnType<typeof createCallResult> {
  if (asRecord(callResult.raw).isError === true) {
    // Fail loudly in code mode so a bad call rejects instead of flowing an
    // error string into downstream logic.
    const parsed = callResult.json();
    const parsedRecord = asRecord(parsed);
    const parsedError = Object.prototype.hasOwnProperty.call(parsedRecord, "error")
      ? parsedRecord.error
      : parsedRecord;
    const errorObject = asRecord(parsedError);
    const message =
      typeof parsedError === "string"
        ? parsedError
        : typeof errorObject.message === "string"
          ? errorObject.message
          : callResult.text() ?? "MCP tool call failed.";
    throw new McpRemoteToolResultError({ ...errorObject, message });
  }
  return callResult;
}

function decodeCallResult(
  callResult: ReturnType<typeof createCallResult>,
  format: McpRunResultFormat,
  ref: string
): unknown {
  switch (format) {
    case "json": {
      const decoded = callResult.json();
      if (decoded === null && callResult.structuredContent() == null && callResult.text() != null) {
        throw new McpRunUsageError(
          `${ref} did not return JSON. Its documentation should name the response type; ` +
            `for plain text call tools[${JSON.stringify(ref.split(".")[0])}]` +
            `[${JSON.stringify(ref.slice(ref.indexOf(".") + 1))}].text(args).`
        );
      }
      return decoded;
    }
    case "text":
      return callResult.text();
    case "markdown":
      return callResult.markdown();
    case "images":
      return callResult.images();
    case "content":
      return callResult.content();
    case "structuredContent":
      return callResult.structuredContent();
    case "raw":
      return callResult.raw;
  }
}

function validateRunToolArgs(server: string, tool: string, args: Record<string, unknown>): void {
  const cliStyleKey = Object.keys(args).find((key) => key.includes(":=") || key.includes("="));
  if (!cliStyleKey) return;
  const suggestedKey = cliStyleKey.split(/:=|=/, 1)[0];
  throw new McpRunUsageError(
    `Invalid JavaScript argument key '${cliStyleKey}' for ${server}.${tool}. ` +
      `mcp run uses normal JavaScript objects: write { ${suggestedKey}: value }, ` +
      `not mcporter CLI key=value or key:=value syntax.`
  );
}

class ToolCallQueue {
  private active = 0;
  private readonly waiting: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
  }> = [];
  private cancelled: unknown;

  constructor(private readonly limit: number) {}

  acquire(): Promise<() => void> {
    if (this.cancelled !== undefined) return Promise.reject(this.cancelled);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseHandle());
    }
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  cancel(error: unknown): void {
    if (this.cancelled !== undefined) return;
    this.cancelled = error;
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next && this.cancelled === undefined) {
        next.resolve(this.releaseHandle());
        return;
      }
      this.active -= 1;
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function toolProperties(tool: McpManifestTool): Array<{ name: string; description: string }> {
  const schema = asRecord(tool.input_schema);
  const properties = asRecord(schema.properties);
  return Object.entries(properties).map(([name, value]) => {
    const property = asRecord(value);
    const description =
      typeof property.description === "string"
        ? property.description
        : typeof property.title === "string"
          ? property.title
          : "";
    return { name, description };
  });
}

function toolRequired(tool: McpManifestTool): string[] {
  const schema = asRecord(tool.input_schema);
  return Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
}

function includesTerm(value: string, term: string): boolean {
  return value.toLowerCase().includes(term.toLowerCase());
}

function scoreTool(opts: {
  query: string;
  queryTerms: string[];
  regex?: RegExp;
  serverId: string;
  serverName: string;
  tool: McpManifestTool;
}): number {
  const ref = `${opts.serverId}.${opts.tool.name}`;
  const description = opts.tool.description ?? "";
  const properties = toolProperties(opts.tool);
  const propertyNames = properties.map((property) => property.name).join(" ");
  const propertyDescriptions = properties.map((property) => property.description).join(" ");
  const searchable = [
    ref,
    opts.serverId,
    opts.serverName,
    opts.tool.name,
    description,
    propertyNames,
    propertyDescriptions,
  ].join("\n");
  if (opts.regex) return opts.regex.test(searchable) ? 100 : 0;

  const query = opts.query.toLowerCase();
  const toolName = opts.tool.name.toLowerCase();
  const refName = ref.toLowerCase();
  let score = 0;
  if (refName === query) score += 500;
  if (toolName === query) score += 300;
  if (refName.includes(query)) score += 120;
  if (toolName.includes(query)) score += 100;
  if (description.toLowerCase().includes(query)) score += 60;

  const toolNameTokens = new Set(words(opts.tool.name));
  const serverTokens = new Set(words(`${opts.serverId} ${opts.serverName}`));
  const descriptionText = description.toLowerCase();
  const propertyNameTokens = new Set(words(propertyNames));
  const propertyDescriptionText = propertyDescriptions.toLowerCase();

  for (const term of opts.queryTerms) {
    if (toolNameTokens.has(term)) score += 40;
    else if (includesTerm(opts.tool.name, term)) score += 20;

    if (descriptionText.includes(term)) score += 16;
    if (propertyNameTokens.has(term)) score += 12;
    else if (includesTerm(propertyNames, term)) score += 6;

    if (propertyDescriptionText.includes(term)) score += 6;
    if (serverTokens.has(term)) score += 4;
  }
  return score;
}

function exampleValue(name: string): string {
  if (/^(q|query|search)$/i.test(name)) return `="example query"`;
  if (/limit|count|max/i.test(name)) return "=10";
  if (/^(id|.*Id)$/i.test(name)) return '="<id>"';
  return '="<value>"';
}

function callExample(serverId: string, tool: McpManifestTool): string {
  const required = toolRequired(tool);
  const args = required.slice(0, 4).map((name) => `${name}${exampleValue(name)}`);
  return ["mcp call", `${serverId}.${tool.name}`, ...args].join(" ");
}

export function searchMcpTools(
  manifest: McpManifest,
  query: string,
  opts: { limit?: number; regex?: boolean } = {}
): ToolSearchMatch[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const regex = opts.regex ? new RegExp(trimmed, "i") : undefined;
  const queryTerms = words(trimmed);
  const matches: ToolSearchMatch[] = [];
  for (const server of manifest.servers ?? []) {
    for (const tool of server.tools ?? []) {
      const score = scoreTool({
        query: trimmed,
        queryTerms,
        regex,
        serverId: server.id,
        serverName: server.name ?? "",
        tool,
      });
      if (score <= 0) continue;
      const ref = `${server.id}.${tool.name}`;
      matches.push({
        ref,
        server: server.id,
        tool: tool.name,
        description:
          (tool.description ?? "").length > MAX_SEARCH_DESCRIPTION_CHARS
            ? `${(tool.description ?? "").slice(0, MAX_SEARCH_DESCRIPTION_CHARS - 14).trimEnd()}… [truncated]`
            : (tool.description ?? ""),
        required: toolRequired(tool),
        score,
        inspect: `mcp list ${ref} --schema`,
        call: callExample(server.id, tool),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      });
    }
  }
  return matches
    .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref))
    .slice(0, opts.limit ?? 8);
}

async function readManifest(): Promise<McpManifest> {
  const path = sessionManifestPath();
  const data = await readFile(path, "utf8");
  return JSON.parse(data) as McpManifest;
}

function sessionManifestPath(): string {
  const workspacePath = defaultMcpManifestPath(sessionRoot());
  return existsSync(workspacePath)
    ? workspacePath
    : process.env[MCP_MANIFEST_ENV] || workspacePath;
}

function sessionMcporterConfigPath(): string {
  const workspacePath = defaultMcporterConfigPath(sessionRoot());
  return existsSync(workspacePath)
    ? workspacePath
    : process.env.MCPORTER_CONFIG || workspacePath;
}

function sessionRoot(): string {
  return process.env.PI_RECIPES_MCP_SESSION_ROOT || process.cwd();
}

function pinSessionMcporterConfig(): void {
  process.env.MCPORTER_CONFIG = sessionMcporterConfigPath();
}

async function sessionCliPolicy() {
  return createMcpCliSessionPolicy(await readManifest());
}

function parseSearchArgs(
  args: string[]
):
  | { query: string; limit: number; json: boolean; regex: boolean; error?: undefined }
  | { error: string } {
  const queryParts: string[] = [];
  let limit = 8;
  let json = false;
  let regex = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--regex") {
      regex = true;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = arg === "--limit" ? args[++index] : arg.slice("--limit=".length);
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        return { error: `--limit expects a positive integer, got '${raw ?? ""}'.` };
      }
      limit = Math.floor(value);
      continue;
    }
    if (arg.startsWith("-")) return { error: `Unknown mcp search option '${arg}'.` };
    queryParts.push(arg);
  }
  return { query: queryParts.join(" "), limit, json, regex };
}

async function searchCatalog(args: string[]): Promise<number> {
  const parsed = parseSearchArgs(args);
  if (parsed.error !== undefined) {
    stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const { query, limit, json, regex } = parsed;
  if (!query.trim()) {
    stderr.write("Usage: mcp search \"what you need\" [--limit N] [--json] [--regex]\n");
    return 2;
  }
  let matches: ToolSearchMatch[];
  try {
    matches = searchMcpTools(await readManifest(), query, { limit, regex });
  } catch (err) {
    if (regex && err instanceof SyntaxError) {
      stderr.write(`Invalid --regex pattern: ${query}\n`);
      return 2;
    }
    throw err;
  }
  if (json) {
    stdout.write(`${JSON.stringify({ query, matches }, null, 2)}\n`);
    return 0;
  }
  if (matches.length === 0) {
    stdout.write(`No matching tools found for "${query}".\n`);
    stdout.write("Try broader or alternate terms.\n");
    stdout.write(
      "Use `mcp list <server>` only to identify exact tool names, then inspect one candidate with `mcp list <server.tool> --schema`.\n"
    );
    return 0;
  }
  stdout.write(`Found ${matches.length} available matching tool${matches.length === 1 ? "" : "s"}\n\n`);
  for (const match of matches) {
    stdout.write(`${match.ref}\n`);
    if (match.description) stdout.write(`  ${match.description}\n`);
    if (match.required.length > 0) stdout.write(`  Required: ${match.required.join(", ")}\n`);
    if (match.annotations && Object.keys(match.annotations).length > 0) {
      stdout.write(`  Safety: ${JSON.stringify(match.annotations)}\n`);
    }
    stdout.write(`  Inspect: ${match.inspect}\n`);
    stdout.write(`  Example: ${match.call}\n\n`);
  }
  return 0;
}

// Property names scripts and runtimes probe on plain objects; returning
// undefined keeps `await tools`, JSON.stringify, and inspection from throwing.
const PROXY_PROBE_PROPS = new Set(["then", "toJSON", "constructor", "inspect"]);

function normalizeName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function closestName(input: string, candidates: Iterable<string>): string | undefined {
  const normalizedInput = normalizeName(input);
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const score = levenshtein(normalizedInput, normalizeName(candidate));
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best === undefined) return undefined;
  const baseline = Math.max(normalizedInput.length, normalizeName(best).length, 1);
  return bestScore <= Math.max(2, Math.floor(baseline / 3)) ? best : undefined;
}

export function describeUnknownRunServer(server: string, servers: string[]): string {
  const suggestion = closestName(server, servers);
  const parts = [`Unknown MCP server '${server}'.`];
  if (suggestion) parts.push(`Did you mean 'tools.${suggestion}'?`);
  parts.push(
    servers.length > 0
      ? `Available servers: ${servers.join(", ")}.`
      : "No MCP servers are configured."
  );
  return parts.join(" ");
}

const RUN_TOOL_REJECTED_PATTERNS = [
  /\btool\s+[\w.-]+\s+not found\b/i,
  /\bunknown tool\b/i,
];
const RUN_TOOL_BLOCKED_PATTERN = /is not accessible on server '[^']+' \(blocked by configuration\)/;
const RUN_AUTH_REQUIRED_PATTERN =
  /\b(?:authentication required|unauthenticated|HTTP 401|missing (?:access )?token|invalid (?:access )?token|failed to resolve header ['"]Authorization)/i;

export function describeUnavailableRunTool(
  server: string,
  tool: string,
  knownTools: string[]
): string {
  const suggestion = closestName(tool, knownTools);
  const parts = [`Tool '${tool}' is not available on server '${server}'.`];
  if (suggestion) parts.push(`Did you mean '${suggestion}'?`);
  parts.push(`Run \`mcp list ${server}\` to see available tools.`);
  return parts.join(" ");
}

function improveRunToolError(
  error: unknown,
  server: string,
  tool: string,
  knownTools: string[]
): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (RUN_AUTH_REQUIRED_PATTERN.test(message)) {
    return new McpRemoteToolResultError({
      code: "authentication_required",
      message:
        `Authentication is required for MCP server '${server}'. ` +
        "Ask the user to authenticate this MCP connection outside the agent session, then retry.",
      retryable: false,
      action: "ask_user_to_authenticate",
    });
  }
  if (RUN_TOOL_BLOCKED_PATTERN.test(message)) {
    return new Error(
      `Tool '${tool}' is not enabled for server '${server}' in this session. ` +
        `Run \`mcp list ${server}\` to inspect the allowlist; if absent, the recipe configuration must grant it.`,
      { cause: error }
    );
  }
  if (!RUN_TOOL_REJECTED_PATTERNS.some((pattern) => pattern.test(message))) return error;
  return new Error(describeUnavailableRunTool(server, tool, knownTools), { cause: error });
}

async function manifestToolNames(): Promise<Map<string, string[]>> {
  const names = new Map<string, string[]>();
  try {
    const manifest = await readManifest();
    for (const server of manifest.servers ?? []) {
      names.set(
        server.id,
        (server.tools ?? []).map((tool) => tool.name)
      );
    }
  } catch {
    // The manifest is a session artifact; suggestions degrade without it.
  }
  return names;
}

async function createTools(opts: {
  callTimeoutMs: number;
  maxCalls: number;
  maxConcurrentCalls: number;
  deadlineMs: number;
}) {
  const runtime = await createRuntime();
  const knownTools = await manifestToolNames();
  // The filtered session manifest is the authority. The mcporter config is a
  // transport projection, not another capability source, so extra config
  // entries must never appear on the run proxy.
  const configuredServers = new Set(runtime.listServers());
  const servers = [...knownTools.keys()].filter((server) => configuredServers.has(server));
  const calls: ToolCallRecord[] = [];
  let callCount = 0;
  const queue = new ToolCallQueue(opts.maxConcurrentCalls);
  const toolsByServer: Record<
    string,
    Record<string, McpRunToolFunction>
  > = Object.create(null);
  for (const server of servers) {
    toolsByServer[server] = new Proxy(Object.create(null), {
      get(_target, property) {
        if (typeof property !== "string" || PROXY_PROBE_PROPS.has(property)) return undefined;
        const startCall = (
          args: Record<string, unknown>,
          format: McpRunResultFormat
        ): Promise<unknown> => {
          validateRunToolArgs(server, property, args);
          const allowedToolNames = knownTools.get(server);
          if (allowedToolNames && !allowedToolNames.includes(property)) {
            throw new McpRunToolError(
              server,
              property,
              describeUnavailableRunTool(server, property, allowedToolNames)
            );
          }
          if (callCount >= opts.maxCalls) {
            throw new McpRunUsageError(
              `mcp run tool-call limit exceeded (${opts.maxCalls}). Split the workflow or raise PI_RECIPES_MCP_RUN_MAX_CALLS.`
            );
          }
          callCount += 1;
          const rawCall = (async () => {
            let release: (() => void) | undefined;
            try {
              release = await queue.acquire();
              const remainingMs = opts.deadlineMs - Date.now();
              if (remainingMs <= 0) {
                throw new McpRunTimeoutError(
                  `mcp run deadline reached before ${server}.${property} started.`
                );
              }
              const result = checkedCallResult(
                createCallResult(
                  await runtime.callTool(server, property, {
                    args,
                    // A queued call must never outlive the workflow that owns
                    // it. mcporter forwards this timeout to the MCP SDK and
                    // resets the transport when it fires.
                    timeoutMs: Math.min(opts.callTimeoutMs, remainingMs),
                    disableOAuth: true,
                  })
                )
              );
              return decodeCallResult(result, format, `${server}.${property}`);
            } catch (error) {
              const improved = improveRunToolError(
                error,
                server,
                property,
                allowedToolNames ?? []
              );
              if (improved instanceof McpRunUsageError) throw improved;
              const message = improved instanceof Error ? improved.message : String(improved);
              const remoteDetails =
                improved instanceof McpRemoteToolResultError
                  ? improved.details
                  : error instanceof McpRemoteToolResultError
                    ? error.details
                    : undefined;
              const timeoutDetails =
                !remoteDetails &&
                (improved instanceof McpRunTimeoutError ||
                  /\b(?:timed?\s*out|timeout)\b/i.test(message))
                  ? {
                      code: "timeout",
                      message:
                        improved instanceof McpRunTimeoutError
                          ? message
                          : `MCP tool call ${server}.${property} timed out.`,
                      retryable: true,
                      action: "inspect_state",
                      outcome:
                        improved instanceof McpRunTimeoutError ? "not_started" : "unknown",
                    }
                  : undefined;
              throw new McpRunToolError(
                server,
                property,
                remoteDetails?.message ?? timeoutDetails?.message ?? message,
                { cause: improved, details: remoteDetails ?? timeoutDetails }
              );
            } finally {
              release?.();
            }
          })();
          const record: ToolCallRecord = {
            ref: `${server}.${property}`,
            observed: false,
            outcome: "pending",
            promise: rawCall,
          };
          calls.push(record);
          rawCall.then(
            () => {
              record.outcome = "succeeded";
            },
            (error: unknown) => {
              record.outcome = "failed";
              record.error = error instanceof Error ? error.message : String(error);
            }
          );
          // JSON.stringify(promise) is "{}" — the classic missing-await
          // symptom. Make it print a diagnosis instead.
          return new Proxy(rawCall, {
            get(target, key) {
              if (key === "toJSON") {
                return () => `[pending tool call ${server}.${property} — did you forget await?]`;
              }
              if (key === "then" || key === "catch" || key === "finally") {
                record.observed = true;
              }
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        };

        const tool = ((args: Record<string, unknown> = {}) =>
          startCall(args, "json")) as McpRunToolFunction;
        tool.text = (args: Record<string, unknown> = {}) => startCall(args, "text");
        tool.markdown = (args: Record<string, unknown> = {}) => startCall(args, "markdown");
        tool.images = (args: Record<string, unknown> = {}) => startCall(args, "images");
        tool.content = (args: Record<string, unknown> = {}) => startCall(args, "content");
        tool.structuredContent = (args: Record<string, unknown> = {}) =>
          startCall(args, "structuredContent");
        tool.raw = (args: Record<string, unknown> = {}) => startCall(args, "raw");
        return tool;
      },
    }) as Record<string, McpRunToolFunction>;
  }
  // Fail with a clear message when a script names a server that does not
  // exist, instead of "Cannot read properties of undefined".
  const tools = new Proxy(toolsByServer, {
    get(target, property) {
      if (typeof property !== "string" || PROXY_PROBE_PROPS.has(property)) return undefined;
      if (property in target) return target[property];
      throw new Error(describeUnknownRunServer(property, servers));
    },
  });
  return {
    runtime,
    tools,
    calls,
    cancelQueued: (error: unknown) => queue.cancel(error),
  };
}

// vars.TYPO silently becomes undefined, which strips the argument it feeds
// and can turn a targeted query into a match-everything one. Throw instead.
function createVars(vars: Record<string, string>): Record<string, string> {
  return new Proxy({ ...vars }, {
    get(target, property) {
      if (typeof property !== "string" || PROXY_PROBE_PROPS.has(property)) return undefined;
      if (property in target) return target[property as keyof typeof target];
      const defined = Object.keys(target);
      throw new Error(
        `vars.${property} is not defined. Pass it with --var ${property}=value` +
          (defined.length > 0 ? ` (defined vars: ${defined.join(", ")}).` : " (no vars were passed).") +
          ` Use \`"${property}" in vars\` to test for optional vars.`
      );
    },
  });
}

function createRunProcess(): NodeJS.Process {
  return new Proxy(globalThis.process, {
    get(target, property) {
      if (property === "argv") {
        throw new McpRunUsageError(
          "process.argv is unavailable in mcp run. Pass dynamic values with --var KEY=value and read them as vars.KEY."
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function concurrentOutcomeError(
  error: McpRunToolError,
  calls: ToolCallRecord[]
): McpRunToolError {
  if (calls.length < 2) return error;
  const outcomes = calls.map((call) => ({
    ref: call.ref,
    outcome: call.outcome,
    ...(call.error ? { error: call.error } : {}),
  }));
  const summary = outcomes.map((call) => `${call.ref}=${call.outcome}`).join(", ");
  const message = `${error.message} Workflow call outcomes: ${summary}. Inspect state before retrying side-effecting calls.`;
  return new McpRunToolError(error.server, error.tool, message, {
    cause: error,
    details: { ...error.details, message, calls: outcomes },
  });
}

function positiveInteger(
  value: number | string | undefined,
  label: string,
  fallback: number
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new McpRunUsageError(`${label} expects a positive integer, got '${value ?? ""}'.`);
  }
  return parsed;
}

export async function runMcpJavaScript(
  code: string,
  opts: {
    timeoutMs?: number;
    callTimeoutMs?: number;
    maxCalls?: number;
    maxConcurrentCalls?: number;
    vars?: Record<string, string>;
  } = {}
): Promise<void> {
  const timeoutMs = positiveInteger(
    opts.timeoutMs ?? process.env.PI_RECIPES_MCP_RUN_TIMEOUT_MS,
    "PI_RECIPES_MCP_RUN_TIMEOUT_MS",
    DEFAULT_RUN_TIMEOUT_MS
  );
  const callTimeoutMs = positiveInteger(
    opts.callTimeoutMs ?? process.env.PI_RECIPES_MCP_RUN_CALL_TIMEOUT_MS,
    "PI_RECIPES_MCP_RUN_CALL_TIMEOUT_MS",
    Math.min(DEFAULT_TOOL_CALL_TIMEOUT_MS, timeoutMs)
  );
  const maxCalls = positiveInteger(
    opts.maxCalls ?? process.env.PI_RECIPES_MCP_RUN_MAX_CALLS,
    "PI_RECIPES_MCP_RUN_MAX_CALLS",
    DEFAULT_MAX_RUN_TOOL_CALLS
  );
  const maxConcurrentCalls = positiveInteger(
    opts.maxConcurrentCalls ?? process.env.PI_RECIPES_MCP_RUN_MAX_CONCURRENCY,
    "PI_RECIPES_MCP_RUN_MAX_CONCURRENCY",
    DEFAULT_MAX_CONCURRENT_TOOL_CALLS
  );
  const deadlineMs = Date.now() + timeoutMs;
  const { runtime, tools, calls, cancelQueued } = await createTools({
    callTimeoutMs,
    maxCalls,
    maxConcurrentCalls,
    deadlineMs,
  });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (tools: unknown, vars: Record<string, string>, process: NodeJS.Process) => Promise<unknown>;
  const run = new AsyncFunction("tools", "vars", "process", code);
  let timeout: NodeJS.Timeout | undefined;
  let primaryError: unknown;
  try {
    let scriptError: unknown;
    try {
      await Promise.race([
        run(tools, createVars(opts.vars ?? {}), createRunProcess()),
        new Promise((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new McpRunTimeoutError(
                `mcp run timed out after ${timeoutMs}ms. Remote side effects may already have occurred; inspect state before retrying.`
              )
            );
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      scriptError = error;
    }

    // A workflow deadline is also the cancellation boundary. mcporter 0.12.3
    // does not expose an AbortSignal, but it does forward each effective
    // timeout to the MCP SDK. Cancel calls that have not started, then close
    // the runtime in finally to tear down active transports.
    if (scriptError instanceof McpRunTimeoutError) {
      cancelQueued(scriptError);
      for (const call of calls) {
        if (call.outcome === "pending") call.outcome = "outcome_unknown";
      }
      throw scriptError;
    }

    // Accessing .then/.catch is not proof that a detached chain was awaited.
    // Anything still pending when the script returns is unsafe even if a
    // handler was attached, because closing the runtime can cut it off.
    const unsafeAtExit = calls.filter(
      (call) => !call.observed || call.outcome === "pending"
    );
    if (unsafeAtExit.length > 0) {
      const remainingSettleMs = Math.max(0, Math.min(15_000, deadlineMs - Date.now()));
      if (remainingSettleMs > 0) {
        let settleTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            Promise.allSettled(unsafeAtExit.map((call) => call.promise)),
            new Promise((resolve) => {
              settleTimer = setTimeout(resolve, remainingSettleMs);
            }),
          ]);
        } finally {
          if (settleTimer) clearTimeout(settleTimer);
        }
      }
      for (const call of unsafeAtExit) {
        if (call.outcome === "pending") call.outcome = "outcome_unknown";
      }
      // Promise.all rejects as soon as one member fails, while its already-
      // observed siblings keep running. We wait those siblings above before
      // closing the transport. Once they have settled, do not misreport them
      // as detached calls; surface the original tool error instead.
      const remainingUnsafe = unsafeAtExit.filter(
        (call) => !call.observed || call.outcome === "outcome_unknown"
      );
      if (
        scriptError instanceof McpRunToolError &&
        remainingUnsafe.length === 0
      ) {
        throw concurrentOutcomeError(scriptError, calls);
      }
      const summary = unsafeAtExit
        .map(
          (call) =>
            `${call.ref}=${call.outcome}` +
            (call.error ? ` (${call.error})` : "")
        )
        .join(", ");
      throw new McpRunUsageError(
        `mcp run: ${unsafeAtExit.length} tool call(s) were not awaited: ${summary}. ` +
          "Await or return every tool-call chain before the script exits; " +
          "attaching .then/.catch without awaiting the chain is not enough. " +
          "Remote side effects may already have occurred." +
          (scriptError
            ? ` The script also failed: ${scriptError instanceof Error ? scriptError.message : String(scriptError)}.`
            : "")
      );
    }
    if (scriptError) throw scriptError;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    try {
      await runtime.close();
    } catch (closeError) {
      // Transport cleanup must not replace the typed tool/script error that
      // tells the agent what actually failed. A close-only failure still
      // surfaces normally.
      if (primaryError === undefined) throw closeError;
    }
  }
}

// The soft timeout in runMcpJavaScript is a Promise.race, which a script that
// never yields (a synchronous busy-loop) starves forever. Worker threads run
// their own event loop, so a watchdog there can still fire and kill the
// process with a diagnostic once the deadline plus a grace period passes.
const RUN_WATCHDOG_GRACE_MS = 2_000;

function startRunWatchdog(timeoutMs: number): () => void {
  const worker = new Worker(
    `const { workerData } = require("node:worker_threads");
     const { writeSync } = require("node:fs");
     setTimeout(() => {
       writeSync(
         2,
         "mcp run: killed after " + workerData.limitMs + "ms. The script never yielded " +
           "(synchronous busy-loop?) or ignored the timeout. Use await inside loops and " +
           "set PI_RECIPES_MCP_RUN_TIMEOUT_MS to adjust the limit. Remote side effects " +
           "may already have occurred; inspect state before retrying.\\n"
       );
       process.kill(process.pid, "SIGKILL");
     }, workerData.limitMs);`,
    { eval: true, workerData: { limitMs: timeoutMs + RUN_WATCHDOG_GRACE_MS } }
  );
  worker.unref();
  return () => void worker.terminate();
}

async function runCode(args: string[]): Promise<number> {
  const vars: Record<string, string> = {};
  const positional: string[] = [];
  let jsonErrors = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json-errors") {
      jsonErrors = true;
      continue;
    }
    const inline = arg.startsWith("--var=") ? arg.slice("--var=".length) : undefined;
    const value = inline ?? (arg === "--var" ? args[++index] : undefined);
    if (arg === "--var" || inline !== undefined) {
      const eq = value?.indexOf("=") ?? -1;
      if (value === undefined || eq < 1) {
        stderr.write("--var expects KEY=value.\n");
        return 2;
      }
      vars[value.slice(0, eq)] = value.slice(eq + 1);
      continue;
    }
    positional.push(arg);
  }
  const file = positional[0];
  if (positional.length > 1) {
    stderr.write("mcp run accepts at most one file path.\n");
    return 2;
  }
  const code = file ? await readFile(file, "utf8") : await readStdin();
  if (!code.trim()) {
    stderr.write(
      "mcp run: empty script. Pass a file path or pipe JavaScript on stdin (see `mcp run --help`).\n"
    );
    return 2;
  }
  let timeoutMs: number;
  try {
    timeoutMs = positiveInteger(
      process.env.PI_RECIPES_MCP_RUN_TIMEOUT_MS,
      "PI_RECIPES_MCP_RUN_TIMEOUT_MS",
      DEFAULT_RUN_TIMEOUT_MS
    );
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const stopWatchdog = startRunWatchdog(timeoutMs);
  try {
    await runMcpJavaScript(code, { vars, timeoutMs });
  } catch (error) {
    // Keep the error class visible for non-generic failures (SyntaxError,
    // TypeError, ...) so script bugs read differently from tool failures.
    const message =
      error instanceof Error
        ? error.name === "Error"
          ? error.message
          : `${error.name}: ${error.message}`
        : String(error);
    const prefixed = message.startsWith("mcp run") ? message : `mcp run: ${message}`;
    const code = error instanceof McpRunUsageError ? 2 : 1;
    if (jsonErrors) {
      const remoteDetails = error instanceof McpRunToolError ? error.details : undefined;
      stderr.write(
        `${JSON.stringify({
          error: {
            ...remoteDetails,
            code:
              remoteDetails?.code ??
              (error instanceof McpRunUsageError
                ? "invalid_usage"
                : error instanceof McpRunToolError
                  ? "tool_execution"
                  : error instanceof McpRunTimeoutError
                    ? "timeout"
                    : "script_failure"),
            message: remoteDetails?.message ?? prefixed,
            retryable: remoteDetails?.retryable ?? false,
            action:
              remoteDetails?.action ??
              (error instanceof McpRunUsageError
                ? "correct_script"
                : error instanceof McpRunTimeoutError
                  ? "inspect_state"
                  : "inspect_error"),
            ...(error instanceof McpRunTimeoutError
              ? { outcome: error.outcome }
              : {}),
            ...(error instanceof McpRunToolError
              ? { server: error.server, tool: error.tool }
              : {}),
          },
        })}\n`
      );
    } else {
      stderr.write(`${prefixed}\n`);
    }
    return code;
  } finally {
    stopWatchdog();
  }
  return 0;
}

export function outputSchemaSection(manifest: McpManifest, ref: string): string | null {
  const dot = ref.indexOf(".");
  if (dot < 1) return null;
  const serverId = ref.slice(0, dot);
  const toolName = ref.slice(dot + 1);
  const tool = manifest.servers
    ?.find((server) => server.id === serverId)
    ?.tools?.find((entry) => entry.name === toolName);
  if (!tool?.output_schema) return null;
  const json = JSON.stringify(tool.output_schema, null, 2).replace(/^/gm, "      ");
  return `\n  Output schema (response shape):\n${json}\n`;
}

async function appendOutputSchema(args: string[], exitCode: number): Promise<void> {
  if (
    exitCode !== 0 ||
    args[0] !== "list" ||
    !args.includes("--schema") ||
    args.includes("--json")
  ) return;
  const ref = args[1];
  if (!ref || !ref.includes(".") || ref.startsWith("-")) return;
  try {
    const section = outputSchemaSection(await readManifest(), ref);
    if (section) stdout.write(section);
  } catch {
    // The manifest is a session artifact; mcporter's input schema still rendered.
  }
}

export function createDelegatedErrorFilter(write: (text: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = "";
  let sawOAuthMetadataError = false;
  const emit = (line: string) => {
    // Keep mcporter's message, but omit implementation stack frames that do
    // not help an agent recover.
    if (/^\s+at\s\S/.test(line)) return;
    if (/trying to load OAuth metadata/.test(line)) sawOAuthMetadataError = true;
    const safe = line
      .replace(
        /Tool '([^']+)' is not accessible on server '([^']+)' \(blocked by configuration\)/g,
        "Tool '$1' is not enabled on server '$2' in this recipe session"
      )
      .replace(
        /Failed to resolve header 'Authorization' for server '([^']+)': Environment variable\(s\) [A-Z0-9_, ]+ must be set for MCP header substitution\./g,
        "Authentication is required for MCP server '$1'. Ask the user to authenticate this MCP connection outside the agent session, then retry."
      )
      .replace(
        /Next: run ['`]mcporter auth [^'`]+['`] to finish authentication\.?/gi,
        "Authentication is required. Ask the user to authenticate this MCP connection outside the agent session, then retry."
      );
    write(safe);
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        emit(buffer.slice(0, index + 1));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer) emit(buffer);
      buffer = "";
      if (sawOAuthMetadataError) {
        write(
          "Hint: this server is called with a configured bearer token; the token may be invalid or expired.\n"
        );
        sawOAuthMetadataError = false;
      }
    },
  };
}

export function duplicateCallArgumentKeys(args: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const token of args.slice(1)) {
    const plain = token.match(/^([A-Za-z_][A-Za-z0-9_.-]*)[:=]/)?.[1];
    const flag = token.match(/^--([A-Za-z_][A-Za-z0-9_.-]*)(?:=|$)/)?.[1];
    const rawKey = plain ?? flag;
    if (!rawKey) continue;
    const key = rawKey.replace(
      /-([a-zA-Z0-9])/g,
      (_match, char: string) => char.toUpperCase()
    );
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

export function malformedCallExpression(args: string[]): string | null {
  const ref = args.find((arg) => !arg.startsWith("-"));
  if (!ref || !/[()]/.test(ref)) return null;
  let depth = 0;
  let inString: '"' | "'" | null = null;
  for (let index = 0; index < ref.length; index += 1) {
    const char = ref[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'") inString = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (depth < 0) break;
  }
  if (depth === 0 && inString === null && /^[\w-]+\.[\w-]+\(.*\)$/s.test(ref)) return null;
  return (
    `mcp call: malformed tool expression '${ref}'. ` +
    `Use mcp call '<server>.<tool>(key: "value")' with balanced quotes and parentheses, ` +
    `or plain arguments: mcp call <server>.<tool> key:value.`
  );
}

function usesMachineReadableOutput(args: readonly string[]): boolean {
  if (args[0] === "list") return args.includes("--json");
  if (args[0] !== "call") return false;
  return args.some(
    (arg, index) =>
      arg === "--output=json" ||
      (arg === "--output" && args[index + 1] === "json")
  );
}

function delegateToMcporter(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [mcporterCliEntrypointPath(), ...args], {
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });
    const preserve = usesMachineReadableOutput(args);
    const stderrFilter = createDelegatedErrorFilter((text) => stderr.write(text));
    child.stdout.on("data", (chunk) => stdout.write(chunk));
    child.stderr.on("data", (chunk) => {
      if (preserve) stderr.write(chunk);
      else stderrFilter.push(String(chunk));
    });
    child.on("close", (code) => {
      if (!preserve) stderrFilter.flush();
      resolve(code ?? 1);
    });
  });
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (
    args.length === 0 ||
    args[0] === "--help" ||
    args[0] === "-h" ||
    (args[0] === "help" && args.length === 1)
  ) {
    stdout.write(`${mcpCliHelpText()}\n`);
    return 0;
  }
  if (args[0] === "search" && isHelpArg(args[1])) {
    stdout.write(`${mcpSearchHelpText()}\n`);
    return 0;
  }
  if (args[0] === "list" && args.slice(1).some(isHelpArg)) {
    stdout.write(`${mcpListHelpText()}\n`);
    return 0;
  }
  if (args[0] === "call" && args.slice(1).some(isHelpArg)) {
    stdout.write(`${mcpCallHelpText()}\n`);
    return 0;
  }
  if (args[0] === "run" && isHelpArg(args[1])) {
    stdout.write(`${mcpRunHelpText()}\n`);
    return 0;
  }
  pinSessionMcporterConfig();
  if (args[0] === "run") return runCode(args.slice(1));
  if (args[0] === "search") return searchCatalog(args.slice(1));
  if (args[0] === "call") {
    const malformed = malformedCallExpression(args.slice(1));
    if (malformed) {
      stderr.write(`${malformed}\n`);
      return 2;
    }
  }
  let validated;
  try {
    validated = validateDelegatedMcpCommand(args, await sessionCliPolicy());
  } catch (error) {
    stderr.write(`mcp: failed to load the session MCP policy: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (validated.error) {
    stderr.write(`mcp: ${validated.error}\n`);
    return 2;
  }
  if (!validated.command) {
    stderr.write("mcp: invalid session command policy result.\n");
    return 1;
  }
  if (args[0] === "call") {
    const duplicates = duplicateCallArgumentKeys(
      validated.command.args.slice(1)
    );
    if (duplicates.length > 0) {
      stderr.write(
        `mcp call: argument${duplicates.length === 1 ? "" : "s"} ${duplicates
          .map((key) => `'${key}'`)
          .join(", ")} ${duplicates.length === 1 ? "was" : "were"} passed more than once. ` +
          "Pass each argument exactly once.\n"
      );
      return 2;
    }
  }
  const delegatedArgs = validated.command.args;
  const code = await delegateToMcporter(delegatedArgs);
  await appendOutputSchema(delegatedArgs, code);
  return code;
}

if (isDirectEntry(import.meta.url)) {
  let brokenPipe = false;
  const handleOutputError = (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      // A downstream command such as `head` intentionally closed the pipe.
      // Treat that as normal Unix pipeline completion and avoid leaking a Node
      // stack trace after the MCP operation has already produced its result.
      brokenPipe = true;
      return;
    }
    throw error;
  };
  stdout.on("error", handleOutputError);
  stderr.on("error", handleOutputError);
  main()
    .then((code) => {
      process.exitCode = brokenPipe ? 0 : code;
    })
    .catch((err: unknown) => {
      if (brokenPipe) {
        process.exitCode = 0;
        return;
      }
      stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
