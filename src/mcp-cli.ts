#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin as input, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { createCallResult, createRuntime } from "mcporter";
import {
  defaultMcpManifestPath,
  mcporterCliEntrypointPath,
  type McpManifest,
  type McpManifestTool,
} from "./mcp.js";

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const MCP_MANIFEST_ENV = "PI_RECIPES_MCP_MANIFEST";
const LEGACY_MCP_MANIFEST_ENV = "INTRO" + "SPECTION_MCP_MANIFEST";

export interface ToolSearchMatch {
  ref: string;
  server: string;
  tool: string;
  description: string;
  required: string[];
  score: number;
  inspect: string;
  call: string;
}

function usage(): string {
  return [
    "mcp - use available MCP tools",
    "",
    "Find tools:",
    "  mcp search \"what you need\"",
    "  mcp search \"tool|argument\" --regex --json",
    "  mcp list",
    "  mcp list <server>",
    "  mcp list <server.tool> --schema",
    "",
    "Call one tool:",
    "  mcp call <server>.<tool> key:value ...",
    "  mcp call '<server>.<tool>(key: \"value\")'",
    "",
    "Run a short workflow:",
    "  mcp run <<'EOF'",
    "  const result = await tools.<server>.<tool>({ key: \"value\" })",
    "  console.log(JSON.stringify(result, null, 2))",
    "  EOF",
    "",
    "When to use:",
    "  Use search when you do not know the right tool.",
    "  Use list --schema before guessing arguments.",
    "  Use mcp call for a single simple operation.",
    "  Use mcp run for multiple calls, filtering, ranking, or dedupe.",
    "  Use @file for long text and --output json when piping call output.",
  ].join("\n");
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

function normalizeToolResult(result: unknown): unknown {
  const callResult = createCallResult(result);
  const json = callResult.json();
  if (json !== null) return json;
  const structured = callResult.structuredContent();
  if (structured !== undefined && structured !== null) return structured;
  const text = callResult.text();
  return text ?? result;
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
  if (/^(q|query|search)$/i.test(name)) return `:'example query'`;
  if (/limit|count|max/i.test(name)) return ":10";
  if (/^(id|.*Id)$/i.test(name)) return ":<id>";
  return ":<value>";
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
        description: tool.description ?? "",
        required: toolRequired(tool),
        score,
        inspect: `mcp list ${ref} --schema`,
        call: callExample(server.id, tool),
      });
    }
  }
  return matches
    .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref))
    .slice(0, opts.limit ?? 8);
}

async function readManifest(): Promise<McpManifest> {
  const path =
    process.env[MCP_MANIFEST_ENV] ||
    process.env[LEGACY_MCP_MANIFEST_ENV] ||
    defaultMcpManifestPath(process.cwd());
  const data = await readFile(path, "utf8");
  return JSON.parse(data) as McpManifest;
}

function parseSearchArgs(args: string[]): {
  query: string;
  limit: number;
  json: boolean;
  regex: boolean;
} {
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
    if (arg === "--limit") {
      const value = Number(args[index + 1]);
      if (Number.isFinite(value) && value > 0) limit = Math.floor(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (Number.isFinite(value) && value > 0) limit = Math.floor(value);
      continue;
    }
    queryParts.push(arg);
  }
  return { query: queryParts.join(" "), limit, json, regex };
}

async function searchCatalog(args: string[]): Promise<number> {
  const { query, limit, json, regex } = parseSearchArgs(args);
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
    stdout.write("Try broader terms, or run `mcp list` to inspect available servers.\n");
    return 0;
  }
  stdout.write(`Found ${matches.length} matching tool${matches.length === 1 ? "" : "s"}\n\n`);
  for (const match of matches) {
    stdout.write(`${match.ref}\n`);
    if (match.description) stdout.write(`  ${match.description}\n`);
    if (match.required.length > 0) stdout.write(`  Required: ${match.required.join(", ")}\n`);
    stdout.write(`  Inspect: ${match.inspect}\n`);
    stdout.write(`  Example: ${match.call}\n\n`);
  }
  return 0;
}

async function createTools() {
  const runtime = await createRuntime();
  const tools: Record<string, Record<string, (args?: Record<string, unknown>) => Promise<unknown>>> =
    Object.create(null);
  for (const server of runtime.listServers()) {
    tools[server] = new Proxy(Object.create(null), {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        if (property === "then") return undefined;
        return async (args: Record<string, unknown> = {}) =>
          normalizeToolResult(
            await runtime.callTool(server, property, {
              args,
            })
          );
      },
    }) as Record<string, (args?: Record<string, unknown>) => Promise<unknown>>;
  }
  return { runtime, tools };
}

export async function runMcpJavaScript(
  code: string,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const { runtime, tools } = await createTools();
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (tools: unknown) => Promise<unknown>;
  const run = new AsyncFunction("tools", code);
  const timeoutMs =
    opts.timeoutMs ?? Number(process.env.PI_RECIPES_MCP_RUN_TIMEOUT_MS ?? DEFAULT_RUN_TIMEOUT_MS);
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run(tools),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`mcp run timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    await runtime.close();
  }
}

async function runCode(args: string[]): Promise<number> {
  const file = args[0];
  if (args.length > 1) {
    stderr.write("mcp run accepts at most one file path.\n");
    return 2;
  }
  const code = file ? await readFile(file, "utf8") : await readStdin();
  await runMcpJavaScript(code);
  return 0;
}

function delegateToMcporter(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [mcporterCliEntrypointPath(), ...args], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (
    args.length === 0 ||
    args[0] === "--help" ||
    args[0] === "-h" ||
    (args[0] === "help" && args.length === 1)
  ) {
    stdout.write(`${usage()}\n`);
    return 0;
  }
  if (args[0] === "run") return runCode(args.slice(1));
  if (args[0] === "search") return searchCatalog(args.slice(1));
  return delegateToMcporter(args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
