import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureMcpLocalConfigPath,
  localMcpHeadersForServer,
  main,
  materializeRecipeMcpManifest,
} from "../src/mcp.js";

const originalFetch = globalThis.fetch;

function testIo(env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (chunk: string) => void (stdout += chunk) },
      stderr: { write: (chunk: string) => void (stderr += chunk) },
      env,
      cwd: process.cwd(),
      fetch: globalThis.fetch,
    },
    output: () => ({ stdout, stderr }),
  };
}

function writeManifest() {
  const dir = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-"));
  const path = join(dir, "mcp.json");
  writeFileSync(
    path,
    JSON.stringify({
      servers: [
        {
          id: "partner-mcp",
          name: "Partner MCP",
          host: "host.docker.internal",
          base_url: "http://host.docker.internal:3200/api/mcp",
          transport: "streamable_http",
          tools: [
            {
              name: "get_value",
              description: "Read a value.",
              input_schema: {
                type: "object",
                properties: { key: { type: "string" } },
              },
            },
          ],
        },
      ],
    })
  );
  return { dir, path };
}

function writeLocalConfig() {
  const dir = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-local-"));
  const path = join(dir, "mcp.local.json");
  writeFileSync(
    path,
    JSON.stringify({
      servers: [
        {
          id: "partner-mcp",
          transport: "streamable_http",
          url: "http://127.0.0.1:3200/mcp",
          headers: { Authorization: "Bearer ${PARTNER_TOKEN}" },
        },
      ],
    })
  );
  return { dir, path };
}

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("mcp CLI", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("lists and describes tools from the configured manifest", async () => {
    const { dir, path } = writeManifest();
    try {
      const sources = testIo({ PI_RECIPES_MCP_MANIFEST: path });
      expect(await main(["tools", "sources"], sources.io)).toBe(0);
      expect(sources.output().stdout).toContain("partner-mcp");
      expect(sources.output().stdout).toContain("1 tools");

      const describe = testIo({ PI_RECIPES_MCP_MANIFEST: path });
      expect(
        await main(["tools", "describe", "partner-mcp.get_value"], describe.io)
      ).toBe(0);
      expect(describe.output().stdout).toContain('"name": "get_value"');
      expect(describe.output().stdout).toContain('"input_schema"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts the legacy manifest env var as an alias", async () => {
    const { dir, path } = writeManifest();
    try {
      const sources = testIo({ INTROSPECTION_MCP_MANIFEST: path });
      expect(await main(["tools", "sources"], sources.io)).toBe(0);
      expect(sources.output().stdout).toContain("partner-mcp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads local MCP bindings from the pi-recipes config env var", () => {
    const { dir, path } = writeLocalConfig();
    try {
      expect(
        localMcpHeadersForServer("partner-mcp", {
          cwd: dir,
          env: {
            PI_RECIPES_MCP_LOCAL_CONFIG: path,
            PARTNER_TOKEN: "secret",
          },
        })
      ).toEqual({ Authorization: "Bearer secret" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    const { dir, path } = writeLocalConfig();
    try {
      expect(
        localMcpHeadersForServer("partner-mcp", {
          cwd: dir,
          env: {
            INTROSPECTION_MCP_LOCAL_CONFIG: path,
            PARTNER_TOKEN: "secret",
          },
        })
      ).toEqual({ Authorization: "Bearer secret" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
      const localConfig = join(cwd, ".pi", "mcp.local.json");
      writeFileSync(
        localConfig,
        JSON.stringify({
          servers: [
            {
              id: "slack",
              transport: "streamable_http",
              url: "${SLACK_MCP_URL}",
              headers: { Authorization: "Bearer ${SLACK_MCP_TOKEN}" },
            },
          ],
        })
      );

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
        manifest: {
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
            servers: [
              {
                id: "slack",
                required: false,
                tools: { allow: ["slack_list_threads"] },
              },
            ],
          },
          evals: { suites: [] },
        },
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports discovered MCP tools that do not match recipe policy refs", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-filter-"));
    try {
      const cwd = join(root, "workspace");
      const recipeDir = join(root, "recipe");
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      mkdirSync(recipeDir, { recursive: true });
      const localConfig = join(cwd, ".pi", "mcp.local.json");
      writeFileSync(
        localConfig,
        JSON.stringify({
          servers: [
            {
              id: "slack",
              transport: "streamable_http",
              url: "http://127.0.0.1:3201/mcp",
              headers: { Authorization: "Bearer ${SLACK_MCP_TOKEN}" },
            },
          ],
        })
      );

      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
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
        manifest: {
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
            servers: [
              {
                id: "slack",
                required: false,
                tools: { allow: ["slack_list_threads"] },
              },
            ],
          },
          evals: { suites: [] },
        },
      });

      expect(manifest.servers).toEqual([]);
      expect(manifest.diagnostics?.[0]).toMatchObject({
        serverId: "slack",
        stage: "filter",
      });
      expect(manifest.diagnostics?.[0]?.message).toContain("slack_fetch");
      expect(manifest.diagnostics?.[0]?.message).toContain("slack_list_threads");
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
        manifest: {
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
            servers: [
              {
                id: "slack",
                required: false,
                tools: { allow: ["slack_read_channel"] },
              },
            ],
          },
          evals: { suites: [] },
        },
      });

      const description = manifest.servers?.[0]?.tools?.[0]?.description ?? "";
      expect(manifest.servers?.[0]?.tools?.map((tool) => tool.name)).toEqual([
        "slack_read_channel",
      ]);
      expect(description).not.toContain("slack_search_channels");
      expect(description).not.toContain("slack_read_thread");
      expect(description).toContain("[unavailable MCP tool]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("calls MCP tools with the session token", async () => {
    const { dir, path } = writeManifest();
    const calls: Array<{ method?: string; auth?: string; protocol?: string; session?: string }> = [];
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        const headers = init?.headers as Record<string, string>;
        calls.push({
          method: body.method,
          auth: headers.Authorization,
          protocol: headers["MCP-Protocol-Version"],
          session: headers["Mcp-Session-Id"],
        });
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
          result: { content: [{ type: "text", text: "teal" }] },
        });
      }
    ) as unknown as typeof fetch;

    try {
      const cli = testIo({
        PI_RECIPES_MCP_MANIFEST: path,
        INTROSPECTION_TOKEN: "session-token",
      });
      cli.io.fetch = globalThis.fetch;
      expect(
        await main(["call", "partner-mcp", "get_value", '{"key":"color"}'], cli.io)
      ).toBe(0);
      expect(cli.output().stdout).toContain("teal");
      expect(calls).toEqual([
        {
          method: "initialize",
          auth: "Bearer session-token",
          protocol: "2025-03-26",
          session: undefined,
        },
        {
          method: "notifications/initialized",
          auth: "Bearer session-token",
          protocol: "2025-03-26",
          session: "mcp-session-1",
        },
        {
          method: "tools/call",
          auth: "Bearer session-token",
          protocol: "2025-03-26",
          session: "mcp-session-1",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints HTTP MCP error details from failed tool calls", async () => {
    const { dir, path } = writeManifest();
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        if (body.method === "initialize") {
          return jsonResponse(
            { jsonrpc: "2.0", id: 1, result: {} },
            { "mcp-session-id": "mcp-session-1" }
          );
        }
        if (body.method === "notifications/initialized") {
          return jsonResponse({ jsonrpc: "2.0", result: {} });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            error: { code: -32602, message: "channel_name is required" },
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
    ) as unknown as typeof fetch;

    try {
      const cli = testIo({
        PI_RECIPES_MCP_MANIFEST: path,
        INTROSPECTION_TOKEN: "session-token",
      });
      cli.io.fetch = globalThis.fetch;

      expect(
        await main(["call", "partner-mcp", "get_value", '{"channel":"support"}'], cli.io)
      ).toBe(1);
      expect(cli.output().stderr).toContain("MCP call failed: HTTP 400");
      expect(cli.output().stderr).toContain("channel_name is required");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
