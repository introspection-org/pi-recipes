import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseApprovalPolicy,
  parseMcpToolPolicies,
  tightenApprovalPolicy,
  tightenMcpToolPolicies,
} from "../src/recipe-package.js";
import {
  computeEffectiveApproval,
  resolveMcpApprovalPolicy,
} from "../src/mcp.js";
import {
  resolveMcpApproval,
  setMcpApprovalResolver,
} from "../src/mcp-approval.js";

describe("approval policy model", () => {
  it("parses valid values and leaves absent as undefined", () => {
    expect(parseApprovalPolicy("always_allow")).toBe("always_allow");
    expect(parseApprovalPolicy("always_ask")).toBe("always_ask");
    expect(parseApprovalPolicy(undefined)).toBeUndefined();
    expect(parseApprovalPolicy(null)).toBeUndefined();
  });

  it("fails an unparseable value CLOSED to always_ask", () => {
    expect(parseApprovalPolicy("Always_Ask")).toBe("always_ask");
    expect(parseApprovalPolicy("sometimes")).toBe("always_ask");
    expect(parseApprovalPolicy(3)).toBe("always_ask");
  });

  it("parses a tool-policy map and drops empty keys", () => {
    expect(
      parseMcpToolPolicies({ send: "always_ask", read: "always_allow", "  ": "always_ask" })
    ).toEqual({ send: "always_ask", read: "always_allow" });
    expect(parseMcpToolPolicies({})).toBeUndefined();
    expect(parseMcpToolPolicies(["always_ask"])).toBeUndefined();
    // invalid value fails closed, still present
    expect(parseMcpToolPolicies({ send: "nope" })).toEqual({ send: "always_ask" });
  });

  it("tightens toward always_ask", () => {
    expect(tightenApprovalPolicy("always_allow", "always_ask")).toBe("always_ask");
    expect(tightenApprovalPolicy("always_ask", "always_allow")).toBe("always_ask");
    expect(tightenApprovalPolicy("always_allow", "always_allow")).toBe("always_allow");
    expect(tightenApprovalPolicy(undefined, "always_allow")).toBe("always_allow");
    expect(tightenApprovalPolicy(undefined, undefined)).toBeUndefined();
  });

  it("tightens tool-policy maps per tool", () => {
    expect(
      tightenMcpToolPolicies(
        { send: "always_allow", read: "always_allow" },
        { send: "always_ask" }
      )
    ).toEqual({ send: "always_ask", read: "always_allow" });
  });
});

describe("effective policy resolution", () => {
  it("tightens the package default by every agent layer", () => {
    const effective = computeEffectiveApproval(
      { policy: "always_allow", toolPolicies: { send: "always_ask" } },
      [
        { serverId: "gmail", tools: {}, policy: "always_ask" },
        { serverId: "gmail", tools: {}, toolPolicies: { trash: "always_ask" } },
      ]
    );
    expect(effective).toEqual({
      policy: "always_ask",
      tool_policies: { send: "always_ask", trash: "always_ask" },
    });
  });

  it("resolves per-tool override, else server default, else always_allow", () => {
    const server = {
      policy: "always_allow" as const,
      tool_policies: { send_email: "always_ask" as const },
    };
    expect(resolveMcpApprovalPolicy(server, "send_email")).toBe("always_ask");
    expect(resolveMcpApprovalPolicy(server, "list")).toBe("always_allow");
    expect(resolveMcpApprovalPolicy({}, "anything")).toBe("always_allow");
  });
});

describe("resolveMcpApproval gate", () => {
  afterEach(() => setMcpApprovalResolver(undefined));

  const request = {
    server: "gmail",
    tool: "send_email",
    args: { to: "a@b.com" },
  };

  it("always_allow proceeds without consulting a resolver", async () => {
    const resolver = vi.fn(async () => ({ decision: "deny" as const }));
    setMcpApprovalResolver(resolver);
    expect(await resolveMcpApproval({ ...request, policy: "always_allow" })).toEqual({
      decision: "allow",
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("always_ask fails OPEN (allow) + warns when no resolver is installed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await resolveMcpApproval({ ...request, policy: "always_ask" })).toEqual({
      decision: "allow",
    });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("always_ask consults the resolver and honors a deny", async () => {
    setMcpApprovalResolver(async () => ({ decision: "deny" }));
    expect(await resolveMcpApproval({ ...request, policy: "always_ask" })).toEqual({
      decision: "deny",
    });
  });

  it("carries editedArgs on an approve-with-edits", async () => {
    setMcpApprovalResolver(async () => ({
      decision: "allow",
      editedArgs: { to: "safe@corp.com" },
    }));
    expect(await resolveMcpApproval({ ...request, policy: "always_ask" })).toEqual({
      decision: "allow",
      editedArgs: { to: "safe@corp.com" },
    });
  });
});
