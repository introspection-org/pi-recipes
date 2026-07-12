import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aggregateListExitCode,
  callJsonArgumentError,
  createDelegatedErrorFilter,
  describeUnavailableRunTool,
  describeUnknownRunServer,
  McpRunToolError,
  parseListTimeoutMs,
  runMcpJavaScript,
  searchMcpTools,
  withListTimeout,
} from "../src/mcp-cli.js";
import {
  buildMcporterConfig,
  clearRecipeMcpManifest,
  configureMcpLocalConfigPath,
  defaultMcporterConfigPath,
  formatMcpDiscoveryDiagnostics,
  materializeRecipeMcpManifest,
  materializeSessionMcpCli,
  mcpCliEntrypointPath,
  mcporterCliEntrypointPath,
  type RecipePackageManifest,
} from "../src/index.js";

const originalFetch = globalThis.fetch;

describe("aggregate MCP list exit behavior", () => {
  it("tolerates unavailable optional servers by default", () => {
    expect(aggregateListExitCode(true, [])).toBe(0);
  });

  it("reports unavailable servers when explicitly requested", () => {
    expect(aggregateListExitCode(true, ["--quiet"])).toBe(1);
    expect(aggregateListExitCode(true, ["--exit-code"])).toBe(1);
    expect(aggregateListExitCode(false, ["--exit-code"])).toBe(0);
  });
});

