import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_SLACK_FILE_BYTES,
  SlackFileSession,
  registerSlackTools,
  resolveSlackOrigin,
  slackDownloadRoot,
  slackMessageBody,
  toPlainText,
  type SlackFetch,
} from "../src/slack/index.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

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

interface FakeFetchOptions {
  file?: Record<string, unknown>;
  body?: string;
  downloadStatus?: number;
}

function fakeFetch(options: FakeFetchOptions = {}) {
  const { file = fakeFile(), body = "data", downloadStatus = 200 } = options;
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const impl = (async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("files.info")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true, file }),
        body: null,
      };
    }
    const bytes = Buffer.from(body);
    return {
      ok: downloadStatus === 200,
      status: downloadStatus,
      headers: { get: (name: string) => (name === "content-length" ? String(bytes.length) : null) },
      json: async () => ({}),
      body: (async function* stream() {
        yield new Uint8Array(bytes);
      })(),
    };
  }) as unknown as SlackFetch & { calls: typeof calls };
  (impl as { calls: typeof calls }).calls = calls;
  return impl;
}

async function sessionInTmp(options: FakeFetchOptions & { env?: Record<string, string> } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "slack-glue-"));
  const fetchImpl = fakeFetch(options);
  return {
    cwd,
    fetchImpl,
    session: new SlackFileSession({
      env: { SLACK_BOT_TOKEN: "xoxb-local", ...options.env },
      fetchImpl,
      cwd,
    }),
  };
}

describe("resolveSlackOrigin", () => {
  it("prefers the cloud task origin", () => {
    const cloud = resolveSlackOrigin({
      INTROSPECTION_TASK_CHANNEL_PROVIDER: "slack",
      INTROSPECTION_TASK_CHANNEL_ID: "C1",
      INTROSPECTION_TASK_THREAD_ID: "1.1",
    });
    expect(cloud).toEqual({ provider: "slack", channel: "C1", thread_ts: "1.1" });

    const local = resolveSlackOrigin({ SLACK_CHANNEL_ID: "C9" });
    expect(local).toEqual({ provider: "slack", channel: "C9", thread_ts: null });

    expect(resolveSlackOrigin({})).toBeNull();
  });
});

describe("slackDownloadRoot", () => {
  it("honors the runtime dir and falls back to cwd", () => {
    expect(slackDownloadRoot({ INTROSPECTION_RUNTIME_FILES_DIR: "/workspace/files" }, "/elsewhere")).toBe(
      "/workspace/files/slack"
    );
    expect(slackDownloadRoot({}, "/somewhere")).toBe("/somewhere/files/slack");
  });
});

