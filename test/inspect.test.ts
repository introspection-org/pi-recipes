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

    expect(inspectRecipe(fixture.recipeDir).credential_env).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_OAUTH_TOKEN",
    ]);
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
