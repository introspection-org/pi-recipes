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
