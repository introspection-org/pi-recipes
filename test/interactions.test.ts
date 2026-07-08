import { describe, expect, it } from "vitest";
import type {
  ExtensionContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_RPC_DIALOG_TIMEOUT_MS,
  ELICIT_REASON_CONFIRMATION,
  ELICIT_REASON_INPUT_REQUIRED,
  elicit,
  suppressInterruptResume,
  type ElicitOutcome,
} from "../src/interactions.js";

interface FakeUiCall {
  kind: "select" | "input" | "confirm";
  title: string;
  options?: string[];
  dialog?: ExtensionUIDialogOptions;
}

function fakeCtx(opts: {
  hasUI: boolean;
  mode?: "tui" | "rpc" | "print";
  selectResults?: Array<string | undefined>;
  inputResults?: Array<string | undefined>;
}): { ctx: ExtensionContext; calls: FakeUiCall[] } {
  const calls: FakeUiCall[] = [];
  const selectResults = [...(opts.selectResults ?? [])];
  const inputResults = [...(opts.inputResults ?? [])];
  const ctx = {
    hasUI: opts.hasUI,
    mode: opts.mode ?? "tui",
    ui: {
      async select(
        title: string,
        options: string[],
        dialog?: ExtensionUIDialogOptions
      ) {
        calls.push({ kind: "select", title, options, dialog });
        return selectResults.shift();
      },
      async input(
        title: string,
        _placeholder?: string,
        dialog?: ExtensionUIDialogOptions
      ) {
        calls.push({ kind: "input", title, dialog });
        return inputResults.shift();
      },
      async confirm() {
        calls.push({ kind: "confirm", title: "" });
        return false;
      },
      notify() {},
    },
  } as unknown as ExtensionContext;
  return { ctx, calls };
}

const question = {
  reason: ELICIT_REASON_INPUT_REQUIRED,
  message: "Which beverage?",
};

