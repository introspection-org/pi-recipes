import { createHash } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { slackDownloadRoot, type SlackEnv } from "./origin.js";

// Download bound. Guards the stream and the task workspace, not the model
// payload — media caps for model turns are the consuming recipe's own
// boundary, so a large original whose mp4_low rendition is small stays
// resolvable here.
export const MAX_SLACK_FILE_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const SLACK_API_BASE = "https://slack.com/api";
const SLACK_FILES_HOST = "files.slack.com";

export type SlackFileVariant = "original" | "video_low";

export interface SlackDownloadResult {
  id: string;
  name: string;
  path: string;
  mime_type: string;
  size: number;
  sha256: string;
}

/** Minimal structural fetch so tests inject fakes without DOM types. */
interface SlackHttpResponse {
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
  }
) => Promise<SlackHttpResponse>;

interface SlackFileMetadata {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  mp4_low?: string;
}

export interface SlackFileSessionOptions {
  env?: SlackEnv;
  fetchImpl?: SlackFetch;
  cwd?: string;
}

function requiredFileId(value: unknown): string {
  if (typeof value !== "string") throw new Error("file_id must be a string");
  const cleaned = value.trim();
  if (!cleaned) throw new Error("file_id is required");
  if (cleaned.length > 100) throw new Error("file_id exceeds 100 characters");
  return cleaned;
}

function fileVariant(value: unknown): SlackFileVariant {
  if (value === undefined || value === null || value === "" || value === "original") {
    return "original";
  }
  if (value === "video_low") return "video_low";
  throw new Error('variant must be "original" or "video_low"');
}

// Filesystem-safe segment: strip to a conservative set and refuse dot-only
// names so a hostile Slack filename can never traverse or hide.
function safeSegment(value: unknown, fallback: string): string {
  const cleaned = basename(String(value ?? "")).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

function downloadName(fileId: string, name: unknown, variant: SlackFileVariant): string {
  const id = safeSegment(fileId, "file");
  const base = safeSegment(name, "download");
  if (variant === "video_low") {
    const stem = base.replace(/\.[^.]+$/, "");
    return `${id}-video-low-${stem || "download"}.mp4`;
  }
  return `${id}-${base}`;
}

/**
 * The private URL to fetch, host-pinned. Slack file bytes live only on
 * files.slack.com; anything else in the metadata is treated as hostile.
 */
function downloadUrl(file: SlackFileMetadata, variant: SlackFileVariant): URL {
  let raw: string | undefined;
  if (variant === "video_low") {
    if (!file.mp4_low) throw new Error("file has no video_low rendition");
    if (typeof file.mimetype !== "string" || !file.mimetype.startsWith("video/")) {
      throw new Error("video_low is only available for video files");
    }
    raw = file.mp4_low;
  } else {
    raw = file.url_private_download || file.url_private;
  }
  if (typeof raw !== "string" || !raw) throw new Error("file has no downloadable URL");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== SLACK_FILES_HOST) {
    throw new Error(`file URL host is not ${SLACK_FILES_HOST}`);
  }
  return url;
}

function declaredSize(file: SlackFileMetadata): number {
  const size = file.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new Error("file metadata carries no usable size");
  }
  return size;
}

/**
 * Slack file downloads for channel-origin recipes.
 *
 * The hosted Slack MCP server returns file content into model context, which
 * is exactly wrong for large or private files — these bytes belong in the
 * task workspace, referenced by path.
 *
 * Auth is a plain bearer on both requests. In a cloud sandbox the env is
 * unset and the egress proxy swaps the Authorization header for the
 * workspace bot token; locally SLACK_BOT_TOKEN (files:read) is required and
 * its absence is a typed error before any network call.
 */
export class SlackFileSession {
  private readonly env: SlackEnv;
  private readonly fetchImpl: SlackFetch;
  private readonly cwd: string;

  constructor(options: SlackFileSessionOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as SlackFetch);
    this.cwd = options.cwd ?? process.cwd();
  }

  private localToken(): string {
    return this.env.SLACK_BOT_TOKEN?.trim() || "";
  }

  private inCloudRuntime(): boolean {
    return Boolean(this.env.INTROSPECTION_TASK_CHANNEL_PROVIDER?.trim());
  }

  private authHeader(): string {
    return `Bearer ${this.localToken()}`;
  }

  private async callSlack(method: string, params: Record<string, string>): Promise<unknown> {
    const response = await this.fetchImpl(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        Authorization: this.authHeader(),
      },
      body: new URLSearchParams(params).toString(),
    });
    if (!response.ok) throw new Error(`slack.com/${method} returned ${response.status}`);
    return response.json();
  }

  async downloadFile(input: { file_id: string; variant?: string }): Promise<SlackDownloadResult> {
    const fileId = requiredFileId(input.file_id);
    const variant = fileVariant(input.variant);

    if (!this.localToken() && !this.inCloudRuntime()) {
      throw new Error(
        "slack_workspace_download_file requires SLACK_BOT_TOKEN (a bot token with files:read) when running outside the Introspection runtime"
      );
    }

    const info = (await this.callSlack("files.info", { file: fileId })) as {
      ok?: boolean;
      error?: string;
      file?: SlackFileMetadata;
    };
    if (info.ok !== true) throw new Error(`files.info failed: ${info.error ?? "unknown error"}`);
    const file = info.file;
    if (!file || file.id !== fileId) throw new Error("files.info returned a different file");

    const size = declaredSize(file);
    if (variant === "original" && size > MAX_SLACK_FILE_BYTES) {
      throw new Error(`file is ${size} bytes; the download limit is ${MAX_SLACK_FILE_BYTES}`);
    }

    const url = downloadUrl(file, variant);
    const root = slackDownloadRoot(this.env, this.cwd);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const destination = resolve(root, downloadName(fileId, file.name, variant));

    const response = await this.fetchImpl(url.toString(), {
      headers: { Authorization: this.authHeader() },
      redirect: "error",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new Error(`file download returned ${response.status}`);
    }

    const written = await writeDownload(response, destination, variant === "original" ? size : null);
    return {
      id: fileId,
      name: basename(destination),
      path: destination,
      mime_type: variant === "video_low" ? "video/mp4" : file.mimetype || "application/octet-stream",
      size: written.size,
      sha256: written.sha256,
    };
  }
}

/**
 * Stream to a private partial file, hash while writing, verify, then rename
 * into place. A failure at any point removes the partial so a retry never
 * sees a torn download.
 */
async function writeDownload(
  response: SlackHttpResponse,
  destination: string,
  expectedSize: number | null
): Promise<{ size: number; sha256: string }> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(declared) && declared > MAX_SLACK_FILE_BYTES) {
    throw new Error(`download is ${declared} bytes; the limit is ${MAX_SLACK_FILE_BYTES}`);
  }
  const partial = `${destination}.partial-${createHash("sha256")
    .update(destination + Date.now())
    .digest("hex")
    .slice(0, 12)}`;
  const handle = await open(partial, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    if (!response.body) throw new Error("file download returned no body");
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_SLACK_FILE_BYTES) {
        throw new Error(`download exceeded the ${MAX_SLACK_FILE_BYTES}-byte limit`);
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
    if (expectedSize !== null && size !== expectedSize) {
      throw new Error(`download size ${size} does not match the declared ${expectedSize}`);
    }
    await handle.close();
    await rename(partial, destination);
    return { size, sha256: hash.digest("hex") };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(partial).catch(() => {});
    throw error;
  }
}
