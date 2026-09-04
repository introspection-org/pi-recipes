import { describe, expect, it, vi } from "vitest";
import { createChannelConnectorModule, registerChannelTools, type ChannelAdapter } from "../src/channels/index.js";
import { channelCommand } from "./helpers/channel-command.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

function setup(requireReply = true, origin = true) {
  const pi = createMockExtensionAPI();
  const reply = vi.fn<ChannelAdapter["reply"]>(async () => ({ ref: "message-1" }));
  const adapter = {
    provider: "test",
    capabilities: { react: false, edit: false, retract: false, read: false,
      attach: false, fetchFile: false, documents: false, resolveAuthors: false, permalinks: false },
    reply,
  } as ChannelAdapter;
  registerChannelTools(pi, adapter, {
    requireReply,
    target: () => {
      if (!origin) throw new Error("No origin");
      return { provider: "test", conversation: "C1", thread: "T1" };
    },
  });
  const start = () => pi.emitExtensionEvent({ type: "before_agent_start", prompt: "hello", systemPrompt: "base", systemPromptOptions: { cwd: process.cwd() } }, {});
  const end = (stopReason = "stop", signal?: AbortSignal) => pi.emitExtensionEvent({
    type: "agent_end", messages: [{ role: "assistant", stopReason } as never],
  }, { signal });
  const post = (final?: boolean) => channelCommand(pi, "reply").execute("call", { text: "Answer", ...(final === undefined ? {} : { final }) });
  return { pi, adapter, reply, start, end, post };
}

