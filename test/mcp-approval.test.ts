import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  APPROVAL_GRANT_TTL_MS,
  clearApprovalGrants,
  consumeApprovalGrant,
  formatApprovalMarker,
  hasMcpApprovalResolver,
  parseApprovalMarker,
  resolveMcpApproval,
  setMcpApprovalResolver,
  writeApprovalGrant,
} from "../src/mcp-approval.js";

const SESSION_ROOT_ENV = "PI_RECIPES_MCP_SESSION_ROOT";

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

  it("reports whether an in-process resolver is installed", () => {
    expect(hasMcpApprovalResolver()).toBe(false);
    setMcpApprovalResolver(async () => ({ decision: "allow" }));
    expect(hasMcpApprovalResolver()).toBe(true);
  });
});

describe("approval marker", () => {
  it("round-trips a payload through the marker line", () => {
    const payload = {
      server: "gmail",
      tool: "send_email",
      args: { to: "a@b.com" },
      nonce: "n1",
    };
    const marker = formatApprovalMarker(payload);
    // Embedded in surrounding output the way a tool result would carry it.
    expect(parseApprovalMarker(`some log\n${marker}more log`)).toEqual(payload);
  });

  it("returns null when no marker line is present", () => {
    expect(parseApprovalMarker("just a normal tool result\n")).toBeNull();
  });
});

describe("approval file-grant", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-mcp-grant-"));
    env = { [SESSION_ROOT_ENV]: root };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("consumes a matching grant once, returning the approved args", async () => {
    await writeApprovalGrant(
      { server: "gmail", tool: "send_email", args: { to: "safe@corp.com" }, nonce: "n1" },
      env
    );
    const first = await consumeApprovalGrant("gmail", "send_email", undefined, env);
    expect(first?.args).toEqual({ to: "safe@corp.com" });
    // single-use: the second attempt finds nothing
    expect(await consumeApprovalGrant("gmail", "send_email", undefined, env)).toBeNull();
  });

  it("does not match a different server or tool", async () => {
    await writeApprovalGrant(
      { server: "gmail", tool: "send_email", args: {}, nonce: "n1" },
      env
    );
    expect(await consumeApprovalGrant("gmail", "trash", undefined, env)).toBeNull();
    expect(await consumeApprovalGrant("slack", "send_email", undefined, env)).toBeNull();
    // the real one still consumes
    expect(await consumeApprovalGrant("gmail", "send_email", undefined, env)).not.toBeNull();
  });

  it("returns null when no grants directory exists", async () => {
    expect(await consumeApprovalGrant("gmail", "send_email", undefined, env)).toBeNull();
  });

  it("gives each same-tool grant one execution (FIFO by createdAt)", async () => {
    const t = Date.now();
    await writeApprovalGrant(
      { server: "gmail", tool: "send_email", args: { n: 1 }, nonce: "n1", createdAt: t },
      env
    );
    await writeApprovalGrant(
      { server: "gmail", tool: "send_email", args: { n: 2 }, nonce: "n2", createdAt: t + 1_000 },
      env
    );
    expect((await consumeApprovalGrant("gmail", "send_email", undefined, env))?.args).toEqual({ n: 1 });
    expect((await consumeApprovalGrant("gmail", "send_email", undefined, env))?.args).toEqual({ n: 2 });
    expect(await consumeApprovalGrant("gmail", "send_email", undefined, env)).toBeNull();
  });

  it("binds a grant to the approved args: a different call misses it", async () => {
    await writeApprovalGrant(
      { server: "gmail", tool: "send_email", args: { to: "a@b.com" }, nonce: "n1" },
      env
    );
    // A genuinely different send_email (B) must NOT consume A's grant.
    expect(
      await consumeApprovalGrant("gmail", "send_email", { to: "c@d.com" }, env)
    ).toBeNull();
    // The approved call (A) still matches, tolerating key-order reformatting.
    const grant = await consumeApprovalGrant(
      "gmail",
      "send_email",
      { to: "a@b.com" },
      env
    );
    expect(grant?.args).toEqual({ to: "a@b.com" });
  });

  it("disambiguates concurrent same-tool grants by args", async () => {
    const t = Date.now();
    await writeApprovalGrant(
      { server: "gmail", tool: "send_email", args: { to: "a@b.com" }, nonce: "n1", createdAt: t },
      env
    );
    await writeApprovalGrant(
      { server: "gmail", tool: "send_email", args: { to: "b@b.com" }, nonce: "n2", createdAt: t + 1_000 },
      env
    );
    // Each re-invoke consumes exactly its own approval, regardless of order.
    expect((await consumeApprovalGrant("gmail", "send_email", { to: "b@b.com" }, env))?.nonce).toBe("n2");
    expect((await consumeApprovalGrant("gmail", "send_email", { to: "a@b.com" }, env))?.nonce).toBe("n1");
    expect(await consumeApprovalGrant("gmail", "send_email", { to: "a@b.com" }, env)).toBeNull();
  });

  it("sweeps an orphaned grant past its TTL instead of consuming it", async () => {
    await writeApprovalGrant(
      {
        server: "gmail",
        tool: "send_email",
        args: { to: "a@b.com" },
        nonce: "n1",
        createdAt: Date.now() - (APPROVAL_GRANT_TTL_MS + 1_000),
      },
      env
    );
    expect(
      await consumeApprovalGrant("gmail", "send_email", { to: "a@b.com" }, env)
    ).toBeNull();
    // and it is gone — a fresh grant for the same call is unaffected
    await writeApprovalGrant(
      { server: "gmail", tool: "send_email", args: { to: "a@b.com" }, nonce: "n2" },
      env
    );
    expect(
      await consumeApprovalGrant("gmail", "send_email", { to: "a@b.com" }, env)
    ).not.toBeNull();
  });

  it("clearApprovalGrants sweeps every pending grant", async () => {
    await writeApprovalGrant(
      { server: "gmail", tool: "send_email", args: { to: "a@b.com" }, nonce: "n1" },
      env
    );
    await clearApprovalGrants(env);
    expect(
      await consumeApprovalGrant("gmail", "send_email", { to: "a@b.com" }, env)
    ).toBeNull();
  });
});
