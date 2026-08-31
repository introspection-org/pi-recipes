import { describe, expect, it } from "vitest";

import {
  TEAMS_CHANNEL_CAPABILITIES,
  TeamsBotSession,
  TeamsChannelAdapter,
  teamsActivityMessage,
  teamsChannelTarget,
} from "../packages/channels/teams/src/index.js";
import { registerChannelTools } from "../src/channels/index.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const SERVICE_URL = "https://smba.trafficmanager.net/amer/";

function fakeFetch(options: { status?: number; payload?: unknown } = {}) {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const impl = (async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url: String(url), init });
    return {
      ok: (options.status ?? 200) < 400,
      status: options.status ?? 200,
      headers: { get: () => null },
      json: async () => options.payload ?? { id: "activity-2" },
    };
  }) as never;
  (impl as unknown as { calls: typeof calls }).calls = calls;
  return impl as unknown as ((...args: never[]) => never) & { calls: typeof calls };
}

function teamsTools(env: Record<string, string> = {}) {
  const fetchImpl = fakeFetch();
  const session = new TeamsBotSession({
    env: {
      TEAMS_BOT_TOKEN: "bot-token",
      TEAMS_SERVICE_URL: SERVICE_URL,
      TEAMS_CONVERSATION_ID: "19:meeting@thread.v2",
      TEAMS_ACTIVITY_ID: "activity-1",
      ...env,
    },
    fetchImpl: fetchImpl as never,
  });
  const pi = createMockExtensionAPI();
  registerChannelTools(pi, new TeamsChannelAdapter(session), {
    target: {
      provider: "teams",
      conversation: "19:meeting@thread.v2",
      thread: "activity-1",
    },
  });
  return { pi, fetchImpl };
}

const call = (
  pi: ReturnType<typeof createMockExtensionAPI>,
  name: string,
  params: unknown,
) =>
  pi.tools
    .get(name)
    ?.execute("tool-call", params as never, undefined, undefined, undefined as never);

describe("Teams channel target", () => {
  it("prefers the cloud task origin and refuses another provider's origin", () => {
    expect(
      teamsChannelTarget({
        INTROSPECTION_TASK_CHANNEL_PROVIDER: "teams",
        INTROSPECTION_TASK_CHANNEL_ID: "19:abc",
        INTROSPECTION_TASK_THREAD_ID: "activity-9",
      }),
    ).toEqual({ provider: "teams", conversation: "19:abc", thread: "activity-9" });

    expect(() =>
      teamsChannelTarget({
        INTROSPECTION_TASK_CHANNEL_PROVIDER: "slack",
        INTROSPECTION_TASK_CHANNEL_ID: "C1",
      }),
    ).toThrow(/not Teams/);

    expect(() => teamsChannelTarget({})).toThrow(/No Teams conversation/);
  });
});

describe("Teams transport", () => {
  it("accepts the supported Bot Connector host", () => {
    const session = new TeamsBotSession({
      env: { TEAMS_BOT_TOKEN: "t", TEAMS_SERVICE_URL: SERVICE_URL },
    });
    expect(session.serviceUrl()).toBe("https://smba.trafficmanager.net/amer");
  });

  it("refuses customer-controlled Traffic Manager hosts", () => {
    for (const serviceUrl of [
      "https://attacker.trafficmanager.net/amer/",
      "https://smba.trafficmanager.net.attacker.example/amer/",
      "https://evil.example/",
    ]) {
      const session = new TeamsBotSession({
        env: { TEAMS_BOT_TOKEN: "t", TEAMS_SERVICE_URL: serviceUrl },
      });
      expect(() => session.serviceUrl()).toThrow(
        /not a Microsoft Bot Connector host/,
      );
    }
  });

  it("does not send a cloud locator without the provider egress URL", async () => {
    const fetchImpl = fakeFetch();
    const session = new TeamsBotSession({
      env: { INTROSPECTION_TOKEN: "session-locator", TEAMS_SERVICE_URL: SERVICE_URL },
      fetchImpl: fetchImpl as never,
    });
    await expect(
      session.call(`${SERVICE_URL}v3/conversations/x/activities`, { method: "POST", body: {} }),
    ).rejects.toThrow(/cloud egress environment/);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("sends the session locator to the provider URL in cloud", async () => {
    const fetchImpl = fakeFetch();
    const session = new TeamsBotSession({
      env: {
        INTROSPECTION_TOKEN: "session-locator",
        INTROSPECTION_EGRESS_URL: "http://egress.internal:8081",
        TEAMS_SERVICE_URL: SERVICE_URL,
      },
      fetchImpl: fetchImpl as never,
    });
    await session.call(`${SERVICE_URL}v3/conversations/x/activities`, { method: "POST", body: {} });
    expect(fetchImpl.calls[0]!.url).toContain("smba.trafficmanager.net");
    expect(fetchImpl.calls[0]!.init.headers).toMatchObject({
      Authorization: "Bearer session-locator",
    });
  });
});

describe("Teams channel tools", () => {
  it("does not expose hosted attachment URLs as file references", () => {
    const message = teamsActivityMessage(
      {
        text: "see the report",
        attachments: [
          {
            name: "report.pdf",
            contentType: "application/pdf",
            contentUrl: "https://sharepoint.example/signed-report-url",
          },
        ],
      },
      "msg_activity",
    );

    expect(message).not.toHaveProperty("attachments");
    expect(JSON.stringify(message)).not.toContain("signed-report-url");
  });

  it("registers only what Teams can do without tenant Graph consent", () => {
    const { pi } = teamsTools();
    expect([...pi.tools.keys()].sort()).toEqual([
      "channel_edit",
      "channel_reply",
      "channel_retract",
    ]);
  });

  it("edits and retracts only messages the agent posted", async () => {
    const { pi, fetchImpl } = teamsTools();
    const posted = (await call(pi, "channel_reply", { text: "first" })) as {
      details: { ref: string };
    };

    await expect(
      call(pi, "channel_edit", { message: "msg_forged", text: "x" }),
    ).rejects.toThrow(/Unknown message reference/);

    await call(pi, "channel_edit", {
      message: posted.details.ref,
      text: "second",
    });
    await call(pi, "channel_retract", { message: posted.details.ref });

    expect(fetchImpl.calls[1]).toMatchObject({
      url: expect.stringContaining("/activities/activity-2"),
      init: { method: "PUT" },
    });
    expect(fetchImpl.calls[2]).toMatchObject({
      url: expect.stringContaining("/activities/activity-2"),
      init: { method: "DELETE" },
    });
  });

  it("replies into the bound conversation thread", async () => {
    const { pi, fetchImpl } = teamsTools();
    const result = (await call(pi, "channel_reply", { text: "**hi**" })) as {
      details: { ref: string };
    };

    const post = fetchImpl.calls[0]!;
    expect(post.url).toBe(
      "https://smba.trafficmanager.net/amer/v3/conversations/19%3Ameeting%40thread.v2/activities/activity-1",
    );
    expect(JSON.parse(String(post.init.body))).toMatchObject({
      type: "message",
      textFormat: "markdown",
      text: "**hi**",
      replyToId: "activity-1",
    });
    expect(result.details.ref).toMatch(/^msg_/);
  });

  it("declares the capability gaps that make it a real second provider", () => {
    expect(TEAMS_CHANNEL_CAPABILITIES.read).toBe(false);
    expect(TEAMS_CHANNEL_CAPABILITIES.react).toBe(false);
    expect(TEAMS_CHANNEL_CAPABILITIES.fetchFile).toBe(false);
    expect(TEAMS_CHANNEL_CAPABILITIES.resolveAuthors).toBe(true);
  });
});
