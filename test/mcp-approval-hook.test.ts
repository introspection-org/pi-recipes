import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPiRecipesExtension } from "../src/pi-extension.js";
import {
  consumeApprovalGrant,
  formatApprovalMarker,
} from "../src/mcp-approval.js";
import { createMockExtensionAPI } from "../src/testing.js";

const SESSION_ROOT_ENV = "PI_RECIPES_MCP_SESSION_ROOT";

function ctxFor(ui: Record<string, unknown> = {}) {
  return {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    ui: { notify: vi.fn(), ...ui },
  } as never;
}

async function emitBashResult(text: string, ui: Record<string, unknown>) {
  const pi = createMockExtensionAPI();
  createPiRecipesExtension()(pi);
  const results = await pi.emitExtensionEvent(
    {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "call-1",
      input: {},
      content: [{ type: "text", text }],
      isError: false,
    } as never,
    ctxFor(ui)
  );
  return results[0] as { content?: Array<{ text: string }> } | undefined;
}

describe("MCP approval marker hook (local)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-mcp-hook-"));
    process.env[SESSION_ROOT_ENV] = root;
  });
  afterEach(() => {
    delete process.env[SESSION_ROOT_ENV];
    rmSync(root, { recursive: true, force: true });
  });

  const marker = () =>
    formatApprovalMarker({
      server: "gmail",
      tool: "send_email",
      args: { to: "a@b.com" },
      nonce: "n1",
    });

  it("ignores a bash result with no marker", async () => {
    const select = vi.fn();
    const result = await emitBashResult("just normal output\n", { select });
    expect(result).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("approves: writes a grant with the proposed args and nudges re-invoke", async () => {
    const select = vi.fn(async () => "Approve");
    const result = await emitBashResult(`log line\n${marker()}`, { select });

    expect(select).toHaveBeenCalledOnce();
    expect(result?.content?.[0].text).toContain("Re-invoke");
    // The grant is on disk for the model's re-invocation to consume.
    const grant = await consumeApprovalGrant("gmail", "send_email");
    expect(grant?.args).toEqual({ to: "a@b.com" });
  });

  it("declines: returns the declined envelope and writes no grant", async () => {
    const select = vi.fn(async () => "Request changes");
    const input = vi.fn(async () => undefined);
    const result = await emitBashResult(marker(), { select, input });

    expect(result?.content?.[0].text).toContain("declined");
    expect(await consumeApprovalGrant("gmail", "send_email")).toBeNull();
  });
});
