import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectRecipe } from "../src/inspect.js";
import { writeFixtureRecipe } from "../src/test-utils.js";

describe("inspectRecipe", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("reports every accepted provider credential variable", () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);

    const inspection = inspectRecipe(fixture.recipeDir);
    expect(inspection.credential_env).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_OAUTH_TOKEN",
    ]);
    expect(inspection.resolved_agents[0]).toMatchObject({
      name: "agent",
      prompt: { base: "SYSTEM.md" },
      tools: {
        authored: ["read"],
        root: ["read"],
        subagent: ["read"],
      },
    });
    expect(inspection.host_boundary).toEqual({
      interactive_pi_may_add_ambient_resources: true,
      embedded_host_overrides_are_not_recipe_source: true,
    });
  });

  it("reports OAuth client-secret variables from local MCP bindings", () => {
    const fixture = writeFixtureRecipe({
      manifestPi: {
        mcp: {
          servers: [
            { id: "crm", required: false, tools: { include: ["*"] } },
          ],
        },
      },
      agentExtras: [
        "mcp:",
        "  mode: cli",
        "  servers:",
        "    crm:",
        '      include: ["*"]',
      ],
    });
    cleanups.push(fixture.cleanup);
    const configDir = join(fixture.recipeDir, ".pi");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "mcp.local.json"),
      JSON.stringify({
        servers: [
          {
            id: "crm",
            url: "${CRM_MCP_URL}",
            auth: "oauth",
            oauthClientSecretEnv: "CRM_CLIENT_SECRET",
          },
        ],
      })
    );

    expect(inspectRecipe(fixture.recipeDir).mcp_env).toEqual([
      "CRM_CLIENT_SECRET",
      "CRM_MCP_URL",
    ]);
  });
});
