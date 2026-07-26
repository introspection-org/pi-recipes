import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearMcpCatalogPreload: vi.fn(),
  preloadMcpCatalogs: vi.fn(),
}));

vi.mock("../src/mcp-catalog.js", () => ({
  clearMcpCatalogPreload: mocks.clearMcpCatalogPreload,
  preloadMcpCatalogs: mocks.preloadMcpCatalogs,
}));

import { piMcpToolName } from "../src/mcp-tools.js";
import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type AgentSessionHandle,
} from "../src/session.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";

// These cases were written against one flat bag, which satisfies both
// parameters: the target reads recipeDir/agentName, the options ignore them.
const createSession = (
  options: { recipeDir: string; agentName?: string } & CreateAgentSessionOptions
) => createAgentSession(options, options);


async function credentials(): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: "test-key",
  }));
  return store;
}

describe("canonical Recipe session MCP tools mode", () => {
  const handles: AgentSessionHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      await handle.dispose().catch(() => {});
    }
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.clearAllMocks();
  });

  it("registers deferred MCP tools through createAgentSession", async () => {
    const fixture = writeFixtureRecipe({
      manifestPi: {
        mcp: {
          servers: [
            {
              id: "contacts",
              required: true,
              tools: { include: ["search_contacts", "get_contact"] },
            },
          ],
        },
      },
      agentExtras: [
        "mcp:",
        "  mode: tools",
        "  servers:",
        "    contacts:",
        '      include: ["search_contacts", "get_contact"]',
        "  initial_tools: {}",
      ],
    });
    cleanups.push(fixture.cleanup);
    mocks.preloadMcpCatalogs.mockResolvedValue([
      {
        id: "contacts",
        name: "Contacts",
        tools: [
          {
            name: "search_contacts",
            description: "Search contacts.",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
          {
            name: "get_contact",
            description: "Read one contact.",
            input_schema: { type: "object", properties: {} },
          },
        ],
      },
    ]);

    const env = cleanEnv();
    const handle = await createSession({
      recipeDir: fixture.recipeDir,
      cwd: fixture.workspaceDir,
      env,
      credentials: await credentials(),
      mcpBindings: {
        servers: [
          {
            id: "contacts",
            transport: "streamable_http",
            url: "http://127.0.0.1:9/mcp",
          },
        ],
      },
    });
    handles.push(handle);

    const registered = new Set(
      handle.session.getAllTools().map((tool) => tool.name)
    );
    expect(registered).toContain(
      piMcpToolName("contacts", "search_contacts")
    );
    expect(registered).toContain(piMcpToolName("contacts", "get_contact"));
    expect(registered).toContain("mcp_search");
    expect(handle.session.getActiveToolNames()).toContain("mcp_search");
    expect(handle.session.getActiveToolNames()).not.toContain(
      piMcpToolName("contacts", "search_contacts")
    );

    // Tools mode owns an isolated MCP runtime instead of mutating the host env.
    expect(env.PI_RECIPES_MCP_SESSION).toBeUndefined();
    expect(env.MCPORTER_CONFIG).toBeUndefined();
  });
});
