/**
 * The MCP tool-call approval gate seam.
 *
 * Before an `mcp call` reaches the endpoint, the CLI resolves the tool's
 * effective approval policy (see `resolveMcpApprovalPolicy` in `mcp.ts`) and,
 * for `always_ask` tools, consults the installed resolver. `always_allow` — the
 * default — always proceeds without a prompt.
 *
 * The resolver is a settable seam because the `mcp` CLI runs detached from the
 * recipe host (in the pooling daemon) with no interaction channel of its own. A
 * host that can reach the user installs a resolver over the interaction
 * back-channel (Phase 1). When no resolver is installed the gate **fails open** —
 * `always_ask` tools run — and logs, consistent with the `always_allow` default;
 * an unaskable approval is never a silent deny.
 *
 * An `allow` may carry `editedArgs` (AG-UI's approveWithEdits): the gate runs the
 * tool with those instead of the model's proposed arguments.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MCP_SESSION_ROOT_ENV } from "./mcp-daemon-protocol.js";
import type { McpApprovalPolicy } from "./recipe-package.js";

export type McpApprovalDecision = "allow" | "deny";

export interface McpApprovalResult {
  decision: McpApprovalDecision;
  /** Arguments to run instead of the proposed ones (approveWithEdits). */
  editedArgs?: Record<string, unknown>;
}

export interface McpApprovalRequest {
  /** Session server id, as written in the tool selector. */
  server: string;
  /** Bare tool name. */
  tool: string;
  /** The resolved policy for this call (`always_ask` when a resolver is asked). */
  policy: McpApprovalPolicy;
  /** The parsed tool arguments, for the host to render (and optionally edit). */
  args: Record<string, unknown>;
}

export type McpApprovalResolver = (
  request: McpApprovalRequest
) => Promise<McpApprovalDecision | McpApprovalResult>;

let approvalResolver: McpApprovalResolver | undefined;

/** Install (or clear) the resolver the gate consults for `always_ask` tools. */
export function setMcpApprovalResolver(
  resolver: McpApprovalResolver | undefined
): void {
  approvalResolver = resolver;
}

/** True when an in-process resolver is installed (standalone / same-process host). */
export function hasMcpApprovalResolver(): boolean {
  return approvalResolver !== undefined;
}

// --- The daemon back-channel: marker + file-grant ---------------------------
//
// The gate runs in the detached daemon Worker with no channel to the host but
// stdout. When an `always_ask` call has no in-process resolver and no grant, the
// gate writes an APPROVAL-REQUIRED marker to stdout (which streams to the host's
// `mcp call` result) and does NOT run the tool. The host raises its own approval
// UI (ctx.ui locally / AG-UI interrupt remotely), and on approval drops a grant
// file into the session-root grants dir; the model's re-invocation then finds
// the grant, runs the APPROVED arguments, and consumes it. Host and Worker share
// the sandbox filesystem, so a file is the simplest cross-process, cross-language
// channel (no daemon-protocol or thin-client changes).

/** Line prefix the host scans for in an `mcp call` result. */
export const MCP_APPROVAL_MARKER_PREFIX = "__PI_MCP_APPROVAL_REQUIRED__";

export interface McpApprovalRequestPayload {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  /** Correlates this request with the grant the host later writes. */
  nonce: string;
}

/** A grant the host writes to authorize exactly one execution of an approved call. */
export interface McpApprovalGrant {
  server: string;
  tool: string;
  /** The user-approved arguments to run (may differ from the proposed ones). */
  args: Record<string, unknown>;
  nonce: string;
  /** Epoch ms the grant was written; used to expire orphans and order FIFO. */
  createdAt?: number;
}

/**
 * A grant lives only long enough for the model's immediately-following
 * re-invocation. Past this it is an orphan (the model never re-invoked) and is
 * ignored + swept, so a stale approval can never authorize a much-later call.
 */
export const APPROVAL_GRANT_TTL_MS = 10 * 60_000;

/**
 * Structural, key-order-insensitive equality for parsed tool arguments. The
 * daemon re-parses the model's re-invocation independently of the host's marker,
 * so the grant is matched on argument *value*, tolerating benign reformatting
 * (key order, whitespace) while still distinguishing a genuinely different call.
 */
export function approvalArgsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  return canonicalize(a) === canonicalize(b);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

