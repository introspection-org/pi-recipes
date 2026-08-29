export type TeamsEnv = Record<string, string | undefined>;

export interface TeamsHttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null | undefined };
  json(): Promise<unknown>;
}

export type TeamsFetch = (
  url: string,
  init: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
    redirect?: "error";
    signal?: AbortSignal;
  },
) => Promise<TeamsHttpResponse>;

export interface TeamsBotSessionOptions {
  env?: TeamsEnv;
  fetchImpl?: TeamsFetch;
}

/** A Bot Framework activity, narrowed to what the channel contract needs. */
export interface TeamsActivity {
  id?: string;
  type?: string;
  text?: string;
  timestamp?: string;
  replyToId?: string;
  from?: { id?: string; name?: string };
  attachments?: Array<{
    name?: string;
    contentType?: string;
    contentUrl?: string;
  }>;
}

function configured(value: string | undefined): value is string {
  return Boolean(value && value !== "undefined" && value !== "null");
}

/**
 * Transport for the Teams Bot Connector and Microsoft Graph.
 *
 * The credential posture matches Slack's for the same reason: in an
 * Introspection sandbox the request carries the session locator and the egress
 * proxy swaps in the connection credential, so no provider token is ever in
 * the sandbox. Locally a developer-supplied token is used directly.
 *
 * Teams differs from Slack in one way that matters here: the Bot Connector
 * base URL is per-tenant and arrives on the inbound activity (`serviceUrl`)
 * rather than being a fixed host. It is therefore read from the environment
 * the host stamped, never from model input, and it is validated against the
 * Microsoft service domain before use.
 */
export class TeamsBotSession {
  readonly env: TeamsEnv;
  readonly fetchImpl: TeamsFetch;

  constructor(options: TeamsBotSessionOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as TeamsFetch);
  }

  /** The tenant's Bot Connector base, as stamped by the host. */
  serviceUrl(): string {
    const raw = this.env.TEAMS_SERVICE_URL?.trim();
    if (!raw) {
      throw new Error(
        "No Teams service URL is configured. Cloud tasks supply TEAMS_SERVICE_URL from the inbound activity; for a local run, set it to the tenant's Bot Connector base.",
      );
    }
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      !/(^|\.)botframework\.com$|(^|\.)trafficmanager\.net$/.test(url.hostname)
    ) {
      throw new Error(
        `Teams service URL host '${url.hostname}' is not a Microsoft Bot Connector host`,
      );
    }
    return url.toString().replace(/\/$/, "");
  }

  private authorization(): string {
    const localToken = this.env.TEAMS_BOT_TOKEN?.trim();
    if (localToken) return `Bearer ${localToken}`;

    const locator = this.env.INTROSPECTION_TOKEN?.trim();
    const egressUrl = this.env.INTROSPECTION_EGRESS_URL?.trim();
    if (!locator || !egressUrl) {
      throw new Error(
        "Teams tools require TEAMS_BOT_TOKEN locally or the Introspection cloud egress environment",
      );
    }
    return `Bearer ${locator}`;
  }

  /**
   * One Bot Connector or Graph call.
   *
   * The provider URL is left intact for the same reason as Slack: the runtime's
   * proxy dispatcher dials the egress while preserving this host as the HTTP
   * authority, which is what lets the proxy route and pick the credential.
   */
  async call(
    url: string,
    init: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
    } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: this.authorization(),
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      body = JSON.stringify(init.body);
    }
    const response = await this.fetchImpl(url, {
      method: init.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: init.signal,
    });
    if (!response.ok) {
      throw new Error(`Teams ${init.method ?? "GET"} ${url} returned HTTP ${response.status}`);
    }
    if (response.status === 204) return {};
    return await response.json();
  }

  /**
   * Record the posted thread so a later reply resumes the same task.
   *
   * The same origin-bounded task event Slack emits. A failure here does not
   * undo the post, so it is reported rather than retried.
   */
  async recordPosted(
    data: { provider: "teams"; channel: string; ts: string; thread_ts: string },
    signal?: AbortSignal,
  ): Promise<boolean> {
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