describe("SlackFileSession", () => {
  it("fails before any network call without SLACK_BOT_TOKEN locally", async () => {
    const fetchImpl = fakeFetch();
    const cwd = await mkdtemp(join(tmpdir(), "slack-glue-"));
    const session = new SlackFileSession({ env: {}, fetchImpl, cwd });
    await expect(session.downloadFile({ file_id: "F123" })).rejects.toThrow(/requires SLACK_BOT_TOKEN/);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("sends the session locator in an Introspection sandbox for the egress to swap", async () => {
    const fetchImpl = fakeFetch();
    const cwd = await mkdtemp(join(tmpdir(), "slack-glue-"));
    const session = new SlackFileSession({
      env: { INTROSPECTION_TOKEN: "locator-jwt" },
      fetchImpl,
      cwd,
    });
    const result = await session.downloadFile({ file_id: "F123" });
    expect((fetchImpl.calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer locator-jwt"
    );
    expect(result.size).toBe(4);
  });

  it("prefers a local bot token over the session locator", async () => {
    const fetchImpl = fakeFetch();
    const cwd = await mkdtemp(join(tmpdir(), "slack-glue-"));
    const session = new SlackFileSession({
      env: { SLACK_BOT_TOKEN: "xoxb-local", INTROSPECTION_TOKEN: "locator-jwt" },
      fetchImpl,
      cwd,
    });
    await session.downloadFile({ file_id: "F123" });
    expect((fetchImpl.calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer xoxb-local"
    );
  });

  it("lands downloads under the root with a safe name, sha256, and verified size", async () => {
    const { session, cwd } = await sessionInTmp({ file: fakeFile({ name: "../..//weird name!.png" }) });
    const result = await session.downloadFile({ file_id: "F123" });
    expect(result.path.startsWith(join(cwd, "files", "slack"))).toBe(true);
    expect(result.path.includes("..")).toBe(false);
    expect(result.mime_type).toBe("image/png");
    expect(result.size).toBe(4);
    expect(result.sha256).toHaveLength(64);
    expect(await readFile(result.path, "utf8")).toBe("data");
    const leftovers = (await readdir(join(cwd, "files", "slack"))).filter((name) => name.includes("partial"));
    expect(leftovers).toEqual([]);
  });

  it("refuses a download URL off files.slack.com", async () => {
    const { session } = await sessionInTmp({
      file: fakeFile({ url_private_download: "https://evil.example/crash.png" }),
    });
    await expect(session.downloadFile({ file_id: "F123" })).rejects.toThrow(/files\.slack\.com/);
  });

  it("refuses a mismatched files.info id", async () => {
    const { session } = await sessionInTmp({ file: fakeFile({ id: "F999" }) });
    await expect(session.downloadFile({ file_id: "F123" })).rejects.toThrow(/different file/);
  });

  it("refuses oversized files before streaming", async () => {
    const { session } = await sessionInTmp({ file: fakeFile({ size: MAX_SLACK_FILE_BYTES + 1 }) });
    await expect(session.downloadFile({ file_id: "F123" })).rejects.toThrow(/download limit/);
  });

  it("removes the partial download on a size mismatch", async () => {
    const { session, cwd } = await sessionInTmp({ file: fakeFile({ size: 999 }), body: "data" });
    await expect(session.downloadFile({ file_id: "F123" })).rejects.toThrow(/does not match/);
    expect(await readdir(join(cwd, "files", "slack"))).toEqual([]);
  });

  it("requires an mp4_low rendition for video_low and forces mp4 naming", async () => {
    const { session: noRendition } = await sessionInTmp({ file: fakeFile() });
    await expect(noRendition.downloadFile({ file_id: "F123", variant: "video_low" })).rejects.toThrow(
      /no video_low rendition/
    );

    const { session } = await sessionInTmp({
      file: fakeFile({
        name: "demo.mov",
        mimetype: "video/quicktime",
        mp4_low: "https://files.slack.com/files-pri/T1-F123/demo_low.mp4",
      }),
    });
    const result = await session.downloadFile({ file_id: "F123", variant: "video_low" });
    expect(result.name.endsWith(".mp4")).toBe(true);
    expect(result.mime_type).toBe("video/mp4");
  });

  it("validates argument shapes", async () => {
    const { session } = await sessionInTmp();
    await expect(session.downloadFile({ file_id: "" })).rejects.toThrow(/file_id is required/);
    await expect(session.downloadFile({ file_id: "F1", variant: "huge" })).rejects.toThrow(/variant/);
  });
});

describe("format helpers", () => {
  it("strips Markdown to plain text", () => {
    expect(toPlainText("**bold** and [label](https://x.example) and `code`")).toBe(
      "bold and label and code"
    );
    expect(toPlainText("# Title\n- item\n> quote")).toBe("Title\n• item\nquote");
  });

  it("builds a Slack message body with a plain-text fallback", () => {
    const body = slackMessageBody("**hi** there");
    expect(body.text).toBe("hi there");
    expect(body.blocks).toEqual([{ type: "markdown", text: "**hi** there" }]);

    const explicit = slackMessageBody("**hi**", { plainText: "custom" });
    expect(explicit.text).toBe("custom");
  });
});

describe("registerSlackTools", () => {
  it("registers slack_origin and slack_workspace_download_file", async () => {
    const pi = createMockExtensionAPI();
    registerSlackTools(pi, { env: { SLACK_CHANNEL_ID: "C42", SLACK_THREAD_TS: "9.9" } });
    expect([...pi.tools.keys()].sort()).toEqual(["slack_origin", "slack_workspace_download_file"]);

    const origin = pi.tools.get("slack_origin")!;
    const result = await origin.execute("t1", {}, undefined, undefined, {} as never);
    expect(result.details).toEqual({ provider: "slack", channel: "C42", thread_ts: "9.9" });
  });

  it("slack_origin throws a typed error naming the env vars when unset", async () => {
    const pi = createMockExtensionAPI();
    registerSlackTools(pi, { env: {} });
    const origin = pi.tools.get("slack_origin")!;
    await expect(origin.execute("t1", {}, undefined, undefined, {} as never)).rejects.toThrow(
      /SLACK_CHANNEL_ID/
    );
  });

  it("slack_workspace_download_file returns the download result as details", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "slack-glue-"));
    const fetchImpl = fakeFetch();
    const session = new SlackFileSession({ env: { SLACK_BOT_TOKEN: "xoxb-local" }, fetchImpl, cwd });
    const pi = createMockExtensionAPI();
    registerSlackTools(pi, { session });
    const tool = pi.tools.get("slack_workspace_download_file")!;
    const result = await tool.execute("t1", { file_id: "F123" }, undefined, undefined, {} as never);
    expect((result.details as { id: string }).id).toBe("F123");
  });
});
