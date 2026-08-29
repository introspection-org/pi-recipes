import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_SLACK_FILE_BYTES,
  SlackBotSession,
  SlackChannelAdapter,
  SlackFileSession,
  resolveSlackOrigin,
  slackDownloadRoot,
  slackMessageBody,
  toPlainText,
  type SlackFetch,
} from "../packages/channels/slack/src/index.js";
import { writeAll } from "../packages/channels/slack/src/files.js";
import { registerChannelTools } from "../src/channels/index.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

interface FakeFetchOptions {
  file?: Record<string, unknown>;
  fileBody?: string;
  bridgeStatus?: number;
}

function fakeFile(overrides: Record<string, unknown> = {}) {
  return {
    id: "F123",
    name: "crash.png",
    mimetype: "image/png",
    size: 4,
    url_private_download: "https://files.slack.com/files-pri/T1-F123/crash.png",
    ...overrides,
  };
}

function fakeFetch(options: FakeFetchOptions = {}) {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const file = options.file ?? fakeFile();
  const fileBody = options.fileBody ?? "data";
  const impl = (async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url: String(url), init });
    const parsed = new URL(String(url));
    if (parsed.hostname === "dp.example") {
      const status = options.bridgeStatus ?? 200;
      return response({
        ok: status < 400,
        status,
        payload: { acknowledged: true },
      });
    }
    if (parsed.pathname.endsWith("/api/chat.postMessage")) {
      return response({
        payload: {
          ok: true,
          channel: "C1",
          ts: "200.2",
          message: { thread_ts: "100.1" },
        },
      });
    }
    if (parsed.pathname.endsWith("/api/files.info")) {
      return response({ payload: { ok: true, file } });
    }
    if (parsed.pathname.includes("/files-pri/")) {
      return response({ payload: {}, body: fileBody });
    }
    return response({ payload: { ok: true, messages: [{ ts: "100.1" }] } });
  }) as unknown as SlackFetch & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

function response(options: {
  ok?: boolean;
  status?: number;
  payload: unknown;
  body?: string;
}) {
  const bytes = Buffer.from(options.body ?? "");
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-length" && options.body !== undefined
          ? String(bytes.length)
          : null,
    },
    json: async () => options.payload,
    body:
      options.body === undefined
        ? null
        : (async function* stream() {
            yield new Uint8Array(bytes);
          })(),
  };
}

describe("Slack origin", () => {
  it("uses the cloud origin before local settings", () => {
    expect(
      resolveSlackOrigin({
        INTROSPECTION_TASK_CHANNEL_PROVIDER: "slack",
        INTROSPECTION_TASK_CHANNEL_ID: "C1",
        INTROSPECTION_TASK_THREAD_ID: "100.1",
        SLACK_CHANNEL_ID: "C9",
      }),
    ).toEqual({ provider: "slack", channel: "C1", thread_ts: "100.1" });
    expect(resolveSlackOrigin({ SLACK_CHANNEL_ID: "C9" })).toEqual({
      provider: "slack",
      channel: "C9",
      thread_ts: null,
    });
    expect(
      resolveSlackOrigin({
        INTROSPECTION_TASK_CHANNEL_PROVIDER: "linear",
        INTROSPECTION_TASK_CHANNEL_ID: "I1",
      }),
    ).toBeNull();
  });

  it("resolves the cloud and local file roots", () => {
    expect(
      slackDownloadRoot(
        { INTROSPECTION_RUNTIME_FILES_DIR: "/workspace/files" },
        "/elsewhere",
      ),
    ).toBe("/workspace/files/slack");
    expect(slackDownloadRoot({}, "/somewhere")).toBe("/somewhere/files/slack");
  });
});

