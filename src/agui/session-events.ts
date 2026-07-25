import type { AgUiEvent } from "./events.js";

export interface RuntimeAssistantMessageEvent {
  type?:
    | "text_delta"
    | "thinking_delta"
    | "toolcall_start"
    | "toolcall_delta"
    | "toolcall_end"
    | string;
  delta?: string;
  contentIndex?: number;
  partial?: RuntimeMessage;
}

export interface RuntimeMessage {
  role?: string;
  responseId?: string;
  content?: unknown;
}

export interface RuntimeToolResult {
  content?: unknown;
  details?: unknown;
  [key: string]: unknown;
}

export type RuntimeEvent =
  | { type: "agent_start"; turnId?: string }
  | { type: "turn_start"; turnId?: string }
  | {
      type: "message_update";
      message?: RuntimeMessage;
      assistantMessageEvent?: RuntimeAssistantMessageEvent;
    }
  | { type: "message_end"; message?: RuntimeMessage }
  | {
      type: "tool_execution_start";
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId?: string;
      toolName?: string;
      partialResult?: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId?: string;
      toolName?: string;
      result?: RuntimeToolResult;
    }
  | { type: "compaction_start"; reason?: string }
  | {
      type: "compaction_end";
      reason?: string;
      willRetry?: boolean;
      aborted?: boolean;
      errorMessage?: string;
      result?: {
        summary?: string;
        tokensBefore?: number;
        [key: string]: unknown;
      };
    }
  | { type: "agent_end" }
  | { type: "session_settled" }
  | { type: "ag_ui"; event: AgUiEvent }
  | { type: "agent_error"; errorMessage?: string };