/** Render the awaiting-approval marker line the daemon emits to stdout. */
export function formatApprovalMarker(payload: McpApprovalRequestPayload): string {
  return `${MCP_APPROVAL_MARKER_PREFIX}${JSON.stringify(payload)}\n`;
}

/** Parse the awaiting-approval marker out of an `mcp call` result, or null. */
export function parseApprovalMarker(
  output: string
): McpApprovalRequestPayload | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(MCP_APPROVAL_MARKER_PREFIX)) continue;
    try {
      const parsed = JSON.parse(line.slice(MCP_APPROVAL_MARKER_PREFIX.length));
      if (parsed && typeof parsed === "object") {
        return parsed as McpApprovalRequestPayload;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** Grants directory under the MCP session root, shared by host and Worker. */
export function approvalGrantsDir(env: NodeJS.ProcessEnv = process.env): string {
  const root = env[MCP_SESSION_ROOT_ENV] || process.cwd();
  return join(root, ".mcp-approval-grants");
}

/** Host side: write a grant authorizing one execution of an approved call. */
export async function writeApprovalGrant(
  grant: McpApprovalGrant,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const dir = approvalGrantsDir(env);
  await mkdir(dir, { recursive: true });
  const stamped: McpApprovalGrant = { ...grant, createdAt: grant.createdAt ?? Date.now() };
  await writeFile(join(dir, `${grant.nonce}.json`), JSON.stringify(stamped), "utf8");
}

/**
 * Gate side: find and CONSUME a grant for this call.
 *
 * The grant is bound to the exact call it approved: it matches `(server, tool)`
 * AND — when `matchArgs` is supplied (the model's re-parsed re-invocation
 * arguments) — the approved argument *value*. That binding is what keeps
 * `always_ask` honest: a grant approving `send_email(A)` cannot authorize a
 * later `send_email(B)`; B misses the match and is asked on its own. Expired
 * orphans (the model never re-invoked) are swept, never consumed. Among valid
 * matches the OLDEST (by `createdAt`) is taken and deleted (single-use).
 *
 * Returns null when nothing valid matches — the caller then asks (or re-asks).
 */
export async function consumeApprovalGrant(
  server: string,
  tool: string,
  matchArgs?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): Promise<McpApprovalGrant | null> {
  const dir = approvalGrantsDir(env);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }
  const now = Date.now();
  const candidates: Array<{ path: string; grant: McpApprovalGrant }> = [];
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const path = join(dir, file);
    let grant: McpApprovalGrant;
    try {
      grant = JSON.parse(await readFile(path, "utf8")) as McpApprovalGrant;
    } catch {
      continue;
    }
    // Sweep orphaned grants the model never re-invoked (TTL elapsed).
    if (grant.createdAt !== undefined && now - grant.createdAt > APPROVAL_GRANT_TTL_MS) {
      await rm(path, { force: true });
      continue;
    }
    if (grant.server !== server || grant.tool !== tool) continue;
    // Bind to the approved argument value when the caller can prove the call.
    if (matchArgs !== undefined && !approvalArgsEqual(grant.args, matchArgs)) continue;
    candidates.push({ path, grant });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.grant.createdAt ?? 0) - (b.grant.createdAt ?? 0));
  const chosen = candidates[0];
  await rm(chosen.path, { force: true });
  return chosen.grant;
}

/**
 * Host side: sweep every pending grant. Called at session start (and any point
 * the approval context resets) so an orphaned grant from a prior turn or a
 * crashed process can never authorize a future call. Best-effort — a missing
 * directory is a no-op.
 */
export async function clearApprovalGrants(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const dir = approvalGrantsDir(env);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // best-effort: nothing to clear
  }
}

function normalize(
  result: McpApprovalDecision | McpApprovalResult
): McpApprovalResult {
  return typeof result === "string" ? { decision: result } : result;
}

/**
 * Decide whether an MCP tool call may proceed. `always_allow` always allows;
 * `always_ask` consults the installed resolver, failing open to `allow` (and
 * logging) when none is wired.
 */
export async function resolveMcpApproval(
  request: McpApprovalRequest
): Promise<McpApprovalResult> {
  if (request.policy !== "always_ask") return { decision: "allow" };
  if (!approvalResolver) {
    console.warn(
      `[pi-recipes] MCP tool "${request.server}.${request.tool}" is policy ` +
        `"always_ask" but no approval resolver is installed; allowing (fail open).`
    );
    return { decision: "allow" };
  }
  return normalize(await approvalResolver(request));
}