describe("SlackBotSession transport", () => {
  it("calls Slack directly with the bot token during a local run", async () => {
    const fetchImpl = fakeFetch();
    const session = new SlackBotSession({
      env: { SLACK_BOT_TOKEN: "local-bot-token", SLACK_CHANNEL_ID: "C1" },
      fetchImpl,
    });
    await session.call("conversations.history", { channel: "C1" });
    expect(fetchImpl.calls[0]!.url).toBe(
      "https://slack.com/api/conversations.history",
    );
    expect(fetchImpl.calls[0]!.init.headers).toMatchObject({
      Authorization: "Bearer local-bot-token",
    });
  });

  it("passes the tool cancellation signal to Slack requests", async () => {
    const fetchImpl = fakeFetch();
    const session = new SlackBotSession({
      env: { SLACK_BOT_TOKEN: "local-bot-token" },
      fetchImpl,
    });
    const controller = new AbortController();

    await session.call(
      "conversations.history",
      { channel: "C1" },
      "form",
      controller.signal,
    );

    expect(fetchImpl.calls[0]!.init.signal).toBe(controller.signal);
  });

  it("keeps the provider URL for the cloud egress dispatcher", async () => {
    const fetchImpl = fakeFetch();
    const session = new SlackBotSession({
      env: {
        INTROSPECTION_TOKEN: "session-locator",
        INTROSPECTION_EGRESS_URL: "http://egress.internal:8081",
      },
      fetchImpl,
    });
    await session.call("conversations.history", { channel: "C1" });
    expect(fetchImpl.calls[0]!.url).toBe(
      "https://slack.com/api/conversations.history",
    );
    expect(fetchImpl.calls[0]!.init.headers).toMatchObject({
      Authorization: "Bearer session-locator",
    });
    expect(fetchImpl.calls[0]!.init.headers).not.toHaveProperty("Host");
  });

  it("does not send a cloud locator without the provider egress URL", async () => {
    const fetchImpl = fakeFetch();
    const session = new SlackBotSession({
      env: { INTROSPECTION_TOKEN: "session-locator" },
      fetchImpl,
    });
    await expect(
      session.call("conversations.history", { channel: "C1" }),
    ).rejects.toThrow(/cloud egress environment/);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("posts once and records the reply bridge in cloud", async () => {
    const fetchImpl = fakeFetch();
    const session = new SlackBotSession({
      env: {
        INTROSPECTION_TASK_CHANNEL_PROVIDER: "slack",
        INTROSPECTION_TASK_CHANNEL_ID: "C1",
        INTROSPECTION_TASK_THREAD_ID: "100.1",
        INTROSPECTION_TOKEN: "session-locator",
        INTROSPECTION_EGRESS_URL: "http://egress.internal:8081",
        INTROSPECTION_BASE_API_URL: "https://dp.example",
        INTROSPECTION_TASK_ID: "task-1",
        INTROSPECTION_TASK_RUN_ID: "run-1",
      },
      fetchImpl,
    });
    const result = await session.sendMessage({ text: "**hello**" });
    expect(result).toMatchObject({
      channel: "C1",
      ts: "200.2",
      thread_ts: "100.1",
      bridge_recorded: true,
    });
    expect(fetchImpl.calls).toHaveLength(2);
    expect(JSON.parse(String(fetchImpl.calls[0]!.init.body))).toMatchObject({
      channel: "C1",
      text: "hello",
      blocks: [{ type: "markdown", text: "**hello**" }],
      thread_ts: "100.1",
    });
    expect(JSON.parse(String(fetchImpl.calls[1]!.init.body))).toMatchObject({
      type: "connector_posted",
      run_id: "run-1",
      data: {
        provider: "slack",
        channel: "C1",
        ts: "200.2",
        thread_ts: "100.1",
      },
    });
  });

  it("splits generated markdown blocks at Slack's block limit", async () => {
    const fetchImpl = fakeFetch();
    const session = new SlackBotSession({
      env: {
        INTROSPECTION_TASK_CHANNEL_ID: "C1",
        SLACK_BOT_TOKEN: "bot-token",
      },
      fetchImpl,
    });
    const text = "a".repeat(12_001);

    await session.sendMessage({ text });

    expect(JSON.parse(String(fetchImpl.calls[0]!.init.body))).toMatchObject({
      blocks: [
        { type: "markdown", text: "a".repeat(12_000) },
        { type: "markdown", text: "a" },
      ],
    });
  });

  it("returns a bridge warning without retrying a successful Slack post", async () => {
    const fetchImpl = fakeFetch({ bridgeStatus: 503 });
    const session = new SlackBotSession({
      env: {
        INTROSPECTION_TASK_CHANNEL_ID: "C1",
        INTROSPECTION_TOKEN: "session-locator",
        INTROSPECTION_EGRESS_URL: "http://egress.internal:8081",
        INTROSPECTION_BASE_API_URL: "https://dp.example",
        INTROSPECTION_TASK_ID: "task-1",
      },
      fetchImpl,
    });
    const result = await session.sendMessage({
      text: "hello",
      start_new_thread: true,
    });
    expect(result.bridge_recorded).toBe(false);
    expect(result.bridge_error).toMatch(/503/);
    expect(
      fetchImpl.calls.filter((call) => call.url.includes("chat.postMessage")),
    ).toHaveLength(1);
  });

  it("keeps a successful Slack post when bookkeeping is cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ ok: true, channel: "C1", ts: "200.2" }),
          body: null,
        };
      }
      controller.abort();
      throw new DOMException("The operation was aborted", "AbortError");
    };
    const session = new SlackBotSession({
      env: {
        SLACK_BOT_TOKEN: "bot-token",
        INTROSPECTION_TASK_CHANNEL_ID: "C1",
        INTROSPECTION_BASE_API_URL: "https://dp.example",
        INTROSPECTION_TASK_ID: "task-1",
        INTROSPECTION_TOKEN: "task-token",
      },
      fetchImpl,
    });

    const result = await session.sendMessage(
      { text: "hello" },
      controller.signal,
    );

    expect(result).toMatchObject({
      channel: "C1",
      ts: "200.2",
      bridge_recorded: false,
      bridge_error: "The operation was aborted",
    });
    expect(calls).toBe(2);
  });
});