describe("elicit", () => {
  it("auto-approve declines questions and approves confirmations without dialogs", async () => {
    const { ctx, calls } = fakeCtx({ hasUI: true, selectResults: ["Tea"] });
    const env = { PI_ELICIT_AUTO_APPROVE: "1" };

    const declined = await elicit(question, {
      toolCallId: "tool-1",
      ctx,
      signal: undefined,
      env,
    });
    expect(declined.outcome).toEqual({ type: "declined" });
    expect(declined.content).toEqual([
      {
        type: "text",
        text: "User declined to answer. Proceed with your best judgment.",
      },
    ]);

    const approved = await elicit(
      { reason: ELICIT_REASON_CONFIRMATION, message: "Ship the plan?" },
      { toolCallId: "tool-2", ctx, signal: undefined, env }
    );
    expect(approved.outcome).toEqual({ type: "approved" });
    expect(approved.content[0].text).toBe("Approved.");
    expect(calls).toHaveLength(0);
  });

  it("answers an option question through a select dialog", async () => {
    const { ctx, calls } = fakeCtx({ hasUI: true, selectResults: ["Tea"] });
    const result = await elicit(
      { ...question, options: ["Tea", "Coffee"] },
      { toolCallId: "tool-1", ctx, signal: undefined, env: {} }
    );
    expect(result.outcome).toEqual({ type: "answered", answer: "Tea" });
    expect(result.content).toEqual([{ type: "text", text: "Answer: Tea" }]);
    expect(result.details.interrupt).toBeUndefined();
    expect(calls).toEqual([
      expect.objectContaining({
        kind: "select",
        title: "Which beverage?",
        options: ["Tea", "Coffee"],
      }),
    ]);
  });

  it("answers a free-form question through an input dialog", async () => {
    const { ctx } = fakeCtx({ hasUI: true, inputResults: ["  Chai  "] });
    const result = await elicit(question, {
      toolCallId: "tool-1",
      ctx,
      signal: undefined,
      env: {},
    });
    expect(result.outcome).toEqual({ type: "answered", answer: "Chai" });
    expect(result.content[0].text).toBe("Answer: Chai");
  });

  it("treats empty and dismissed dialog answers as declines", async () => {
    for (const inputResult of ["", "   ", undefined]) {
      const { ctx } = fakeCtx({ hasUI: true, inputResults: [inputResult] });
      const result = await elicit(question, {
        toolCallId: "tool-1",
        ctx,
        signal: undefined,
        env: {},
      });
      expect(result.outcome).toEqual({ type: "declined" });
      expect(result.content[0].text).toBe(
        "User declined to answer. Proceed with your best judgment."
      );
    }
  });

  it("propagates a turn abort instead of fabricating a decline", async () => {
    const controller = new AbortController();
    const { ctx } = fakeCtx({ hasUI: true, selectResults: [undefined] });
    controller.abort();
    await expect(
      elicit(
        { ...question, options: ["Tea", "Coffee"] },
        { toolCallId: "tool-1", ctx, signal: controller.signal, env: {} }
      )
    ).rejects.toThrow("User interaction aborted");
  });

  it("walks approvals through select + optional feedback input", async () => {
    const approve = fakeCtx({ hasUI: true, selectResults: ["Approve"] });
    const approved = await elicit(
      { reason: ELICIT_REASON_CONFIRMATION, message: "Ship the plan?" },
      { toolCallId: "tool-1", ctx: approve.ctx, signal: undefined, env: {} }
    );
    expect(approved.outcome).toEqual({ type: "approved" });
    expect(approved.content[0].text).toBe("Approved.");
    expect(approve.calls).toEqual([
      expect.objectContaining({
        kind: "select",
        options: ["Approve", "Request changes"],
      }),
    ]);

    const revise = fakeCtx({
      hasUI: true,
      selectResults: ["Request changes"],
      inputResults: ["Rename the flag"],
    });
    const revision = await elicit(
      { reason: ELICIT_REASON_CONFIRMATION, message: "Ship the plan?" },
      { toolCallId: "tool-2", ctx: revise.ctx, signal: undefined, env: {} }
    );
    expect(revision.outcome).toEqual({
      type: "revision_requested",
      feedback: "Rename the flag",
    });
    expect(revision.content[0].text).toBe(
      "Revision requested. Feedback: Rename the flag"
    );

    const reviseNoFeedback = fakeCtx({
      hasUI: true,
      selectResults: ["Request changes"],
      inputResults: [""],
    });
    const bare = await elicit(
      { reason: ELICIT_REASON_CONFIRMATION, message: "Ship the plan?" },
      {
        toolCallId: "tool-3",
        ctx: reviseNoFeedback.ctx,
        signal: undefined,
        env: {},
      }
    );
    expect(bare.outcome).toEqual({ type: "revision_requested" });
    expect(bare.content[0].text).toBe("Revision requested.");
  });

  it("applies the default dialog timeout in RPC mode only", async () => {
    const rpc = fakeCtx({ hasUI: true, mode: "rpc", inputResults: ["yes"] });
    await elicit(question, {
      toolCallId: "tool-1",
      ctx: rpc.ctx,
      signal: undefined,
      env: {},
    });
    expect(rpc.calls[0].dialog?.timeout).toBe(DEFAULT_RPC_DIALOG_TIMEOUT_MS);

    const tui = fakeCtx({ hasUI: true, mode: "tui", inputResults: ["yes"] });
    await elicit(question, {
      toolCallId: "tool-1",
      ctx: tui.ctx,
      signal: undefined,
      env: {},
    });
    expect(tui.calls[0].dialog?.timeout).toBeUndefined();

    const override = fakeCtx({ hasUI: true, mode: "tui", inputResults: ["y"] });
    await elicit(question, {
      toolCallId: "tool-1",
      ctx: override.ctx,
      signal: undefined,
      timeoutMs: 5_000,
      env: {},
    });
    expect(override.calls[0].dialog?.timeout).toBe(5_000);
  });

  it("prefers a custom interactive walk and falls through on undefined", async () => {
    const { ctx, calls } = fakeCtx({ hasUI: true, inputResults: ["fallback"] });
    const custom = await elicit(question, {
      toolCallId: "tool-1",
      ctx,
      signal: undefined,
      env: {},
      interactive: async () => ({ type: "answered", answer: "Custom" }),
    });
    expect(custom.content[0].text).toBe("Answer: Custom");
    expect(calls).toHaveLength(0);

    const fallthrough = await elicit(question, {
      toolCallId: "tool-1",
      ctx,
      signal: undefined,
      env: {},
      interactive: async () => undefined,
    });
    expect(fallthrough.content[0].text).toBe("Answer: fallback");
    expect(calls).toEqual([expect.objectContaining({ kind: "input" })]);
  });

  it("emits an interrupt descriptor when the host supports resume", async () => {
    const { ctx } = fakeCtx({ hasUI: false });
    const result = await elicit(
      {
        ...question,
        options: ["Tea", "Coffee"],
        metadata: { kind: "question", header: "Beverage" },
        expiresAt: "2026-07-09T00:00:00Z",
      },
      {
        toolCallId: "tool-1",
        ctx,
        signal: undefined,
        env: { PI_INTERRUPT_RESUME: "1" },
      }
    );
    expect(result.outcome).toEqual({ type: "awaiting_user" });
    expect(result.content).toEqual([
      { type: "text", text: "Awaiting user response." },
    ]);
    expect(result.details.interrupt).toEqual({
      id: "question:tool-1",
      reason: "input_required",
      message: "Which beverage?",
      toolCallId: "tool-1",
      responseSchema: {
        type: "object",
        properties: {
          answer: {
            type: "string",
            title: "Answer",
            enum: ["Tea", "Coffee"],
          },
        },
        required: ["answer"],
      },
      expiresAt: "2026-07-09T00:00:00Z",
      metadata: {
        kind: "question",
        header: "Beverage",
        question: "Which beverage?",
        options: ["Tea", "Coffee"],
      },
    });
  });

  it("shapes the confirmation interrupt response schema for approvals", async () => {
    const { ctx } = fakeCtx({ hasUI: false });
    const result = await elicit(
      { reason: ELICIT_REASON_CONFIRMATION, message: "Ship the plan?" },
      {
        toolCallId: "tool-9",
        ctx,
        signal: undefined,
        env: { PI_INTERRUPT_RESUME: "1" },
      }
    );
    expect(result.details.interrupt).toMatchObject({
      id: "confirmation:tool-9",
      reason: "confirmation",
      responseSchema: {
        type: "object",
        properties: {
          approved: { type: "boolean", title: "Approve" },
          feedback: { type: "string", title: "Feedback" },
        },
        required: ["approved"],
      },
    });
  });

  it("suppresses the interrupt branch inside a child agent run", async () => {
    const { ctx } = fakeCtx({ hasUI: false });
    const env = { PI_INTERRUPT_RESUME: "1" };

    const suppressed = await suppressInterruptResume(() =>
      elicit(question, { toolCallId: "tool-1", ctx, signal: undefined, env })
    );
    expect(suppressed.outcome).toEqual({ type: "unavailable" });
    expect(suppressed.details.interrupt).toBeUndefined();

    const outside = await elicit(question, {
      toolCallId: "tool-1",
      ctx,
      signal: undefined,
      env,
    });
    expect(outside.outcome).toEqual({ type: "awaiting_user" });
  });

  it("reports unavailability when no interaction channel exists", async () => {
    const { ctx } = fakeCtx({ hasUI: false });
    const result = await elicit(question, {
      toolCallId: "tool-1",
      ctx,
      signal: undefined,
      env: {},
    });
    expect(result.outcome).toEqual({ type: "unavailable" });
    expect(result.content[0].text).toContain("nothing was shown to the user");
    expect(result.content[0].text).toContain("normal assistant reply");
  });

  it("renders the frozen envelope table byte-for-byte", async () => {
    // Shared wire contract with interrupt-capable hosts: the host synthesizes
    // these exact literals when resuming a paused run, so the locally-rendered
    // envelopes must match byte-for-byte.
    const table: Array<{ outcome: ElicitOutcome; text: string }> = [
      { outcome: { type: "answered", answer: "Tea" }, text: "Answer: Tea" },
      { outcome: { type: "approved" }, text: "Approved." },
      {
        outcome: { type: "approved", feedback: "Ship it" },
        text: "Approved. Feedback: Ship it",
      },
      {
        outcome: { type: "revision_requested" },
        text: "Revision requested.",
      },
      {
        outcome: { type: "revision_requested", feedback: "Rename the flag" },
        text: "Revision requested. Feedback: Rename the flag",
      },
      {
        outcome: { type: "declined" },
        text: "User declined to answer. Proceed with your best judgment.",
      },
    ];

    for (const entry of table) {
      const { ctx } = fakeCtx({ hasUI: true });
      const result = await elicit(question, {
        toolCallId: "tool-1",
        ctx,
        signal: undefined,
        env: {},
        interactive: async () => entry.outcome,
      });
      expect(result.content).toEqual([{ type: "text", text: entry.text }]);
    }
  });
});
