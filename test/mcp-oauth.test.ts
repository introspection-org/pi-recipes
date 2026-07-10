import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  getInstructions: vi.fn(async () => "Authenticate locally before calling tools."),
  connect: vi.fn(async () => ({
    client: {
      listTools: vi.fn(async () => ({
        tools: [
          {
            name: "get_value",
            description: "Get a value",
            inputSchema: { type: "object", properties: {} },
            outputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
            },
            annotations: { readOnlyHint: true },
          },
        ],
      })),
    },
  })),
}));
const createRuntime = vi.hoisted(() => vi.fn(async () => runtime));

vi.mock("mcporter", () => ({ createRuntime }));

import {
  defaultMcporterConfigPath,
  materializeRecipeMcpManifest,
} from "../src/mcp.js";
import type { RecipePackageManifest } from "../src/recipe-package.js";

describe("local MCP OAuth materialization", () => {
  afterEach(() => {
    createRuntime.mockClear();
    runtime.connect.mockClear();
    runtime.getInstructions.mockClear();
    runtime.close.mockClear();
  });

  it("uses cached-only mcporter OAuth discovery and preserves auth config", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-local-oauth-"));
    try {
      const cwd = join(root, "workspace");
      const recipeDir = join(root, "recipe");
      const localConfig = join(cwd, ".pi", "mcp.local.json");
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      mkdirSync(recipeDir, { recursive: true });
      writeFileSync(
        localConfig,
        JSON.stringify({
          servers: [
            {
              id: "local-oauth",
              transport: "streamable_http",
              url: "https://mcp.example.test/mcp",
              auth: "oauth",
              oauthClientId: "local-client",
              oauthClientSecretEnv: "LOCAL_OAUTH_SECRET",
            },
          ],
        })
      );
      const manifest: RecipePackageManifest = {
        name: "oauth-recipe",
        version: "1.0.0",
        path: recipeDir,
        resources: { agents: [], extensions: [], skills: [], prompts: [] },
        mcp: {
          manifests: [],
          servers: [
            {
              id: "local-oauth",
              required: true,
              tools: { include: ["get_value"] },
            },
          ],
        },
        evals: { suites: [] },
      };
      const result = await materializeRecipeMcpManifest({
        cwd,
        recipeDir,
        manifest,
        agentMcp: [
          {
            serverId: "local-oauth",
            tools: { include: ["get_value"] },
          },
        ],
        env: { PI_RECIPES_MCP_LOCAL_CONFIG: localConfig },
      });

      expect(createRuntime).toHaveBeenCalledWith({
        servers: [
          expect.objectContaining({
            name: "local-oauth",
            auth: "oauth",
            oauthClientId: "local-client",
            oauthClientSecretEnv: "LOCAL_OAUTH_SECRET",
          }),
        ],
      });
      expect(runtime.connect).toHaveBeenCalledWith("local-oauth", {
        disableOAuth: true,
      });
      expect(result.servers?.[0]?.tools?.map((tool) => tool.name)).toEqual([
        "get_value",
      ]);
      expect(result.servers?.[0]?.tools?.[0]?.annotations).toEqual({
        readOnlyHint: true,
      });
      expect(runtime.close).toHaveBeenCalledOnce();

      const config = JSON.parse(
        readFileSync(defaultMcporterConfigPath(cwd), "utf8")
      ) as { mcpServers: Record<string, Record<string, unknown>> };
      expect(config.mcpServers["local-oauth"]).toMatchObject({
        auth: "oauth",
        oauthClientId: "local-client",
        oauthClientSecretEnv: "LOCAL_OAUTH_SECRET",
        allowedTools: ["get_value"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