describe("Slack file downloads", () => {
  it("retries partial file writes until the whole chunk is written", async () => {
    const source = new Uint8Array([1, 2, 3, 4, 5]);
    const written: number[] = [];
    const writer = {
      async write(buffer: Uint8Array, offset = 0, length = buffer.byteLength) {
        const bytesWritten = Math.min(length, 2);
        written.push(...buffer.slice(offset, offset + bytesWritten));
        return { bytesWritten };
      },
    };

    await writeAll(writer, source);

    expect(written).toEqual([...source]);
  });

  it("writes a safe file with a verified digest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "slack-bot-api-"));
    const fetchImpl = fakeFetch({
      file: fakeFile({ name: "../bad name.png" }),
    });
    const session = new SlackFileSession({
      env: { SLACK_BOT_TOKEN: "local-bot-token" },
      fetchImpl,
      cwd,
    });
    const result = await session.downloadFile({ file_id: "F123" });
    expect(result.path.startsWith(join(cwd, "files", "slack"))).toBe(true);
    expect(result.path.includes(".."), result.path).toBe(false);
    expect(result.sha256).toHaveLength(64);
    expect(await readFile(result.path, "utf8")).toBe("data");
    expect(
      (await readdir(join(cwd, "files", "slack"))).filter((name) =>
        name.includes("partial"),
      ),
    ).toEqual([]);
  });

  it("rejects unsafe hosts and oversized files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "slack-bot-api-"));
    const unsafe = new SlackFileSession({
      env: { SLACK_BOT_TOKEN: "local-bot-token" },
      fetchImpl: fakeFetch({
        file: fakeFile({ url_private_download: "https://evil.example/file" }),
      }),
      cwd,
    });
    await expect(unsafe.downloadFile({ file_id: "F123" })).rejects.toThrow(
      /files\.slack\.com/,
    );

    const oversized = new SlackFileSession({
      env: { SLACK_BOT_TOKEN: "local-bot-token" },
      fetchImpl: fakeFetch({
        file: fakeFile({ size: MAX_SLACK_FILE_BYTES + 1 }),
      }),
      cwd,
    });
    await expect(oversized.downloadFile({ file_id: "F123" })).rejects.toThrow(
      /download limit/,
    );
  });
});


