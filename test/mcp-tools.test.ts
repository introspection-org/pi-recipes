import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callMcpDaemonTool: vi.fn(),
}));

vi.mock("../src/mcp-daemon-client.js", () => ({
  callMcpDaemonTool: mocks.callMcpDaemonTool,
}));

import {
  createMcpToolSet,
  piMcpToolName,
} from "../src/mcp-tools.js";
import type { McpSessionConfig } from "../src/mcp.js";
import type { RecipeAgentMcp } from "../src/recipe-agent.js";

const session: McpSessionConfig = {
  version: 1,
  servers: [
    {
      id: "nextplay",
      name: "NextPlay",
      base_url: "https://example.test/mcp",
      package_tools: { include: ["*"] },
      agent_tools: [{ include: ["*"] }],
    },
  ],
};

const catalogs = [
  {
    id: "nextplay",
    name: "NextPlay",
    tools: [
      {
        name: "search_talent",
        description: "Search candidates by role and experience.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        output_schema: {
          type: "object",
          properties: {
            count: { type: "number" },
          },
          required: ["count"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      {
        name: "get_profiles",
        description: "Read candidate profiles.",
        input_schema: { type: "object" },
      },
    ],
  },
];

function createTools(mcp: RecipeAgentMcp, env: NodeJS.ProcessEnv = {}) {
  let active: string[] = [];
  const materialized = createMcpToolSet({
    session,
    catalogs,
    mcp,
    env,
    activation: {
      getActiveTools: () => active,
      setActiveTools: (names) => {
        active = names;
      },
    },
  });
  return {
    materialized,
    get active() {
      return active;
    },
    setActive(names: string[]) {
      active = names;
    },
  };
}

describe("MCP tools mode", () => {
  beforeEach(() => {
    mocks.callMcpDaemonTool.mockReset();
  });

  it("uses stable provider-safe names no longer than 64 characters", () => {
    const first = piMcpToolName(
      "server with spaces",
      "a very long tool name ".repeat(10)
    );
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(first).toBe(
      piMcpToolName("server with spaces", "a very long tool name ".repeat(10))
    );
  });

  it("registers every authorized tool and defaults all of them active", () => {
    const { materialized } = createTools({
      mode: "tools",
      servers: { nextplay: { include: ["*"] } },
    });
    expect(materialized.toolNames).toHaveLength(2);
    expect(materialized.initialActiveToolNames).toEqual(
      materialized.toolNames
    );
    expect(materialized.searchToolName).toBeUndefined();
  });

  it("reapplies the selected agent policy to a broader host catalog", () => {
    const { materialized } = createTools({
      mode: "tools",
      servers: { nextplay: { include: ["get_profiles"] } },
    });

    expect(materialized.toolNames).toEqual([
      piMcpToolName("nextplay", "get_profiles"),
    ]);
    expect(materialized.canonicalToPiName.has("nextplay.search_talent")).toBe(
      false
    );
  });

  it("keeps tools outside initial_tools deferred and activates search matches additively", async () => {
    const state = createTools({
      mode: "tools",
      servers: { nextplay: { include: ["*"] } },
      initialTools: { nextplay: ["get_profiles"] },
    });
    const { materialized } = state;
    const search = materialized.tools.find(
      (tool) => tool.name === materialized.searchToolName
    );
    expect(search).toBeDefined();
    const initiallyActive = materialized.initialActiveToolNames;
    const searchName = materialized.searchToolName!;
    state.setActive([...initiallyActive, searchName]);
    const result = await (search!.execute as any)(
      "call-1",
      { query: "find candidates", limit: 3 },
      undefined,
      undefined
    );
    expect(result.details.added).toEqual([
      materialized.canonicalToPiName.get("nextplay.search_talent"),
    ]);
    expect(state.active).toEqual(
      expect.arrayContaining([
        ...initiallyActive,
        searchName,
        materialized.canonicalToPiName.get("nextplay.search_talent"),
      ])
    );
  });

  it("validates outputSchema locally and removes duplicate structured JSON text", async () => {
    mocks.callMcpDaemonTool.mockResolvedValue({
      structuredContent: { count: 2 },
      content: [
        { type: "text", text: '{"count":2}' },
        { type: "text", text: "Found two profiles." },
      ],
    });
    const { materialized } = createTools({
      mode: "tools",
      servers: { nextplay: { include: ["*"] } },
    });
    const tool = materialized.tools.find(
      (entry) =>
        entry.name ===
        materialized.canonicalToPiName.get("nextplay.search_talent")
    )!;
    const result = await (tool.execute as any)(
      "call-2",
      { query: "engineer" },
      undefined,
      undefined
    );
    expect(result.content).toEqual([
      { type: "text", text: '{"count":2}' },
      { type: "text", text: "Found two profiles." },
    ]);

    mocks.callMcpDaemonTool.mockResolvedValueOnce({
      structuredContent: { count: "two" },
      content: [],
    });
    await expect(
      (tool.execute as any)(
        "call-3",
        { query: "engineer" },
        undefined,
        undefined
      )
    ).rejects.toThrow("does not match outputSchema");

    mocks.callMcpDaemonTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "missing structured result" }],
    });
    await expect(
      (tool.execute as any)(
        "call-3b",
        { query: "engineer" },
        undefined,
        undefined
      )
    ).rejects.toThrow("returned no structuredContent");
  });

  it("dereferences local input schemas and rejects unusable initial wildcards", async () => {
    const referencedCatalogs = [
      {
        id: "nextplay",
        name: "NextPlay",
        tools: [
          {
            name: "search_talent",
            input_schema: {
              type: "object",
              properties: {
                filter: { $ref: "#/$defs/filter" },
              },
              $defs: {
                filter: {
                  type: "object",
                  properties: { role: { type: "string" } },
                  required: ["role"],
                },
              },
            },
          },
          {
            name: "broken",
            input_schema: { type: "string" },
          },
        ],
      },
    ];
    expect(() =>
      createMcpToolSet({
        session,
        catalogs: referencedCatalogs,
        mcp: {
          mode: "tools",
          servers: { nextplay: { include: ["*"] } },
          initialTools: { nextplay: ["*"] },
        },
        env: {},
        activation: {
          getActiveTools: () => [],
          setActiveTools: () => {},
        },
      })
    ).toThrow("includes unusable tool 'nextplay.broken'");

    const materialized = createMcpToolSet({
      session,
      catalogs: referencedCatalogs,
      mcp: {
        mode: "tools",
        servers: { nextplay: { include: ["search_talent"] } },
        initialTools: { nextplay: ["search_talent"] },
      },
      env: {},
      activation: {
        getActiveTools: () => [],
        setActiveTools: () => {},
      },
    });
    const schema = materialized.tools[0]?.parameters as any;
    expect(schema.$defs).toBeUndefined();
    expect(schema.properties.filter.type).toBe("object");
    expect(schema.properties.filter.properties.role.type).toBe("string");
  });

  it("turns MCP errors into thrown tool errors and guards large output", async () => {
    const { materialized } = createTools(
      {
        mode: "tools",
        servers: { nextplay: { include: ["*"] } },
      },
      {
        PI_RECIPES_MCP_MAX_OUTPUT_BYTES: "64",
        PI_RECIPES_MCP_MAX_OUTPUT_LINES: "2",
      }
    );
    const tool = materialized.tools.find(
      (entry) =>
        entry.name ===
        materialized.canonicalToPiName.get("nextplay.get_profiles")
    )!;
    mocks.callMcpDaemonTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "upstream denied access" }],
    });
    await expect(
      (tool.execute as any)("call-4", {}, undefined, undefined)
    ).rejects.toThrow("upstream denied access");

    mocks.callMcpDaemonTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "line\n".repeat(100) }],
    });
    const result = await (tool.execute as any)(
      "call-5",
      {},
      undefined,
      undefined
    );
    expect(result.content[0].text).toContain("[Output truncated:");
    expect(result.details.truncated.originalLines).toBeGreaterThan(2);
  });

  it("omits failed optional catalogs but blocks failed required catalogs", () => {
    const mixedSession: McpSessionConfig = {
      version: 1,
      servers: [
        ...session.servers,
        {
          id: "optional",
          name: "Optional",
          base_url: "https://optional.test/mcp",
          package_tools: { include: ["*"] },
          agent_tools: [{ include: ["*"] }],
        },
      ],
    };
    const mixedCatalogs = [
      ...catalogs,
      {
        id: "optional",
        name: "Optional",
        tools: [],
        error: "connection refused",
      },
    ];
    const optional = createMcpToolSet({
      session: mixedSession,
      catalogs: mixedCatalogs,
      mcp: {
        mode: "tools",
        servers: {
          nextplay: { include: ["*"] },
          optional: { include: ["*"] },
        },
      },
      env: {},
      activation: {
        getActiveTools: () => [],
        setActiveTools: () => {},
      },
    });
    expect(optional.toolNames).toHaveLength(2);
    expect(optional.diagnostics).toContain("optional: connection refused");
    expect(() =>
      createMcpToolSet({
        session: mixedSession,
        catalogs: mixedCatalogs,
        mcp: {
          mode: "tools",
          servers: {
            nextplay: { include: ["*"] },
            optional: { include: ["*"] },
          },
          initialTools: { optional: ["*"] },
        },
        env: {},
        activation: {
          getActiveTools: () => [],
          setActiveTools: () => {},
        },
      })
    ).toThrow("requires a healthy catalog");

    expect(() =>
      createMcpToolSet({
        session: {
          ...mixedSession,
          servers: mixedSession.servers.map((server) =>
            server.id === "optional" ? { ...server, required: true } : server
          ),
        },
        catalogs: mixedCatalogs,
        mcp: {
          mode: "tools",
          servers: {
            nextplay: { include: ["*"] },
            optional: { include: ["*"] },
          },
        },
        env: {},
        activation: {
          getActiveTools: () => [],
          setActiveTools: () => {},
        },
      })
    ).toThrow("Required MCP catalog discovery failed");
  });
});
