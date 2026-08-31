import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import {
  createRecipeToolSearch,
  createRecipeToolSearchTools,
} from "../src/tool-search.js";

function tool(
  name: string,
  label: string,
  description: string,
  parameters = Type.Object({})
): ToolDefinition {
  return {
    name,
    label,
    description,
    parameters,
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };
}

describe("Recipe tool search", () => {
  it("searches deferred tools from different integrations and enables matches additively", async () => {
    const tools = [
      tool(
        "slack_react",
        "React in Slack",
        "Add an emoji reaction to a Slack message."
      ),
      tool(
        "mcp_contacts_search_candidates",
        "Search candidates",
        "Find recruiting candidates by role and experience."
      ),
    ];
    let active = ["read", "tool_search"];
    const search = createRecipeToolSearch({
      tools,
      deferredToolNames: tools.map((entry) => entry.name),
      activation: {
        getActiveTools: () => active,
        setActiveTools: (names) => {
          active = names;
        },
      },
    })!;

    const first = await search.execute(
      "call-1",
      { query: "add a reaction", limit: 1 },
      undefined,
      undefined,
      undefined as never
    );
    expect(first.details).toMatchObject({ added: ["slack_react"] });
    expect(active).toEqual(["read", "tool_search", "slack_react"]);

    const second = await search.execute(
      "call-2",
      { query: "recruiting candidates", limit: 1 },
      undefined,
      undefined,
      undefined as never
    );
    expect(second.details).toMatchObject({
      added: ["mcp_contacts_search_candidates"],
    });
    expect(active).toEqual([
      "read",
      "tool_search",
      "slack_react",
      "mcp_contacts_search_candidates",
    ]);
  });

  it("does not return a deferred tool after it is active", async () => {
    const react = tool(
      "slack_react",
      "React in Slack",
      "Add an emoji reaction to a Slack message."
    );
    const search = createRecipeToolSearch({
      tools: [react],
      deferredToolNames: [react.name],
      activation: {
        getActiveTools: () => ["tool_search", react.name],
        setActiveTools: () => {},
      },
    })!;

    const result = await search.execute(
      "call-1",
      { query: "reaction" },
      undefined,
      undefined,
      undefined as never
    );
    expect(result.details).toMatchObject({ matches: [], added: [] });
  });

  it("matches deferred tools by input property names and descriptions", async () => {
    const lookup = tool(
      "mcp_directory_lookup",
      "Directory lookup",
      "Look up a directory entry.",
      Type.Object({
        email: Type.String({ description: "Work address for the person." }),
      })
    );
    let active = ["tool_search", "mcp_search"];
    const search = createRecipeToolSearch({
      tools: [lookup],
      deferredToolNames: [lookup.name],
      activation: {
        getActiveTools: () => active,
        setActiveTools: (names) => {
          active = names;
        },
      },
    })!;

    const byName = await search.execute(
      "call-1",
      { query: "email" },
      undefined,
      undefined,
      undefined as never
    );
    expect(byName.details).toMatchObject({ added: [lookup.name] });

    active = ["tool_search", "mcp_search"];
    const byDescription = await search.execute(
      "call-2",
      { query: "work address" },
      undefined,
      undefined,
      undefined as never
    );
    expect(byDescription.details).toMatchObject({ added: [lookup.name] });
  });

  it("keeps mcp_search as an active alias when MCP tools are deferred", async () => {
    const contacts = tool(
      "mcp_contacts_search_candidates",
      "Search candidates",
      "Find recruiting candidates."
    );
    let active = ["tool_search", "mcp_search"];
    const searches = createRecipeToolSearchTools(
      {
        tools: [contacts],
        deferredToolNames: [contacts.name],
        activation: {
          getActiveTools: () => active,
          setActiveTools: (names) => {
            active = names;
          },
        },
      },
      true
    );

    expect(searches.map((search) => search.name)).toEqual([
      "tool_search",
      "mcp_search",
    ]);
    await searches[1]!.execute(
      "call-1",
      { query: "candidates" },
      undefined,
      undefined,
      undefined as never
    );
    expect(active).toEqual([
      "tool_search",
      "mcp_search",
      "mcp_contacts_search_candidates",
    ]);
  });

  it("rejects deferred names that were not registered", () => {
    expect(() =>
      createRecipeToolSearch({
        tools: [],
        deferredToolNames: ["missing_tool"],
        activation: {
          getActiveTools: () => [],
          setActiveTools: () => {},
        },
      })
    ).toThrow("was not registered before tool search");
  });
});
