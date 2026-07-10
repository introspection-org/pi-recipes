import { describe, expect, it } from "vitest";
import {
  createMcpCliSessionPolicy,
  validateDelegatedMcpCommand,
} from "../src/mcp-cli-policy.js";

function policy() {
  return createMcpCliSessionPolicy(
    {
      servers: [
        {
          id: "contacts",
          base_url: "https://mcp.example.com/mcp",
          tools: [
            {
              name: "search_contacts",
              input_schema: {
                type: "object",
                properties: { query: { type: "string" }, pageSize: { type: "number" } },
              },
            },
            { name: "get_contact" },
          ],
        },
      ],
    }
  );
}

describe("recipe-session mcporter policy", () => {
  it("allows documented list flags and forces headless authentication", () => {
    expect(
      validateDelegatedMcpCommand(
        ["list", "contacts.search_contacts", "--schema", "--all-parameters"],
        policy()
      )
    ).toEqual({
      command: {
        args: [
          "list",
          "contacts.search_contacts",
          "--schema",
          "--all-parameters",
          "--no-oauth",
        ],
      },
    });
  });

  it("allows safe call formatting and file arguments", () => {
    const result = validateDelegatedMcpCommand(
      [
        "call",
        "contacts.search_contacts",
        "query=@request.txt",
        "--output",
        "json",
        "--save-images",
        "artifacts",
      ],
      policy()
    );
    expect(result.command?.args.at(-1)).toBe("--no-oauth");
  });

  it("inserts no-OAuth mode before literal positional arguments", () => {
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contacts", "--", "--literal-value"],
        policy()
      ).command?.args
    ).toEqual([
      "call",
      "contacts.search_contacts",
      "--no-oauth",
      "--",
      "--literal-value",
    ]);
  });

  it("does not mistake a literal --no-oauth tool value for the CLI guard", () => {
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contacts", "--", "--no-oauth"],
        policy()
      ).command?.args
    ).toEqual([
      "call",
      "contacts.search_contacts",
      "--no-oauth",
      "--",
      "--no-oauth",
    ]);
  });

  it("preserves mcporter syntax, including future non-escape flags", () => {
    expect(
      validateDelegatedMcpCommand(
        ['call', 'contacts.search_contacts(query: "docs/readme.md")'],
        policy()
      ).error
    ).toBeUndefined();
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contacts", "--future-mcporter-option", "value"],
        policy()
      ).command?.args
    ).toEqual([
      "call",
      "contacts.search_contacts",
      "--future-mcporter-option",
      "value",
      "--no-oauth",
    ]);
  });

  it("does not normalize schema-backed named flags before delegation", () => {
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contacts", "--query", "Ada", "--page-size=25"],
        policy()
      ).command?.args
    ).toEqual([
      "call",
      "contacts.search_contacts",
      "--query",
      "Ada",
      "--page-size=25",
      "--no-oauth",
    ]);
  });

  it.each([
    ["list", "--http-url", "https://attacker.example/mcp"],
    ["list", "https://attacker.example/mcp"],
    ["list", "--verbose", "https://attacker.example/mcp"],
    ["list", "--verbose", "attacker.example/mcp"],
    ["call", "https://attacker.example/mcp.fetch"],
    ["call", "contacts.search_contacts", "--config", "/tmp/other.json"],
    ["call", "contacts.search_contacts", "--stdio", "node rogue.mjs"],
    ["call", "contacts.search_contacts", "--tail-log"],
    ["call", "contacts.search_contacts", "--timeout", "--config", "/tmp/other.json"],
    ["config", "add", "rogue", "https://attacker.example/mcp"],
    ["resource", "contacts"],
    ["generate-cli", "contacts"],
    ["emit-ts", "contacts", "--out", "/tmp/client.ts"],
    ["record", "capture"],
    ["daemon", "start"],
    ["serve", "--http", "9999"],
  ])("blocks commands or escape hatches: %j", (...args) => {
    const result = validateDelegatedMcpCommand(args as string[], policy());
    expect(result.error).toMatch(/unavailable|only tools materialized|only servers materialized/);
  });

  it("rejects tools outside the final materialized inventory", () => {
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.delete_workspace"],
        policy()
      ).error
    ).toContain("is not available");
  });

  it("suggests close session server and tool names without auto-calling them", () => {
    expect(
      validateDelegatedMcpCommand(
        ["call", "contact.search_contacts"],
        policy()
      ).error
    ).toContain("Did you mean 'contacts'");
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contact"],
        policy()
      ).error
    ).toContain("Did you mean 'search_contacts'");
  });

  it("keeps calls headless even when the projected transport uses OAuth", () => {
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contacts"],
        policy()
      )
    ).toEqual({
      command: {
        args: ["call", "contacts.search_contacts", "--no-oauth"],
      },
    });
  });

  it("rejects interactive authentication with deployment-neutral recovery", () => {
    expect(validateDelegatedMcpCommand(["auth", "contacts"], policy()).error).toContain(
      "Ask the user to authenticate this MCP connection outside the agent session"
    );
  });
});
