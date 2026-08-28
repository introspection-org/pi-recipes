import {
  resolveSlackOrigin,
  type SlackEnv,
  type SlackOrigin,
} from "./origin.js";
import { toPlainText } from "./format.js";

const SLACK_API_BASE = "https://slack.com/api";

export interface SlackHttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null | undefined };
  json(): Promise<unknown>;
  body: AsyncIterable<Uint8Array> | null;
}

export type SlackFetch = (
  url: string,
  init: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
    redirect?: "error";
    signal?: AbortSignal;
  },
) => Promise<SlackHttpResponse>;

export interface SlackBotSessionOptions {
  env?: SlackEnv;
  fetchImpl?: SlackFetch;
}

export interface SlackApiResult {
  ok?: boolean;
  error?: string;
  channel?: string;
  ts?: string;
  message?: { thread_ts?: string };
  [key: string]: unknown;
}

export interface SlackPostResult {
  ok: true;
  channel: string;
  ts: string;
  thread_ts: string;
  bridge_recorded: boolean;
  bridge_error?: string;
}

type SlackEncoding = "json" | "form";

function configured(value: string | undefined): value is string {
  return Boolean(value && value !== "undefined" && value !== "null");
}

function bodyFor(
  params: Record<string, unknown>,
  encoding: SlackEncoding,
): { contentType: string; body: string } {
  if (encoding === "json") {
    return {
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(params),
    };
  }
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === "string" ? value : String(value));
  }
  return {
    contentType: "application/x-www-form-urlencoded; charset=utf-8",
    body: form.toString(),
  };
}

export class SlackBotSession {
  readonly env: SlackEnv;
  readonly fetchImpl: SlackFetch;

  constructor(options: SlackBotSessionOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as SlackFetch);
  }

  origin(): SlackOrigin {
    const origin = resolveSlackOrigin(this.env);
    if (!origin) {
      throw new Error(
        "No Slack origin is configured. Cloud tasks supply one automatically. For introspection local, set SLACK_CHANNEL_ID and optionally SLACK_THREAD_TS.",
      );
    }
    return origin;
  }

  request(
    url: URL,
    init: Omit<Parameters<SlackFetch>[1], "headers"> & {
      headers?: Record<string, string>;
    },
  ): Promise<SlackHttpResponse> {
    const localToken = this.env.SLACK_BOT_TOKEN?.trim();
    if (localToken) {
      return this.fetchImpl(url.toString(), {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${localToken}`,
        },
      });
    }

    const locator = this.env.INTROSPECTION_TOKEN?.trim();
    const egressUrl = this.env.INTROSPECTION_EGRESS_URL?.trim();
    if (!locator || !egressUrl) {
      throw new Error(
        "Slack tools require SLACK_BOT_TOKEN locally or the Introspection cloud egress environment",
      );
    }
    // Keep the provider URL intact. The runtime's proxy fetch dispatcher uses
    // INTROSPECTION_EGRESS_URL to dial the proxy while preserving this host as
    // the HTTP authority. Rewriting the URL here would make the proxy itself
    // the authority, so Envoy could neither route the request nor select the
    // connector credential.
    return this.fetchImpl(url.toString(), {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${locator}`,
      },
    });
  }

  async call(
    method: string,
    params: Record<string, unknown>,
    encoding: SlackEncoding = "form",
    signal?: AbortSignal,
  ): Promise<SlackApiResult> {
    const encoded = bodyFor(params, encoding);
    const response = await this.request(
      new URL(`${SLACK_API_BASE}/${method}`),
      {
        method: "POST",
        headers: { "Content-Type": encoded.contentType },
        body: encoded.body,
        redirect: "error",
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Slack ${method} returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as SlackApiResult;
    if (payload.ok !== true) {
      throw new Error(
        `Slack ${method} failed: ${payload.error ?? "unknown error"}`,
      );
    }
    return payload;
  }

  async sendMessage(input: {
    text: string;
    plain_text?: string;
    blocks?: unknown[];
    thread_ts?: string;
    start_new_thread?: boolean;
  }, signal?: AbortSignal): Promise<SlackPostResult> {
    const origin = this.origin();
    const threadTs = input.thread_ts?.trim()
      ? input.thread_ts.trim()
      : input.start_new_thread
        ? undefined
        : (origin.thread_ts ?? undefined);
    const payload = await this.call(
      "chat.postMessage",
      {
        channel: origin.channel,
        text: input.plain_text?.trim() || toPlainText(input.text),
        blocks:
          input.blocks && input.blocks.length > 0
            ? input.blocks
            : [{ type: "markdown", text: input.text }],
        ...(threadTs ? { thread_ts: threadTs } : {}),
      },
      "json",
      signal,
    );
    const channel = payload.channel || origin.channel;
    const ts = payload.ts;
    if (!ts)
      throw new Error("Slack chat.postMessage returned no message timestamp");
    const postedThread = payload.message?.thread_ts || threadTs || ts;

    try {
      const bridgeRecorded = await this.recordPostedMessage(
        {
          provider: "slack",
          channel,
          ts,
          thread_ts: postedThread,
        },
        signal,
      );
      return {
        ok: true,
        channel,
        ts,
        thread_ts: postedThread,
        bridge_recorded: bridgeRecorded,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        ok: true,
        channel,
        ts,
        thread_ts: postedThread,
        bridge_recorded: false,
        bridge_error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async recordPostedMessage(data: {
    provider: "slack";
    channel: string;
    ts: string;
    thread_ts: string;
  }, signal?: AbortSignal): Promise<boolean> {
    const baseUrl = this.env.INTROSPECTION_BASE_API_URL?.trim();
    const taskId = this.env.INTROSPECTION_TASK_ID?.trim();
    const token = this.env.INTROSPECTION_TOKEN?.trim();
    if (!configured(baseUrl) || !configured(taskId) || !configured(token)) {
      return false;
    }
    const runId =
      this.env.INTROSPECTION_TASK_RUN_ID?.trim() ||
      this.env.INTROSPECTION_TASK_CONVERSATION_ID?.trim();
    const response = await this.fetchImpl(
      `${baseUrl.replace(/\/$/, "")}/internal/tasks/${taskId}/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "connector_posted",
          run_id: runId || undefined,
          occurred_at: new Date().toISOString(),
          data,
        }),
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(`connector_posted returned HTTP ${response.status}`);
    }
    return true;
  }
}