describe("Slack channel tools", () => {
  const cloudEnv = {
    SLACK_BOT_TOKEN: "token",
    SLACK_CHANNEL_ID: "C1",
    SLACK_THREAD_TS: "100.1",
  };

  function slackTools(options: FakeFetchOptions = {}) {
    const pi = createMockExtensionAPI();
    const fetchImpl = fakeFetch(options);
    const adapter = new SlackChannelAdapter(
      new SlackFileSession({ env: cloudEnv, fetchImpl }),
    );
    registerChannelTools(pi, adapter, {
      target: { provider: "slack", conversation: "C1", thread: "100.1" },
    });
    return { pi, fetchImpl };
  }

  const call = (pi: ReturnType<typeof createMockExtensionAPI>, name: string, params: unknown) =>
    pi.tools
      .get(name)
      ?.execute("tool-call", params as never, undefined, undefined, undefined as never);

  it("registers the neutral surface Slack supports and nothing else", () => {
    const { pi } = slackTools();
    expect([...pi.tools.keys()].sort()).toEqual([
      "channel_edit",
      "channel_fetch_file",
      "channel_history",
      "channel_info",
      "channel_react",
      "channel_reply",
      "channel_retract",
    ]);
  });

  it("replies to the bound conversation and returns an opaque reference", async () => {
    const { pi, fetchImpl } = slackTools();
    const result = (await call(pi, "channel_reply", { text: "**hi**" })) as {
      details: { ref: string };
    };

    const post = JSON.parse(
      String(
        fetchImpl.calls.find((c) => c.url.includes("chat.postMessage"))!.init.body,
      ),
    );
    expect(post).toMatchObject({ channel: "C1", thread_ts: "100.1" });
    expect(result.details.ref).toMatch(/^msg_/);
    expect(JSON.stringify(result.details)).not.toContain("200.2");
  });

  it("refuses to edit or retract a message the agent did not author", async () => {
    const { pi } = slackTools();
    const history = (await call(pi, "channel_history", {})) as {
      details: { messages: Array<{ ref: string }> };
    };
    const theirs = history.details.messages[0]!.ref;

    await expect(
      call(pi, "channel_edit", { message: theirs, text: "rewritten" }),
    ).rejects.toThrow(/not sent by this agent/);
    await expect(call(pi, "channel_retract", { message: theirs })).rejects.toThrow(
      /not sent by this agent/,
    );
  });

  it("edits a message the agent posted, addressed only by its reference", async () => {
    const { pi, fetchImpl } = slackTools();
    const posted = (await call(pi, "channel_reply", { text: "first" })) as {
      details: { ref: string };
    };

    await call(pi, "channel_edit", {
      message: posted.details.ref,
      text: "second",
    });

    const update = JSON.parse(
      String(fetchImpl.calls.find((c) => c.url.includes("chat.update"))!.init.body),
    );
    expect(update).toMatchObject({ channel: "C1", ts: "200.2" });
  });

  it("rejects a reference the session never minted", async () => {
    const { pi } = slackTools();
    await expect(
      call(pi, "channel_react", { message: "msg_forged", emoji: "eyes" }),
    ).rejects.toThrow(/Unknown message reference/);
  });

  it("reads history bound to the origin conversation", async () => {
    const { pi, fetchImpl } = slackTools();
    await call(pi, "channel_history", { limit: 5 });

    const read = fetchImpl.calls.find((c) =>
      c.url.includes("conversations.replies"),
    )!;
    expect(String(read.init.body)).toContain("channel=C1");
    expect(String(read.init.body)).toContain("ts=100.1");
  });

  it("splits oversized Markdown into valid Slack blocks", () => {
    expect(slackMessageBody("a".repeat(12_001))).toEqual({
      text: "a".repeat(12_001),
      blocks: [
        { type: "markdown", text: "a".repeat(12_000) },
        { type: "markdown", text: "a" },
      ],
    });
  });

  it("does not split Unicode surrogate pairs at a block boundary", () => {
    const markdown = `${"a".repeat(11_999)}😀b`;

    expect(slackMessageBody(markdown).blocks).toEqual([
      { type: "markdown", text: `${"a".repeat(11_999)}😀` },
      { type: "markdown", text: "b" },
    ]);
  });

  it("rejects Markdown that would exceed Slack's 50 block limit", () => {
    expect(() => slackMessageBody("a".repeat(12_000 * 50 + 1))).toThrow(
      "Slack Markdown exceeds the 50 block limit for one message",
    );
  });
});