describe("required channel replies", () => {
  it("merges first-turn attribution into the channel footer and preserves follow-up attribution", async () => {
    const s = setup();
    const [result] = await s.start() as Array<{ message: { content: string } }>;
    const attribution = '\n\n<channel_context>\n{"from":"U1","message_id":"100.1","sent_at":"2026-09-04T07:23:21+00:00"}\n</channel_context>';
    const followUp = 'next\n\n<channel_context>\n{"from":"U2","message_id":"100.2"}\n</channel_context>';
    const messages = [
      { role: "user", content: `hello${attribution}`, timestamp: 0 },
      { role: "custom", customType: "channel-context", content: result!.message.content, display: false, timestamp: 0 },
      { role: "user", content: followUp, timestamp: 1 },
    ];
    const [rendered] = await s.pi.emitExtensionEvent({ type: "context", messages } as never, {}) as Array<{ messages: any[] }>;
    const first = rendered!.messages[0].content.map((part: { text: string }) => part.text).join("");
    expect(first.match(/<channel_context>/g)).toHaveLength(1);
    expect(JSON.parse(first.split("<channel_context>\n")[1]!.split("\n</channel_context>")[0]!)).toMatchObject({
      provider: "test", channel_id: "C1", thread_id: "T1", from: "U1", message_id: "100.1", sent_at: "2026-09-04T07:23:21+00:00",
    });
    expect(rendered!.messages[0].content).toHaveLength(1);
    expect(rendered!.messages[0].content[0].text).toContain("hello\n\n<channel_context>");
    expect(rendered!.messages[1].content).toBe(followUp);
    expect(messages[0]!.content).toBe(`hello${attribution}`);
  });
  it("renders one context footer on the first user message without mutating history", async () => {
    const s = setup();
    const [result] = await s.start() as Array<{ message: { content: string } }>;
    const context = { role: "custom", customType: "channel-context", content: result!.message.content, display: false, timestamp: 0 };
    const messages = [
      { role: "user", content: "hello", timestamp: 0 }, context,
      { role: "user", content: "follow up", timestamp: 1 }, { ...context },
    ];
    const [rendered] = await s.pi.emitExtensionEvent({ type: "context", messages } as never, {}) as Array<{ messages: any[] }>;
    expect(rendered!.messages).toHaveLength(2);
    expect(rendered!.messages[0].content).toHaveLength(1);
    expect(rendered!.messages[0].content[0].text).toContain("hello\n\n<channel_context>");
    expect(rendered!.messages[1].content).toBe("follow up");
    expect(messages[0]!.content).toBe("hello");
    const [resumed] = await s.pi.emitExtensionEvent({ type: "before_agent_start", prompt: "next", systemPrompt: "base", systemPromptOptions: { cwd: process.cwd() } }, {
      sessionManager: { getBranch: () => [{ type: "custom_message", customType: "channel-context" }] },
    }) as Array<{ message?: unknown }>;
    expect(resumed!.message).toBeUndefined();
  });
  it.each([
    { tools: [], commands: ["reply"] },
    { tools: ["channels"], commands: [] },
    { tools: ["channels"], commands: ["read"] },
  ])("rejects a required reply without an enabled reply tool: %j", (selection) => {
    const { adapter } = setup();
    const connector = createChannelConnectorModule({
      provider: "test", capabilities: adapter.capabilities,
      createSession: () => ({ adapter, target: { provider: "test", conversation: "C1" } }),
    });
    expect(() => connector.createExtension({ ...selection, requireReply: true })).toThrow("requireReply");
  });
  it("prompts and makes exactly one correction, then reports failure locally", async () => {
    const s = setup();
    const [prompt] = await s.start();
    expect((prompt as { systemPrompt: string }).systemPrompt).toContain("You must deliver your answer");
    await s.end();
    expect(s.pi.sentMessages[0]).toMatchObject({
      message: { customType: "channel-reply-required", display: false },
      options: { triggerTurn: true, deliverAs: "followUp" },
    });
    await s.end();
    await s.end();
    expect(s.pi.sentMessages).toHaveLength(2);
    expect(s.pi.sentMessages[1]).toMatchObject({
      message: { customType: "channel-delivery-failed", display: true },
      options: { triggerTurn: false },
    });
    expect(s.reply).not.toHaveBeenCalled();
  });

  it.each([undefined, true])("accepts successful final=%s without leaking final to the adapter", async (final) => {
    const s = setup();
    await s.start();
    await s.post(final);
    await s.end();
    expect(s.reply.mock.calls[0]?.[1]).toEqual({ text: "Answer" });
    expect(s.pi.sentMessages).toHaveLength(0);
  });

  it("does not count progress and allows the correction to deliver a final reply", async () => {
    const s = setup();
    await s.start();
    await s.post(false);
    await s.end();
    await s.post();
    await s.end();
    expect(s.pi.sentMessages).toHaveLength(1);
  });

  it("does not count failed delivery and resets on the next user turn", async () => {
    const s = setup();
    await s.start();
    s.reply.mockRejectedValueOnce(new Error("transport failed"));
    await expect(s.post()).rejects.toThrow("transport failed");
    await s.end();
    await s.post();
    await s.end();
    await s.start();
    await s.end();
    expect(s.pi.sentMessages.filter((m) => m.options.triggerTurn)).toHaveLength(2);
  });

  it("checks queued user messages independently of an earlier final reply", async () => {
    const s = setup();
    await s.start();
    await s.post();
    await s.pi.emitExtensionEvent({ type: "message_start", message: { role: "user", content: "next", timestamp: Date.now() } }, {});
    await s.end();
    expect(s.pi.sentMessages).toHaveLength(1);
  });

  it.each([[false, true], [true, false]])("skips opt-out/originless turns (%s, %s)", async (enabled, origin) => {
    const s = setup(enabled, origin);
    await s.start();
    await s.end();
    expect(s.pi.sentMessages).toHaveLength(0);
  });

  it.each(["aborted", "error"])("does not retry %s runs", async (reason) => {
    const s = setup();
    await s.start();
    await s.end(reason);
    expect(s.pi.sentMessages).toHaveLength(0);
  });

  it("does not retry after cancellation", async () => {
    const s = setup();
    await s.start();
    await s.end("stop", AbortSignal.abort());
    expect(s.pi.sentMessages).toHaveLength(0);
  });
});