function recipeManifest(
  recipeDir: string,
  servers: Array<{
    id: string;
    required?: boolean;
    include?: string[];
    exclude?: string[];
  }>,
  manifests: string[] = []
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
      manifests,
      servers: servers.map((server) => ({
        id: server.id,
        required: server.required ?? false,
        tools: {
          ...(server.include !== undefined
            ? { include: server.include }
            : {}),
          ...(server.exclude !== undefined ? { exclude: server.exclude } : {}),
        },
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
  mcpServers: Record<
    string,
    {
      baseUrl: string;
      headers: Record<string, string>;
      allowedTools: string[];
      auth?: "oauth";
    }
  >;
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

  it("fails closed when a required package tool is absent from discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-required-tool-"));
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
              id: "nextplay",
              base_url: "http://example.test/mcp",
              tools: [{ name: "search_profiles" }],
            },
          ],
        })
      );

      await expect(
        materializeRecipeMcpManifest({
          cwd,
          recipeDir,
          env: {},
          agentMcp: [
            { serverId: "nextplay", tools: { include: ["*"] } },
          ],
          manifest: recipeManifest(recipeDir, [
            {
              id: "nextplay",
              required: true,
              include: ["search_profiles", "get_profile"],
            },
          ], ["mcp.json"]),
        })
      ).rejects.toThrow(
        "Required MCP tool(s) missing from server 'nextplay': get_profile"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors the canonical local MCP config env override", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-config-override-"));
    try {
      const configured = join(root, "custom.local.json");
      writeFileSync(configured, JSON.stringify({ servers: [] }));
      const env: NodeJS.ProcessEnv = {
        PI_RECIPES_MCP_LOCAL_CONFIG: configured,
      };
      expect(
        configureMcpLocalConfigPath({ cwd: root, recipeDir: root, env })
      ).toBe(configured);
      expect(env.PI_RECIPES_MCP_LOCAL_CONFIG).toBe(configured);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires package, binding, and agent gates for configured MCP tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-gates-"));
    try {
      const cwd = join(root, "workspace");
      const recipeDir = join(root, "recipe");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(recipeDir, { recursive: true });
      const localConfig = writeLocalConfig(cwd, [
        {
          id: "nextplay",
          name: "nextplay staging",
          transport: "streamable_http",
          url: "http://mcp.nextplay.test/mcp",
          headers: { Authorization: "Bearer ${MCP_SESSION_TOKEN}" },
        },
      ]);

      const env: NodeJS.ProcessEnv = {
        MCP_SESSION_TOKEN: "session-token",
        PI_RECIPES_MCP_LOCAL_CONFIG: localConfig,
      };
      const authHeaders: Array<string | undefined> = [];
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        authHeaders.push((init?.headers as Record<string, string> | undefined)?.Authorization);
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          method?: string;
          params?: { cursor?: string };
        };
        if (body.method === "initialize") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "nextplay", version: "0.1.0" },
            },
          });
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (body.params?.cursor === "page-2") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: 3,
            result: {
              tools: [
                {
                  name: "get_profile",
                  annotations: { readOnlyHint: true, openWorldHint: false },
                },
              ],
            },
          });
        }
        return jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: {
            tools: [{ name: "search_positions" }],
            nextCursor: "page-2",
          },
        });
      }) as unknown as typeof fetch;

      const bindingOnly = await materializeRecipeMcpManifest({
        cwd,
        recipeDir,
        env,
        fetch: fetchImpl,
        manifest: recipeManifest(recipeDir, []),
      });
      expect(bindingOnly.servers).toEqual([]);
      expect(bindingOnly.diagnostics).toEqual([
        expect.objectContaining({
          code: "mcp.package_server_undeclared",
          serverId: "nextplay",
          stage: "filter",
          message: expect.stringContaining(
            "binding-only MCP access is no longer supported"
          ),
        }),
      ]);
      expect(
        formatMcpDiscoveryDiagnostics(bindingOnly.diagnostics ?? [])
      ).toContain("[mcp.package_server_undeclared]");

      const withoutPackage = await materializeRecipeMcpManifest({
        cwd,
        recipeDir,
        env,
        fetch: fetchImpl,
        agentMcp: [{ serverId: "nextplay", tools: { include: ["*"] } }],
        manifest: recipeManifest(recipeDir, []),
      });
      expect(withoutPackage.servers).toEqual([]);
      expect(withoutPackage.diagnostics).toEqual([
        expect.objectContaining({
          code: "mcp.package_server_undeclared",
          serverId: "nextplay",
          stage: "filter",
        }),
      ]);

      const withoutAgent = await materializeRecipeMcpManifest({
        cwd,
        recipeDir,
        env,
        fetch: fetchImpl,
        manifest: recipeManifest(recipeDir, [
          { id: "nextplay", include: ["*"] },
        ]),
      });
      expect(withoutAgent.servers).toEqual([]);
      expect(withoutAgent.diagnostics).toEqual([
        expect.objectContaining({
          code: "mcp.agent_server_unselected",
          serverId: "nextplay",
          stage: "filter",
        }),
      ]);

      const manifest = await materializeRecipeMcpManifest({
        cwd,
        recipeDir,
        env,
        fetch: fetchImpl,
        agentMcp: [{ serverId: "nextplay", tools: { include: ["*"] } }],
        manifest: recipeManifest(recipeDir, [
          { id: "nextplay", include: ["*"] },
        ]),
      });

      // The server-reported name becomes the callable id; the configured
      // binding id remains available for credential projection.
      expect(manifest.servers?.map((server) => server.id)).toEqual(["nextplay"]);
      expect(manifest.servers?.[0]?.name).toBe("nextplay");
      expect(manifest.diagnostics).toEqual([]);
      expect(manifest.servers?.[0]?.tools?.map((tool) => tool.name)).toEqual([
        "search_positions",
        "get_profile",
      ]);
      expect(manifest.servers?.[0]?.tools?.[1]?.annotations).toEqual({
        readOnlyHint: true,
        openWorldHint: false,
      });
      expect(authHeaders.every((value) => value === "Bearer session-token")).toBe(true);
      expect(readMcporterConfig(cwd).mcpServers.nextplay).not.toHaveProperty("auth");
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
        agentMcp: [{ serverId: "slack", tools: { include: ["slack_list_threads"] } }],
        manifest: recipeManifest(recipeDir, [
          { id: "slack", include: ["slack_list_threads"] },
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
              {
                jsonrpc: "2.0",
                id: 1,
                result: {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "slack", version: "1.0.0" },
                },
              },
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
        agentMcp: [{ serverId: "slack", tools: { include: ["slack_list_threads"] } }],
        manifest: recipeManifest(recipeDir, [
          { id: "slack", include: ["slack_list_threads"] },
        ]),
      });

      expect(manifest.servers).toEqual([]);
      expect(manifest.diagnostics?.[0]).toMatchObject({
        code: "mcp.tools_filtered",
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

  it("enforces the Streamable HTTP initialization lifecycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-lifecycle-"));
    try {
      const cwd = join(root, "workspace");
      const recipeDir = join(root, "recipe");
      mkdirSync(recipeDir, { recursive: true });
      const localConfig = writeLocalConfig(cwd, [
        { id: "nextplay", transport: "streamable_http", url: "https://nextplay.test/mcp" },
      ]);
      const base = {
        cwd,
        recipeDir,
        env: { PI_RECIPES_MCP_LOCAL_CONFIG: localConfig },
        agentMcp: [{ serverId: "nextplay", tools: { include: ["search_profiles"] } }],
        manifest: recipeManifest(recipeDir, [{ id: "nextplay", include: ["search_profiles"] }]),
      };
      const methods: string[] = [];
      const valid = await materializeRecipeMcpManifest({
        ...base,
        fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
          methods.push(body.method ?? String(init?.method));
          if (body.method === "initialize") {
            expect(new Headers(init?.headers).has("mcp-protocol-version")).toBe(false);
            return jsonResponse({
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "nextplay", version: "1.0.0" },
              },
            });
          }
          if (body.method === "notifications/initialized") {
            return new Response(null, { status: 202 });
          }
          return jsonResponse({
            jsonrpc: "2.0",
            id: 2,
            result: { tools: [{ name: "search_profiles", inputSchema: { type: "object" } }] },
          });
        }) as unknown as typeof fetch,
      });
      expect(valid.diagnostics).toEqual([]);
      expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);

      const requests: Array<{ method?: string; session?: string }> = [];
      const rejected = await materializeRecipeMcpManifest({
        ...base,
        fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          const body = init?.body ? JSON.parse(String(init.body)) as { method?: string } : {};
          const headers = new Headers(init?.headers);
          requests.push({ method: body.method ?? init?.method, session: headers.get("mcp-session-id") ?? undefined });
          if (body.method === "initialize") {
            return jsonResponse({
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "nextplay", version: "1.0.0" },
              },
            }, { "mcp-session-id": "session-1" });
          }
          if (init?.method === "DELETE") return new Response(null, { status: 405 });
          return new Response("rejected", { status: 400 });
        }) as unknown as typeof fetch,
      });
      expect(rejected.diagnostics?.[0]).toMatchObject({ stage: "initialize", status: 400 });
      expect(requests.at(-1)).toEqual({ method: "DELETE", session: "session-1" });

      const invalid = await materializeRecipeMcpManifest({
        ...base,
        fetch: vi.fn(async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} })) as unknown as typeof fetch,
      });
      expect(invalid.diagnostics?.[0]).toMatchObject({ stage: "initialize" });
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
        agentMcp: [{ serverId: "slack", tools: { include: ["slack_read_channel"] } }],
        manifest: recipeManifest(recipeDir, [
          { id: "slack", include: ["slack_read_channel"] },
        ], ["mcp.json"]),
      });

      const description = manifest.servers?.[0]?.tools?.[0]?.description ?? "";
      expect(manifest.servers?.[0]?.tools?.map((tool) => tool.name)).toEqual([
        "slack_read_channel",
      ]);
      expect(description).not.toContain("slack_search_channels");
      expect(description).not.toContain("slack_read_thread");
      expect(description).toContain("[unavailable MCP tool]");
      // The mcporter config mirrors the filtered static manifest. Static
      // public endpoints have no implicit deployment-specific credentials.
      expect(env.MCPORTER_CONFIG).toBe(defaultMcporterConfigPath(cwd));
      expect(readMcporterConfig(cwd)).toEqual({
        imports: [],
        mcpServers: {
          slack: {
            baseUrl: "https://mcp.slack.com/mcp",
            headers: {},
            allowedTools: ["slack_read_channel"],
          },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies package and agent MCP include/exclude selectors with exclusion precedence", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-selectors-"));
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
              id: "salesforce",
              base_url: "https://salesforce.example/mcp",
              tools: [
                { name: "search_accounts" },
                { name: "update_account" },
                { name: "export_all" },
                { name: "delete_org" },
              ],
            },
            {
              id: "hubspot",
              base_url: "https://hubspot.example/mcp",
              tools: [{ name: "get_contacts" }],
            },
          ],
        })
      );

      const manifest = await materializeRecipeMcpManifest({
        cwd,
        recipeDir,
        agentMcp: [
          {
            serverId: "salesforce",
            tools: {
              include: ["*"],
              exclude: ["export_all"],
            },
          },
        ],
        manifest: recipeManifest(recipeDir, [
          {
            id: "salesforce",
            include: ["*"],
            exclude: ["delete_org"],
          },
          { id: "hubspot", include: ["*"] },
        ], ["mcp.json"]),
      });

      expect(manifest.servers?.map((server) => server.id)).toEqual(["salesforce"]);
      expect(manifest.servers?.[0]?.tools?.map((tool) => tool.name)).toEqual([
        "search_accounts",
        "update_account",
      ]);

      const none = await materializeRecipeMcpManifest({
        cwd,
        recipeDir,
        agentMcp: [{ serverId: "salesforce", tools: { include: [] } }],
        manifest: recipeManifest(recipeDir, [
          { id: "salesforce", include: ["*"] },
        ], ["mcp.json"]),
      });
      expect(none.servers).toEqual([]);
      expect(none.diagnostics).toEqual([
        expect.objectContaining({
          code: "mcp.agent_tools_disabled",
          serverId: "salesforce",
          stage: "filter",
        }),
        expect.objectContaining({
          code: "mcp.package_server_undeclared",
          serverId: "hubspot",
          stage: "filter",
        }),
      ]);
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

  it("projects either configured OAuth or bearer headers without mixing them", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcporter-oauth-"));
    try {
      const localConfig = writeLocalConfig(root, [
        {
          id: "linear",
          transport: "streamable_http",
          url: "https://mcp.linear.app/mcp",
          auth: "oauth",
          oauthClientId: "local-client",
          oauthClientSecretEnv: "LINEAR_OAUTH_SECRET",
          oauthRedirectUrl: "http://127.0.0.1:8787/callback",
          oauthScope: "read write",
        },
      ]);
      const local = buildMcporterConfig(
        {
          servers: [
            {
              id: "linear",
              base_url: "https://mcp.linear.app/mcp",
              tools: [{ name: "list_issues" }],
            },
          ],
        },
        { cwd: root, env: { PI_RECIPES_MCP_LOCAL_CONFIG: localConfig } }
      );
      expect(local.mcpServers.linear).toMatchObject({
        auth: "oauth",
        oauthClientId: "local-client",
        oauthClientSecretEnv: "LINEAR_OAUTH_SECRET",
        oauthRedirectUrl: "http://127.0.0.1:8787/callback",
        oauthScope: "read write",
      });

      const bearerConfig = writeLocalConfig(root, [
        {
          id: "linear",
          transport: "streamable_http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer ${MCP_SESSION_TOKEN}" },
        },
      ]);
      const bearer = buildMcporterConfig(
        {
          servers: [
            {
              id: "linear",
              base_url: "https://mcp.linear.app/mcp",
              tools: [{ name: "list_issues" }],
            },
          ],
        },
        {
          cwd: root,
          env: {
            PI_RECIPES_MCP_LOCAL_CONFIG: bearerConfig,
          },
        }
      );
      expect(bearer.mcpServers.linear).not.toHaveProperty("auth");
      expect(bearer.mcpServers.linear.headers).toEqual({
        Authorization: "Bearer ${MCP_SESSION_TOKEN}",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches local credentials by binding identity when endpoints share a URL", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcporter-shared-url-"));
    try {
      const sharedUrl = "https://mcp.example.test/mcp";
      const localConfig = writeLocalConfig(root, [
        {
          id: "account-a",
          url: sharedUrl,
          headers: { "X-Account": "a" },
          auth: "oauth",
          oauthClientId: "client-a",
          tokenCacheDir: "/tmp/account-a",
        },
        {
          id: "account-b",
          url: sharedUrl,
          headers: { "X-Account": "b" },
          auth: "oauth",
          oauthClientId: "client-b",
          tokenCacheDir: "/tmp/account-b",
        },
      ]);
      const config = buildMcporterConfig(
        {
          servers: [
            {
              id: "account-a",
              base_url: sharedUrl,
              tools: [{ name: "lookup" }],
            },
            {
              id: "reported-name-2",
              binding_id: "account-b",
              base_url: sharedUrl,
              tools: [{ name: "lookup" }],
            },
          ],
        },
        { cwd: root, env: { PI_RECIPES_MCP_LOCAL_CONFIG: localConfig } }
      );

      expect(config.mcpServers["account-a"]).toMatchObject({
        headers: { "X-Account": "a" },
        oauthClientId: "client-a",
        tokenCacheDir: "/tmp/account-a",
      });
      expect(config.mcpServers["reported-name-2"]).toMatchObject({
        headers: { "X-Account": "b" },
        oauthClientId: "client-b",
        tokenCacheDir: "/tmp/account-b",
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

  it("materializes an mcp shim that pins MCPORTER_CONFIG and execs the recipe mcp CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-shim-"));
    try {
      const env: NodeJS.ProcessEnv = {};
      const { binDir, shimPath } = await materializeSessionMcpCli({ cwd: root, env });
      const script = readFileSync(shimPath, "utf8");
      expect(script).toContain(mcpCliEntrypointPath());
      expect(script).toContain(`MCPORTER_CONFIG:=${defaultMcporterConfigPath(root)}`);
      expect(env.PI_RECIPES_MCP_BIN_DIR).toBe(binDir);
      expect(env.PATH?.split(":")).toContain(binDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("searches the allowed MCP catalog and returns tool references", () => {
    const matches = searchMcpTools(
      {
        servers: [
          {
            id: "contacts",
            base_url: "http://example.test/mcp",
            tools: [
              {
                name: "search_contacts",
                description: "Search contacts by name, company, location, and notes.",
                input_schema: {
                  type: "object",
                  properties: {
                    q: { type: "string", description: "Natural language contact query" },
                    city: { type: "string", description: "City filter" },
                  },
                  required: ["q"],
                },
              },
              {
                name: "add_shortlist_entry",
                description: "Add a person to the shortlist.",
                input_schema: {
                  type: "object",
                  properties: {
                    personId: { type: "string", description: "Profile identifier" },
                  },
                  required: ["personId"],
                },
              },
            ],
          },
        ],
      },
      "candidate location search",
      { limit: 1 }
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.ref).toBe("contacts.search_contacts");
    expect(matches[0]?.inspect).toBe("mcp list contacts.search_contacts --schema");
    expect(matches[0]?.call).toBe('mcp call contacts.search_contacts q="example query"');
  });

  it("supports regex search over names, descriptions, and argument metadata", () => {
    const matches = searchMcpTools(
      {
        servers: [
          {
            id: "linear",
            base_url: "http://example.test/mcp",
            tools: [
              {
                name: "create_comment",
                description: "Create an issue comment.",
                input_schema: {
                  type: "object",
                  properties: {
                    issueId: { type: "string", description: "Linear issue identifier" },
                    body: { type: "string", description: "Comment markdown" },
                  },
                  required: ["issueId", "body"],
                },
              },
            ],
          },
        ],
      },
      "markdown",
      { regex: true }
    );

    expect(matches.map((match) => match.ref)).toEqual(["linear.create_comment"]);
  });

  it("truncates unusually large search descriptions", () => {
    const [match] = searchMcpTools(
      {
        servers: [
          {
            id: "large",
            base_url: "http://example.test/mcp",
            tools: [
              {
                name: "search_everything",
                description: `Search contacts. ${"detail ".repeat(2_000)}`,
              },
            ],
          },
        ],
      },
      "contacts"
    );
    expect(match?.description.length).toBeLessThanOrEqual(600);
    expect(match?.description).toContain("[truncated]");
  });

  it("keeps useful delegated errors while removing implementation stacks", () => {
    const output: string[] = [];
    const filter = createDelegatedErrorFilter((text) => output.push(text));
    filter.push(
      "[mcporter] Tool 'delete_all' is not accessible on server 'nextplay' (blocked by configuration).\n"
    );
    filter.push("    at McpRuntime.callTool (file:///tmp/mcporter/runtime.js:174:19)\n");
    filter.flush();
    expect(output.join("")).toContain(
      "Tool 'delete_all' is not enabled on server 'nextplay' in this recipe session"
    );
    expect(output.join("")).not.toContain("McpRuntime.callTool");
  });

  it("keeps missing credentials deployment-neutral", () => {
    const output: string[] = [];
    const filter = createDelegatedErrorFilter((text) => output.push(text));
    filter.push(
      "Failed to resolve header 'Authorization' for server 'linear': Environment variable(s) LINEAR_TOKEN must be set for MCP header substitution.\n"
    );
    filter.flush();
    expect(output.join("")).toBe(
      "Authentication is required for MCP server 'linear'. Ask the user to authenticate this MCP connection outside the agent session, then retry.\n"
    );
    expect(output.join("")).not.toContain("LINEAR_TOKEN");
  });

  it("parses and enforces compact list timeouts", async () => {
    expect(parseListTimeoutMs(["list", "nextplay", "--timeout", "25"])).toBe(25);
    expect(parseListTimeoutMs(["list", "nextplay", "--timeout=40"])).toBe(40);
    expect(parseListTimeoutMs(["list", "nextplay", "--timeout", "0"])).toContain(
      "positive integer"
    );
    await expect(
      withListTimeout(new Promise(() => undefined), 5)
    ).rejects.toThrow("timed out after 5ms");
  });

  it("adds recovery context when bearer auth falls through to OAuth discovery", () => {
    const output: string[] = [];
    const filter = createDelegatedErrorFilter((text) => output.push(text));
    filter.push(
      "[mcporter] HTTP 502 trying to load OAuth metadata from http://localhost/.well-known/oauth-authorization-server\n"
    );
    filter.flush();
    expect(output.join("")).toContain("the token may be invalid or expired");
  });

  it("describes unknown run servers with suggestions and the available list", () => {
    expect(describeUnknownRunServer("nextplai", ["nextplay", "linear"])).toBe(
      "Unknown MCP server 'nextplai'. Did you mean 'tools.nextplay'? Available servers: nextplay, linear."
    );
    expect(describeUnknownRunServer("gmail", ["nextplay", "linear"])).toBe(
      "Unknown MCP server 'gmail'. Available servers: nextplay, linear."
    );
    expect(describeUnknownRunServer("gmail", [])).toBe(
      "Unknown MCP server 'gmail'. No MCP servers are configured."
    );
  });

  it("describes unavailable run tools with near-match suggestions", () => {
    expect(
      describeUnavailableRunTool("nextplay", "search_profils", [
        "search_profiles",
        "get_company",
      ])
    ).toBe(
      "Tool 'search_profils' is not available on server 'nextplay'. Did you mean 'search_profiles'? Run `mcp list nextplay` to see available tools."
    );
    expect(describeUnavailableRunTool("nextplay", "send_email", ["search_profiles"])).toBe(
      "Tool 'send_email' is not available on server 'nextplay'. Run `mcp list nextplay` to see available tools."
    );
  });

});

describe("mcporter CLI end-to-end", () => {
  it("explains missing structured call arguments before delegating", () => {
    expect(callJsonArgumentError(["nextplay.search_profiles", "limit:=15", "--json"])).toContain(
      "--json expects a JSON object or - for stdin"
    );
    expect(
      callJsonArgumentError([
        "nextplay.search_profiles",
        "--json",
        '{"limit":15}',
      ])
    ).toBeNull();
  });

  function startStubMcpServer(expectedAuth: string): Promise<{
    server: Server;
    url: string;
    stats: {
      activeCalls: number;
      maxActiveCalls: number;
      startedKeys: string[];
      abortedCalls: number;
    };
  }> {
    const sessions = new Set<string>();
    const stats = {
      activeCalls: 0,
      maxActiveCalls: 0,
      startedKeys: [] as string[],
      abortedCalls: 0,
    };
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
      req.on("end", async () => {
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
                    outputSchema: {
                      type: "object",
                      properties: { value: { type: "string" } },
                      required: ["value"],
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
          const args = msg.params?.arguments as { key?: string } | undefined;
          const key = args?.key ?? "";
          stats.activeCalls += 1;
          stats.maxActiveCalls = Math.max(stats.maxActiveCalls, stats.activeCalls);
          stats.startedKeys.push(key);
          let finished = false;
          res.on("close", () => {
            if (!finished) stats.abortedCalls += 1;
          });
          const delay = /^delay-(\d+)/.exec(key);
          if (delay) await new Promise((resolve) => setTimeout(resolve, Number(delay[1])));
          const result =
            key === "explode"
              ? {
                  isError: true,
                  content: [{ type: "text", text: "stub failure: explode" }],
                }
              : key === "typed-error"
                ? {
                    isError: true,
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          error: {
                            code: "rate_limited",
                            message: "Slow down and retry.",
                            retryable: true,
                            action: "retry",
                            retry_after_ms: 250,
                            request_id: "req-stub-1",
                            outcome: "not_started",
                          },
                        }),
                      },
                    ],
                  }
                : key === "typed-error-direct"
                  ? {
                      isError: true,
                      structuredContent: {
                        code: "permission_denied",
                        message: "Permission required.",
                        retryable: false,
                        action: "request_permission",
                      },
                      content: [
                        {
                          type: "text",
                          text: "Permission required.",
                        },
                      ],
                    }
                  : key === "text-only"
                    ? {
                        content: [{ type: "text", text: "plain response" }],
                      }
                    : key === "multimodal"
                    ? {
                        structuredContent: { summary: "ready", count: 1 },
                        content: [
                          { type: "text", text: "human-readable summary" },
                          {
                            type: "image",
                            data: "aGVsbG8=",
                            mimeType: "image/png",
                          },
                        ],
                      }
              : {
                  structuredContent: {
                    value: `called ${msg.params?.name} with ${JSON.stringify(msg.params?.arguments)}`,
                  },
                  content: [
                    {
                      type: "text",
                      text: `called ${msg.params?.name} with ${JSON.stringify(msg.params?.arguments)}`,
                    },
                  ],
                };
          stats.activeCalls -= 1;
          if (!res.destroyed) {
            finished = true;
            res.writeHead(200, headers).end(
              JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })
            );
          }
          return;
        }
        res.writeHead(200, headers).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result: {} }));
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve({ server, url: `http://127.0.0.1:${port}/mcp`, stats });
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

  function runMcpCli(
    args: string[],
    env: Record<string, string>,
    input: string
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [join(process.cwd(), "dist", "mcp-cli.js"), ...args],
        {
          env: { ...process.env, ...env },
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
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
        agentMcp: [{ serverId: "stub", tools: { include: ["get_value"] } }],
        manifest: recipeManifest(recipeDir, [{ id: "stub", include: ["get_value"] }]),
      });
      expect(manifest.servers).toHaveLength(1);
      const configEnv = {
        MCPORTER_CONFIG: env.MCPORTER_CONFIG!,
        PI_RECIPES_MCP_MANIFEST: env.PI_RECIPES_MCP_MANIFEST!,
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

      const wrappedList = await runMcpCli(["list", "stub"], configEnv, "");
      expect(wrappedList.code).toBe(0);
      expect(wrappedList.stderr).toBe("");
      expect(wrappedList.stdout).toContain("stub.get_value(key: string)");

      const serverList = await runMcpCli(["list"], configEnv, "");
      expect(serverList).toEqual({ code: 0, stdout: "stub — 1 tool\n", stderr: "" });

      const metadataJson = await runMcpCli(["list", "stub", "--json"], configEnv, "");
      expect(metadataJson.code).toBe(2);
      expect(metadataJson.stdout).toBe("");
      expect(metadataJson.stderr).toContain("JSON is reserved for tool results");

      const withoutCredential: Record<string, string> = { ...configEnv };
      delete withoutCredential.STUB_MCP_TOKEN;
      const missingCredential = await runMcpCli(
        ["list", "stub"],
        withoutCredential,
        ""
      );
      expect(missingCredential.code).toBe(1);
      expect(missingCredential.stderr).toContain("Authentication is required");
      expect(missingCredential.stderr).not.toContain("STUB_MCP_TOKEN");

      const wrappedTextSchema = await runMcpCli(
        ["list", "stub.get_value", "--schema"],
        configEnv,
        ""
      );
      expect(wrappedTextSchema.code).toBe(0);
      expect(wrappedTextSchema.stdout).toBe(
        [
          "stub.get_value",
          "Get a value",
          "",
          "input",
          "  key: string",
          "",
          "output",
          "  value: string",
          "",
          "call",
          "  mcp call stub.get_value key='<key>'",
          "",
        ].join("\n")
      );

      const call = await runMcporter(
        ["call", "stub.get_value", "key=mcporter", "--no-oauth"],
        configEnv
      );
      expect(call.code).toBe(0);
      expect(JSON.parse(call.stdout)).toEqual({
        value: 'called get_value with {"key":"mcporter"}',
      });
      const wrappedCall = await runMcpCli(
        ["call", "stub.get_value", "key=mcporter"],
        configEnv,
        ""
      );
      expect(wrappedCall).toEqual(call);

      const directJsonCall = await runMcporter(
        ["call", "stub.get_value", "key=mcporter", "--output", "json", "--no-oauth"],
        configEnv
      );
      const wrappedJsonCall = await runMcpCli(
        ["call", "stub.get_value", "key=mcporter", "--output", "json"],
        configEnv,
        ""
      );
      expect(wrappedJsonCall).toEqual(directJsonCall);

      // allowedTools gates calls, not just listings.
      const blocked = await runMcporter(["call", "stub.hidden_tool"], configEnv);
      expect(blocked.code).toBe(1);
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("runs JavaScript with recipe MCP tools injected", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-run-"));
    const { server, url, stats } = await startStubMcpServer("Bearer stub-token");
    const previousConfig = process.env.MCPORTER_CONFIG;
    const previousToken = process.env.STUB_MCP_TOKEN;
    const previousManifest = process.env.PI_RECIPES_MCP_MANIFEST;
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
      await materializeRecipeMcpManifest({
        cwd,
        recipeDir,
        env,
        fetch: globalThis.fetch,
        agentMcp: [{ serverId: "stub", tools: { include: ["get_value"] } }],
        manifest: recipeManifest(recipeDir, [{ id: "stub", include: ["get_value"] }]),
      });
      process.env.MCPORTER_CONFIG = env.MCPORTER_CONFIG;
      process.env.STUB_MCP_TOKEN = "stub-token";
      process.env.PI_RECIPES_MCP_MANIFEST = env.PI_RECIPES_MCP_MANIFEST;
      // A transport config entry is not a capability grant. Even if that file
      // is changed independently, mcp run exposes only the filtered manifest.
      const projectedConfig = readMcporterConfig(cwd);
      projectedConfig.mcpServers.rogue = {
        ...projectedConfig.mcpServers.stub,
      };
      writeFileSync(
        defaultMcporterConfigPath(cwd),
        JSON.stringify(projectedConfig)
      );
      (globalThis as typeof globalThis & { __mcpRunSmoke?: unknown }).__mcpRunSmoke = undefined;

      await runMcpJavaScript(
        `
        const result = await tools.stub.get_value({ key: vars.KEY });
        let errorMessage = null;
        try {
          await tools.stub.get_value({ key: "explode" });
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error);
        }
        let typedError = null;
        try {
          await tools.stub.get_value({ key: "typed-error" });
        } catch (error) {
          typedError = {
            name: error.name,
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            action: error.action,
            outcome: error.outcome,
            details: error.details,
          };
        }
        let directTypedError = null;
        try {
          await tools.stub.get_value({ key: "typed-error-direct" });
        } catch (error) {
          directTypedError = error.details;
        }
        const multimodal = {
          json: await tools.stub.get_value({ key: "multimodal" }),
          text: await tools.stub.get_value.text({ key: "multimodal" }),
          markdown: await tools.stub.get_value.markdown({ key: "multimodal" }),
          images: await tools.stub.get_value.images({ key: "multimodal" }),
          content: await tools.stub.get_value.content({ key: "multimodal" }),
          structured: await tools.stub.get_value.structuredContent({ key: "multimodal" }),
          rawStructured: (await tools.stub.get_value.raw({ key: "multimodal" })).structuredContent,
        };
        let unknownServerMessage = null;
        try {
          tools.stubb;
        } catch (error) {
          unknownServerMessage = error instanceof Error ? error.message : String(error);
        }
        let configOnlyServerMessage = null;
        try {
          tools.rogue;
        } catch (error) {
          configOnlyServerMessage = error instanceof Error ? error.message : String(error);
        }
        let unknownToolMessage = null;
        try {
          await tools.stub.get_valu({});
        } catch (error) {
          unknownToolMessage = error instanceof Error ? error.message : String(error);
        }
        const pending = tools.stub.get_value({ key: "color" });
        const pendingSnapshot = JSON.stringify(pending);
        await pending;
        let missingVarMessage = null;
        try {
          vars.MISSING;
        } catch (error) {
          missingVarMessage = error instanceof Error ? error.message : String(error);
        }
        globalThis.__mcpRunSmoke = {
          result: result.value,
          errorMessage,
          typedError,
          directTypedError,
          multimodal,
          unknownServerMessage,
          configOnlyServerMessage,
          unknownToolMessage,
          pendingSnapshot,
          missingVarMessage,
        };
        `,
        { timeoutMs: 10_000, vars: { KEY: "color" } }
      );

      expect((globalThis as typeof globalThis & { __mcpRunSmoke?: unknown }).__mcpRunSmoke).toEqual({
        result: 'called get_value with {"key":"color"}',
        errorMessage: "stub failure: explode",
        typedError: {
          name: "McpRunToolError",
          code: "rate_limited",
          message: "Slow down and retry.",
          retryable: true,
          action: "retry",
          outcome: "not_started",
          details: {
            code: "rate_limited",
            message: "Slow down and retry.",
            retryable: true,
            action: "retry",
            retry_after_ms: 250,
            request_id: "req-stub-1",
            outcome: "not_started",
          },
        },
        directTypedError: {
          code: "permission_denied",
          message: "Permission required.",
          retryable: false,
          action: "request_permission",
        },
        multimodal: {
          json: { summary: "ready", count: 1 },
          text: "human-readable summary",
          markdown: null,
          images: [
            {
              data: "aGVsbG8=",
              mimeType: "image/png",
            },
          ],
          content: [
            { type: "text", text: "human-readable summary" },
            {
              type: "image",
              data: "aGVsbG8=",
              mimeType: "image/png",
            },
          ],
          structured: { summary: "ready", count: 1 },
          rawStructured: { summary: "ready", count: 1 },
        },
        unknownServerMessage:
          "Unknown MCP server 'stubb'. Did you mean 'tools.stub'? Available servers: stub.",
        configOnlyServerMessage:
          "Unknown MCP server 'rogue'. Available servers: stub.",
        unknownToolMessage:
          "Tool 'get_valu' is not available on server 'stub'. Did you mean 'get_value'? Run `mcp list stub` to see available tools.",
        pendingSnapshot:
          '"[pending tool call stub.get_value — did you forget await?]"',
        missingVarMessage:
          "vars.MISSING is not defined. Pass it with --var MISSING=value (defined vars: KEY). " +
          'Use `"MISSING" in vars` to test for optional vars.',
      });

      await expect(
        runMcpJavaScript('tools.stub.get_value({ key: "explode" });', {
          timeoutMs: 10_000,
        })
      ).rejects.toThrow(
        /tool call\(s\) were not awaited: stub\.get_value=failed \(stub failure: explode\)/
      );

      await expect(
        runMcpJavaScript('tools.stub.get_value({ key: "color" });', {
          timeoutMs: 10_000,
        })
      ).rejects.toThrow(/stub\.get_value=succeeded/);

      await expect(
        runMcpJavaScript(
          'tools.stub.get_value({ key: "color" }); throw new Error("later failure")',
          { timeoutMs: 10_000 }
        )
      ).rejects.toThrow(/stub\.get_value=succeeded[\s\S]*script also failed: later failure/);

      await expect(
        runMcpJavaScript(
          'tools.stub.get_value({ key: "delay-75" }).then(() => {});',
          { timeoutMs: 10_000 }
        )
      ).rejects.toThrow(
        /tool call\(s\) were not awaited: stub\.get_value=succeeded[\s\S]*attaching \.then\/\.catch without awaiting/
      );

      stats.maxActiveCalls = 0;
      stats.startedKeys.length = 0;
      await runMcpJavaScript(
        `
        const keys = ["delay-80-a", "delay-80-b", "delay-80-c", "delay-80-d", "delay-80-e"];
        await Promise.all(keys.map((key) => tools.stub.get_value({ key })));
        `,
        { timeoutMs: 10_000, maxConcurrentCalls: 2 }
      );
      expect(stats.maxActiveCalls).toBe(2);
      expect(new Set(stats.startedKeys)).toEqual(
        new Set([
          "delay-80-a",
          "delay-80-b",
          "delay-80-c",
          "delay-80-d",
          "delay-80-e",
        ])
      );

      let aggregateError: unknown;
      try {
        await runMcpJavaScript(
          `
          await Promise.all([
            tools.stub.get_value({ key: "explode" }),
            tools.stub.get_value({ key: "delay-80-a" }),
            tools.stub.get_value({ key: "delay-80-b" }),
          ]);
          `,
          { timeoutMs: 10_000, maxConcurrentCalls: 3 }
        );
      } catch (error) {
        aggregateError = error;
      }
      expect(aggregateError).toBeInstanceOf(Error);
      expect((aggregateError as Error).message).toContain("stub failure: explode");
      expect((aggregateError as Error).message).toContain("Workflow call outcomes:");
      expect((aggregateError as Error).message).toContain("stub.get_value=failed");
      expect((aggregateError as Error).message).toContain("stub.get_value=succeeded");
      expect((aggregateError as McpRunToolError).details?.calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outcome: "failed" }),
          expect.objectContaining({ outcome: "succeeded" }),
        ])
      );
      expect((aggregateError as Error).message).not.toContain("not awaited");

      await expect(
        runMcpJavaScript(
          `
          const result = await tools.stub.get_value({ key: "color" });
          if (result.value !== 'called get_value with {"key":"color"}') {
            throw new Error("default JSON decoding failed");
          }
          `,
          { timeoutMs: 10_000 }
        )
      ).resolves.toBeUndefined();

      await expect(
        runMcpJavaScript(
          `await tools.stub.get_value({ key: "text-only" });`,
          { timeoutMs: 10_000 }
        )
      ).rejects.toThrow(/did not return JSON.*\.text\(args\)/);

      await runMcpJavaScript(
        `
        const text = await tools.stub.get_value.text({ key: "text-only" });
        if (text !== "plain response") throw new Error("text decoding failed");
        `,
        { timeoutMs: 10_000 }
      );

      await expect(
        runMcpJavaScript('tools.stub.get_value.text({ key: "color" });', {
          timeoutMs: 10_000,
        })
      ).rejects.toThrow(/tool call\(s\) were not awaited: stub\.get_value=succeeded/);

      await expect(
        runMcpJavaScript(
          `await tools.stub.get_value({ "filterBy:=person_name='Ada'": "" });`,
          { timeoutMs: 10_000 }
        )
      ).rejects.toThrow(/mcp run uses normal JavaScript objects/);

      await expect(
        runMcpJavaScript(`console.log(process.argv[2]);`, { timeoutMs: 10_000 })
      ).rejects.toThrow(/process\.argv is unavailable in mcp run.*--var KEY=value/);

      await expect(
        runMcpJavaScript(
          `
          await tools.stub.get_value({ key: "first" });
          await tools.stub.get_value({ key: "second" });
          await tools.stub.get_value({ key: "third" });
          `,
          { timeoutMs: 10_000, maxCalls: 2 }
        )
      ).rejects.toThrow(/mcp run tool-call limit exceeded \(2\)/);

      await runMcpJavaScript(
        `
        try {
          await tools.stub.get_value({ key: "delay-300" });
        } catch (error) {
          globalThis.__mcpRunSmoke = {
            name: error.name,
            code: error.code,
            retryable: error.retryable,
            action: error.action,
            outcome: error.outcome,
          };
        }
        `,
        { timeoutMs: 5_000, callTimeoutMs: 40 }
      );
      expect((globalThis as typeof globalThis & { __mcpRunSmoke?: unknown }).__mcpRunSmoke).toEqual(
        {
          name: "McpRunToolError",
          code: "timeout",
          retryable: true,
          action: "inspect_state",
          outcome: "unknown",
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(stats.abortedCalls).toBeGreaterThan(0);

      const detachedStartedAt = Date.now();
      const detached = await runMcpCli(
        ["run"],
        {
          MCPORTER_CONFIG: process.env.MCPORTER_CONFIG!,
          PI_RECIPES_MCP_MANIFEST: process.env.PI_RECIPES_MCP_MANIFEST!,
          STUB_MCP_TOKEN: "stub-token",
        },
        'tools.stub.get_value({ key: "delay-75" }).then(() => {});'
      );
      expect(detached.code).toBe(2);
      expect(detached.stderr).toContain("tool call(s) were not awaited");
      expect(Date.now() - detachedStartedAt).toBeLessThan(2_000);

      const jsonError = await runMcpCli(
        ["run", "--json-errors"],
        {
          MCPORTER_CONFIG: process.env.MCPORTER_CONFIG!,
          PI_RECIPES_MCP_MANIFEST: process.env.PI_RECIPES_MCP_MANIFEST!,
          STUB_MCP_TOKEN: "stub-token",
        },
        'await tools.stub.get_value({ key: "typed-error" });'
      );
      expect(jsonError.code).toBe(1);
      expect(jsonError.stdout).toBe("");
      const jsonErrorLine = jsonError.stderr
        .trim()
        .split("\n")
        .find((line) => line.startsWith('{"error":'));
      expect(jsonErrorLine, jsonError.stderr).toBeDefined();
      expect(JSON.parse(jsonErrorLine!)).toEqual({
        error: {
          code: "rate_limited",
          message: "Slow down and retry.",
          retryable: true,
          action: "retry",
          retry_after_ms: 250,
          request_id: "req-stub-1",
          outcome: "not_started",
          server: "stub",
          tool: "get_value",
        },
      });

      stats.startedKeys.length = 0;
      const startedAt = Date.now();
      await expect(
        runMcpJavaScript(
          `
          await Promise.all([
            tools.stub.get_value({ key: "delay-1000" }),
            tools.stub.get_value({ key: "delay-1000" }),
          ]);
          `,
          { timeoutMs: 150, callTimeoutMs: 5_000, maxConcurrentCalls: 1 }
        )
      ).rejects.toThrow(/mcp run timed out after 150ms/);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(stats.startedKeys).toEqual(["delay-1000"]);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(stats.abortedCalls).toBeGreaterThan(1);
    } finally {
      if (previousConfig === undefined) delete process.env.MCPORTER_CONFIG;
      else process.env.MCPORTER_CONFIG = previousConfig;
      if (previousToken === undefined) delete process.env.STUB_MCP_TOKEN;
      else process.env.STUB_MCP_TOKEN = previousToken;
      if (previousManifest === undefined) delete process.env.PI_RECIPES_MCP_MANIFEST;
      else process.env.PI_RECIPES_MCP_MANIFEST = previousManifest;
      delete (globalThis as typeof globalThis & { __mcpRunSmoke?: unknown }).__mcpRunSmoke;
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
