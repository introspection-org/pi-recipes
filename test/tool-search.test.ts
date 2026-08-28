import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { createRecipeToolSearch } from "../src/tool-search.js";

function tool(
  name: string,
  label: string,
  description: string
): ToolDefinition {
  return {
    name,
    label,
    description,
    parameters: Type.Object({}),
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
