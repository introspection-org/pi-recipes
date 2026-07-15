import type { McpToolCatalogEntry } from "./mcp.js";

export const MCP_DAEMON_SOCKET_ENV = "PI_RECIPES_MCP_DAEMON_SOCKET";
export const MCP_DAEMON_TOKEN_ENV = "PI_RECIPES_MCP_DAEMON_TOKEN";
export const MCP_DAEMON_FINGERPRINT_ENV = "PI_RECIPES_MCP_DAEMON_FINGERPRINT";
export const MCP_DAEMON_PARENT_PID_ENV = "PI_RECIPES_MCP_DAEMON_PARENT_PID";
export const MCP_SESSION_ROOT_ENV = "PI_RECIPES_MCP_SESSION_ROOT";

export interface McpDaemonExecuteRequest {
  type: "execute";
  id: string;
  token: string;
  fingerprint: string;
  args: string[];
  stdin: string;
}

export interface McpDaemonCancelRequest {
  type: "cancel";
  id: string;
  token: string;
  requestId: string;
}

export interface McpDaemonStopRequest {
  type: "stop";
  id: string;
  token: string;
}

export interface McpDaemonPingRequest {
  type: "ping";
  id: string;
  token: string;
  fingerprint: string;
}

export interface McpDaemonCatalogRequest {
  type: "catalog";
  id: string;
  token: string;
  fingerprint: string;
  timeoutMs: number;
}

export interface McpCatalogServer {
  id: string;
  name: string;
  tools: McpToolCatalogEntry[];
  error?: string;
}

export type McpDaemonRequest =
  | McpDaemonExecuteRequest
  | McpDaemonCancelRequest
  | McpDaemonStopRequest
  | McpDaemonPingRequest
  | McpDaemonCatalogRequest;

export type McpDaemonEnvelope =
  | { id: string; stream: "stdout" | "stderr"; data: string }
  | { id: string; ready: true; fingerprint: string }
  | { id: string; catalogs: McpCatalogServer[] }
  | { id: string; exitCode: number }
  | { id: string; error: string };
