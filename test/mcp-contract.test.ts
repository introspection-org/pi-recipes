import { describe, expect, it } from "vitest";
import {
  compactSchemaType,
  renderToolContract,
  renderToolSignature,
} from "../src/mcp-contract.js";

describe("compact MCP contracts", () => {
  const inputSchema = {
    type: "object",
    properties: {
      q: { type: "string" },
      limit: { type: "integer", minimum: 0, maximum: 250 },
      group: {
        anyOf: [
          { const: "off" },
          {
            type: "object",
            properties: {
              field: { type: "string", minLength: 1 },
              limit: { type: "integer", minimum: 1, maximum: 250 },
            },
            required: ["field"],
          },
        ],
      },
    },
    required: ["q"],
  };

  it("renders unions and constraints without JSON Schema ceremony", () => {
    expect(compactSchemaType(inputSchema.properties.group)).toBe(
      '"off" | {field: string [minLength=1], limit?: integer [1..250]}'
    );
    const outputSchema = {
      type: "object",
      properties: { found: { type: "integer", minimum: 0 } },
      required: ["found"],
    };
    const contract = renderToolContract("nextplay", {
        name: "search_profiles",
        description: "Search profiles.",
        inputSchema,
        outputSchema,
      });
    expect(contract).toBe(
      [
        "nextplay.search_profiles",
        "Search profiles.",
        "",
        "input",
        "  q: string",
        "  limit?: integer [0..250]",
        '  group?: "off" | {field: string [minLength=1], limit?: integer [1..250]}',
        "",
        "output",
        "  found: integer [0..]",
        "",
        "call",
        '  mcp call nextplay.search_profiles q="<q>"',
        "",
      ].join("\n")
    );
    expect(contract.length).toBeLessThan(
      JSON.stringify(inputSchema, null, 2).length + JSON.stringify(outputSchema, null, 2).length
    );
  });

  it("keeps signatures short by default", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`field${index}`, { type: "string" }])
    );
    expect(
      renderToolSignature("nextplay", {
        name: "search",
        inputSchema: { type: "object", properties },
      })
    ).toContain("… +3 optional");
    expect(
      renderToolSignature(
        "nextplay",
        { name: "search", inputSchema: { type: "object", properties } },
        { allParameters: true }
      )
    ).not.toContain("...");
  });

  it("always keeps required parameters visible regardless of property order", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`field${index}`, { type: "string" }])
    );
    const signature = renderToolSignature("nextplay", {
      name: "ordered",
      inputSchema: {
        type: "object",
        properties,
        required: ["field7"],
      },
    });
    expect(signature).toContain("field7: string");
    expect(signature).toContain("… +3 optional");
  });
});
