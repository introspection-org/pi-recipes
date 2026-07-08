import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMcporterConfig,
  clearRecipeMcpManifest,
  configureMcpLocalConfigPath,
  defaultMcporterConfigPath,
  materializeRecipeMcpManifest,
  materializeSessionMcpCli,
  mcporterCliEntrypointPath,
  type RecipePackageManifest,
} from "../src/index.js";

const originalFetch = globalThis.fetch;

function recipeManifest(
  recipeDir: string,
  servers: Array<{ id: string; required?: boolean; allow?: string[] }>
): RecipePackageManifest {
  return {
    name: "demo",
    version: "1.0.0",
    path: recipeDir,
    resources: {
      agents: [],
      extensions: [],
      skills: [],
      prompts: [],
    },
    mcp: {
      manifests: [],
      servers: servers.map((server) => ({
        id: server.id,
        required: server.required ?? false,
        tools: { allow: server.allow ?? [] },
      })),
    },
    evals: { suites: [] },
  };
}

function writeLocalConfig(dir: string, servers: unknown[]): string {
  const path = join(dir, ".pi", "mcp.local.json");
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(path, JSON.stringify({ servers }));
  return path;
}

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function readMcporterConfig(cwd: string): {
  imports: string[];
  mcpServers: Record<string, { baseUrl: string; headers: Record<string, string>; allowedTools: string[] }>;
} {
  return JSON.parse(readFileSync(defaultMcporterConfigPath(cwd), "utf8"));
}

