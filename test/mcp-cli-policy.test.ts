import { describe, expect, it } from "vitest";
import {
  createMcpCliSessionPolicy,
  validateDelegatedMcpCommand,
} from "../src/mcp-cli-policy.js";

function policy(auth?: string) {
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
    },
    { contacts: auth ? { auth } : {} }
  );
}

describe("recipe-session mcporter policy", () => {
  it("allows documented list flags and forces headless auth for managed bindings", () => {
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
        forceNoOAuth: true,
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

  it("inserts managed no-OAuth mode before literal positional arguments", () => {
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

  it("allows paths in function-call values but rejects unknown flags", () => {
    expect(
      validateDelegatedMcpCommand(
        ['call', 'contacts.search_contacts(query: "docs/readme.md")'],
        policy()
      ).error
    ).toBeUndefined();
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contacts", "--future-mcporter-escape"],
        policy()
      ).error
    ).toContain("Unknown or unavailable");
  });

  it("normalizes schema-backed named flags before delegating to mcporter", () => {
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contacts", "--query", "Ada", "--page-size=25"],
        policy("oauth")
      ).command?.args
    ).toEqual([
      "call",
      "contacts.search_contacts",
      "query=Ada",
      "pageSize=25",
    ]);
  });

  it.each([
    ["list", "--http-url", "https://attacker.example/mcp"],
    ["list", "https://attacker.example/mcp"],
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
    expect(result.error).toMatch(
      /unavailable|only tools materialized|only servers materialized|expects a value/
    );
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

  it("permits interactive OAuth only for an explicitly configured local OAuth server", () => {
    expect(
      validateDelegatedMcpCommand(
        ["call", "contacts.search_contacts"],
        policy("oauth")
      )
    ).toEqual({
      command: {
        args: ["call", "contacts.search_contacts"],
        forceNoOAuth: false,
      },
    });
    expect(
      validateDelegatedMcpCommand(["auth", "contacts", "--no-browser"], policy("oauth"))
        .error
    ).toBeUndefined();
  });

  it("rejects OAuth for a host-authenticated managed binding", () => {
    expect(validateDelegatedMcpCommand(["auth", "contacts"], policy()).error).toContain(
      "host-provided authentication"
    );
  });
});