describe("recipe MCP materialization", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("configures the session local MCP config path from workspace or recipe files", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-config-"));
    try {
      const workspaceDir = join(root, "workspace");
      const recipeDir = join(root, "recipe");
      mkdirSync(join(workspaceDir, ".pi"), { recursive: true });
      mkdirSync(join(recipeDir, ".pi"), { recursive: true });
      const workspaceConfig = join(workspaceDir, ".pi", "mcp.local.json");
      const recipeConfig = join(recipeDir, ".pi", "mcp.local.json");
      writeFileSync(workspaceConfig, JSON.stringify({ servers: [] }));
      writeFileSync(recipeConfig, JSON.stringify({ servers: [] }));

      const workspaceEnv: NodeJS.ProcessEnv = {};
      expect(
        configureMcpLocalConfigPath({
          cwd: workspaceDir,
          recipeDir,
          env: workspaceEnv,
        })
      ).toBe(workspaceConfig);
      expect(workspaceEnv.PI_RECIPES_MCP_LOCAL_CONFIG).toBe(workspaceConfig);
      expect(workspaceEnv.INTROSPECTION_MCP_LOCAL_CONFIG).toBe(workspaceConfig);

      rmSync(workspaceConfig);
      const recipeEnv: NodeJS.ProcessEnv = {};
      expect(
        configureMcpLocalConfigPath({
          cwd: workspaceDir,
          recipeDir,
          env: recipeEnv,
        })
      ).toBe(recipeConfig);
      expect(recipeEnv.PI_RECIPES_MCP_LOCAL_CONFIG).toBe(recipeConfig);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts the legacy local MCP config env var as an alias", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-legacy-"));
    try {
      const configured = join(root, "custom.local.json");
      writeFileSync(configured, JSON.stringify({ servers: [] }));
      const env: NodeJS.ProcessEnv = {
        INTROSPECTION_MCP_LOCAL_CONFIG: configured,
      };
      expect(
        configureMcpLocalConfigPath({ cwd: root, recipeDir: root, env })
      ).toBe(configured);
      expect(env.PI_RECIPES_MCP_LOCAL_CONFIG).toBe(configured);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not write a fake manifest when live tool discovery returns no catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-fallback-"));
    try {
      const cwd = join(root, "workspace");
      const recipeDir = join(root, "recipe");
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      mkdirSync(recipeDir, { recursive: true });
      const staleManifest = join(cwd, ".pi", "mcp.json");
      writeFileSync(
        staleManifest,
        JSON.stringify({
          servers: [
            {
              id: "slack",
              base_url: "http://stale.invalid/mcp",
              tools: [{ name: "slack_list_threads" }],
            },
          ],
        })
      );
      const localConfig = writeLocalConfig(cwd, [
        {
          id: "slack",
          transport: "streamable_http",
          url: "${SLACK_MCP_URL}",
          headers: { Authorization: "Bearer ${SLACK_MCP_TOKEN}" },
        },
      ]);

      const env: NodeJS.ProcessEnv = {
        PI_RECIPES_MCP_LOCAL_CONFIG: localConfig,
        SLACK_MCP_URL: "http://127.0.0.1:3201/mcp",
        SLACK_MCP_TOKEN: "slack-token",
      };
      const fetchImpl = vi.fn(
        async () => new Response("unauthorized", { status: 401 })
      ) as unknown as typeof fetch;

      const manifest = await materializeRecipeMcpManifest({
        cwd,
        recipeDir,
        env,
        fetch: fetchImpl,
        agentTools: ["mcp:slack/slack_list_threads"],
        manifest: recipeManifest(recipeDir, [
          { id: "slack", allow: ["slack_list_threads"] },
        ]),
      });

      expect(env.PI_RECIPES_MCP_MANIFEST).toBeUndefined();
      expect(manifest.servers).toEqual([]);
      expect(manifest.diagnostics).toEqual([
        {
          serverId: "slack",
          url: "http://127.0.0.1:3201/mcp",
          stage: "initialize",
          status: 401,
          message: "Response body: unauthorized",
        },
      ]);
      expect(existsSync(staleManifest)).toBe(false);

      // An empty mcporter config is still written so a stale `mcp` shim
      // resolves to "no servers", never to mcporter's host-level configs.
      expect(env.MCPORTER_CONFIG).toBe(defaultMcporterConfigPath(cwd));
      expect(readMcporterConfig(cwd)).toEqual({ imports: [], mcpServers: {} });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports discovered MCP tools that do not match recipe policy refs", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-filter-"));
    try {
      const cwd = join(root, "workspace");
      const recipeDir = join(root, "recipe");
      mkdirSync(recipeDir, { recursive: true });
      const localConfig = writeLocalConfig(cwd, [
        {
          id: "slack",
          transport: "streamable_http",
          url: "http://127.0.0.1:3201/mcp",
          headers: { Authorization: "Bearer ${SLACK_MCP_TOKEN}" },
        },
      ]);

      const auths: Array<string | undefined> = [];
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
          auths.push((init?.headers as Record<string, string>).Authorization);
          if (body.method === "initialize") {
            return jsonResponse(
              { jsonrpc: "2.0", id: 1, result: {} },
              { "mcp-session-id": "mcp-session-1" }
            );
          }
          if (body.method === "notifications/initialized") {
            return jsonResponse({ jsonrpc: "2.0", result: {} });
          }
          return jsonResponse({
            jsonrpc: "2.0",
            id: 2,
            result: {
              tools: [
                { name: "slack_search" },
                { name: "slack_fetch" },
              ],
            },
          });
        }
      ) as unknown as typeof fetch;

      const manifest = await materializeRecipeMcpManifest({
        cwd,
        recipeDir,
        env: {
          PI_RECIPES_MCP_LOCAL_CONFIG: localConfig,
          SLACK_MCP_TOKEN: "slack-token",
        },
        fetch: fetchImpl,
        agentTools: ["mcp:slack/slack_list_threads"],
        manifest: recipeManifest(recipeDir, [
          { id: "slack", allow: ["slack_list_threads"] },
        ]),
      });

      expect(manifest.servers).toEqual([]);
      expect(manifest.diagnostics?.[0]).toMatchObject({
        serverId: "slack",
        stage: "filter",
      });
      expect(manifest.diagnostics?.[0]?.message).toContain("slack_fetch");
      expect(manifest.diagnostics?.[0]?.message).toContain("slack_list_threads");
      // Discovery calls interpolate `${VAR}` refs from the environment.
      expect(auths.every((auth) => auth === "Bearer slack-token")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scrubs filtered MCP tool names from materialized tool descriptions", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-description-filter-"));
    try {
      const cwd = join(root, "workspace");
      const recipeDir = join(root, "recipe");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(recipeDir, { recursive: true });
      writeFileSync(
        join(recipeDir, "mcp.json"),
        JSON.stringify({
          servers: [
            {
              id: "slack",
              base_url: "https://mcp.slack.com/mcp",
              tools: [
                {
                  name: "slack_read_channel",
                  description:
                    "Reads messages. Use slack_search_channels to find a channel ID by name. Use slack_read_thread for replies.",
                },
                {
                  name: "slack_search_channels",
                  description: "Find channels.",
                },
                {
                  name: "slack_read_thread",
                  description: "Read replies.",
                },
              ],
            },
          ],
        })
      );

      const env: NodeJS.ProcessEnv = {};
      const manifest = await materializeRecipeMcpManifest({
        cwd,
        recipeDir,
        env,
        fetch: globalThis.fetch,
        agentTools: ["mcp:slack/slack_read_channel"],
        manifest: recipeManifest(recipeDir, [
          { id: "slack", allow: ["slack_read_channel"] },
        ]),
      });

      const description = manifest.servers?.[0]?.tools?.[0]?.description ?? "";
      expect(manifest.servers?.[0]?.tools?.map((tool) => tool.name)).toEqual([
        "slack_read_channel",
      ]);
      expect(description).not.toContain("slack_search_channels");
      expect(description).not.toContain("slack_read_thread");
      expect(description).toContain("[unavailable MCP tool]");

      // The mcporter config mirrors the filtered manifest: only allowed
      // tools, session-token header as an env reference (never a value).
      expect(env.MCPORTER_CONFIG).toBe(defaultMcporterConfigPath(cwd));
      expect(readMcporterConfig(cwd)).toEqual({
        imports: [],
        mcpServers: {
          slack: {
            baseUrl: "https://mcp.slack.com/mcp",
            headers: { Authorization: "Bearer ${INTROSPECTION_TOKEN}" },
            allowedTools: ["slack_read_channel"],
          },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects local bindings into the mcporter config with raw header refs", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcporter-local-"));
    try {
      const localConfig = writeLocalConfig(root, [
        {
          id: "slack",
          transport: "streamable_http",
          url: "http://127.0.0.1:3201/mcp",
          headers: { Authorization: "Bearer ${SLACK_MCP_TOKEN}" },
        },
      ]);
      const config = buildMcporterConfig(
        {
          servers: [
            {
              id: "slack",
              base_url: "http://127.0.0.1:3201/mcp",
              tools: [{ name: "slack_search" }],
            },
          ],
        },
        {
          cwd: root,
          env: {
            PI_RECIPES_MCP_LOCAL_CONFIG: localConfig,
            SLACK_MCP_TOKEN: "resolved-secret",
          },
        }
      );

      // The `${VAR}` reference is emitted verbatim — never the resolved
      // secret — because mcporter interpolates env refs at config load.
      expect(config).toEqual({
        imports: [],
        mcpServers: {
          slack: {
            baseUrl: "http://127.0.0.1:3201/mcp",
            headers: { Authorization: "Bearer ${SLACK_MCP_TOKEN}" },
            allowedTools: ["slack_search"],
          },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears to an empty mcporter config so stale shims cannot see host servers", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcporter-clear-"));
    try {
      const env: NodeJS.ProcessEnv = {};
      await clearRecipeMcpManifest(env, root);
      expect(env.MCPORTER_CONFIG).toBe(defaultMcporterConfigPath(root));
      expect(readMcporterConfig(root)).toEqual({ imports: [], mcpServers: {} });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("materializes an mcp shim that pins MCPORTER_CONFIG and execs mcporter", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-shim-"));
    try {
      const env: NodeJS.ProcessEnv = {};
      const { binDir, shimPath } = await materializeSessionMcpCli({ cwd: root, env });
      const script = readFileSync(shimPath, "utf8");
      expect(script).toContain(mcporterCliEntrypointPath());
      expect(script).toContain(`MCPORTER_CONFIG:=${defaultMcporterConfigPath(root)}`);
      expect(env.PI_RECIPES_MCP_BIN_DIR).toBe(binDir);
      expect(env.PATH?.split(":")).toContain(binDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mcporter CLI end-to-end", () => {
  function startStubMcpServer(expectedAuth: string): Promise<{ server: Server; url: string }> {
    const sessions = new Set<string>();
    const server = createServer((req, res) => {
      // The MCP SDK streamable-HTTP client also opens a GET SSE stream and
      // DELETEs the session on close; only POSTs carry JSON-RPC bodies.
      if (req.method === "GET") {
        res.writeHead(405).end();
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if ((req.headers.authorization ?? "") !== expectedAuth) {
          res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const msg = JSON.parse(body) as { id?: number; method?: string; params?: { name?: string; arguments?: unknown } };
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (msg.method === "initialize") {
          const sid = `sess-${sessions.size + 1}`;
          sessions.add(sid);
          headers["mcp-session-id"] = sid;
          res.writeHead(200, headers).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "stub", version: "1.0.0" },
              },
            })
          );
          return;
        }
        const sid = req.headers["mcp-session-id"];
        if (typeof sid !== "string" || !sessions.has(sid)) {
          res.writeHead(400, headers).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id ?? null,
              error: { code: -32000, message: "No valid session ID" },
            })
          );
          return;
        }
        if (msg.method === "notifications/initialized") {
          res.writeHead(202, headers).end();
          return;
        }
        if (msg.method === "tools/list") {
          res.writeHead(200, headers).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: [
                  {
                    name: "get_value",
                    description: "Get a value",
                    inputSchema: {
                      type: "object",
                      properties: { key: { type: "string" } },
                      required: ["key"],
                    },
                  },
                  { name: "hidden_tool", description: "Filtered out", inputSchema: { type: "object", properties: {} } },
                ],
              },
            })
          );
          return;
        }
        if (msg.method === "tools/call") {
          res.writeHead(200, headers).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `called ${msg.params?.name} with ${JSON.stringify(msg.params?.arguments)}`,
                  },
                ],
              },
            })
          );
          return;
        }
        res.writeHead(200, headers).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result: {} }));
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
      });
    });
  }

  function runMcporter(
    args: string[],
    env: Record<string, string>
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [mcporterCliEntrypointPath(), ...args], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  it("drives the real mcporter binary from a generated config", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcporter-e2e-"));
    const { server, url } = await startStubMcpServer("Bearer stub-token");
    try {
      const cwd = join(root, "workspace");
      const recipeDir = join(root, "recipe");
      mkdirSync(recipeDir, { recursive: true });
      const localConfig = writeLocalConfig(cwd, [
        {
          id: "stub",
          transport: "streamable_http",
          url,
          headers: { Authorization: "Bearer ${STUB_MCP_TOKEN}" },
        },
      ]);
      const env: NodeJS.ProcessEnv = {
        PI_RECIPES_MCP_LOCAL_CONFIG: localConfig,
        STUB_MCP_TOKEN: "stub-token",
      };
      const manifest = await materializeRecipeMcpManifest({
        cwd,
        recipeDir,
        env,
        fetch: globalThis.fetch,
        agentTools: ["mcp:stub/get_value"],
        manifest: recipeManifest(recipeDir, [{ id: "stub", allow: ["get_value"] }]),
      });
      expect(manifest.servers).toHaveLength(1);
      const configEnv = {
        MCPORTER_CONFIG: env.MCPORTER_CONFIG!,
        STUB_MCP_TOKEN: "stub-token",
      };

      const list = await runMcporter(["list", "stub", "--json"], configEnv);
      expect(list.code).toBe(0);
      const listed = JSON.parse(list.stdout) as {
        status: string;
        tools: Array<{ name: string }>;
      };
      expect(listed.status).toBe("ok");
      expect(listed.tools.map((tool) => tool.name)).toEqual(["get_value"]);

      const call = await runMcporter(["call", "stub.get_value", "key=color"], configEnv);
      expect(call.code).toBe(0);
      expect(call.stdout).toContain('called get_value with {"key":"color"}');

      // allowedTools gates calls, not just listings.
      const blocked = await runMcporter(["call", "stub.hidden_tool"], configEnv);
      expect(blocked.code).toBe(1);
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
