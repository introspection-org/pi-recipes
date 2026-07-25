/**
 * Translates pi agent session events into AG-UI protocol events.
 *
 * One translator instance exists per run stream connection; it owns the per-id
 * lifecycle discipline AG-UI requires: `*_START -> *_CONTENT -> *_END`
 * sequences keyed by messageId / toolCallId, never re-opening an id, and
 * nothing after `RUN_FINISHED` / `RUN_ERROR`.
 *
 * Message ids are synthesized as `{runId}:{kind}:{ordinal}` so they are
 * stable within a connection. A reconnect creates a fresh translator: a
 * message that was mid-stream continues under a new id, which the browser
 * renders as a new bubble — the same behaviour the legacy stream had.
 */

import { EventType } from "@ag-ui/core";
import type { AgUiEvent } from "./events.js";
import type { RuntimeEvent } from "./session-events.js";

interface SessionLike {
  abortRequested: boolean;
  error: string | null;
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (block): block is { type?: string; text?: string; content?: string } => {
        if (!block || typeof block !== "object") return false;
        const type = (block as { type?: string }).type;
        return (
          type === "text" || type === "input_text" || type === "output_text"
        );
      }
    )
    .map((block) => block.text ?? block.content ?? "")
    .join("");
}

function numberField(
  record: Record<string, unknown>,
  key: string
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringField(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = record[key];
  return typeof value === "string" && value ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function contentBlocks(value: unknown): Record<string, unknown>[] {
  const record = recordValue(value);
  if (!record || !Array.isArray(record.content)) return [];
  return record.content.flatMap((block) => {
    const record = recordValue(block);
    return record ? [record] : [];
  });
}

interface ToolCallBlock {
  id: string;
  name: string;
  arguments: unknown;
  partialJson?: string;
}

function toolCallBlockFromMessageUpdate(
  event: Extract<RuntimeEvent, { type: "message_update" }>
): ToolCallBlock | null {
  const assistantEvent = event.assistantMessageEvent;
  const blocks = contentBlocks(event.message ?? assistantEvent?.partial);
  if (blocks.length === 0) return null;
  const indexed =
    assistantEvent?.contentIndex !== undefined
      ? blocks[assistantEvent.contentIndex]
      : undefined;
  const block =
    indexed && indexed.type === "toolCall"
      ? indexed
      : blocks.find((block) => block.type === "toolCall");
  if (!block) return null;
  const id = stringField(block, "id");
  const name = stringField(block, "name");
  if (!id || !name) return null;
  const partialJson = stringField(block, "partialJson") ?? undefined;
  return { id, name, arguments: block.arguments, partialJson };
}

export class AgUiRunTranslator {
  private openTextId: string | null = null;
  private openReasoningId: string | null = null;
  private streamedToolCallsById = new Map<
    string,
    { name: string; args: string; ended: boolean }
  >();
  private streamedTextThisMessage = false;
  private segmentOrdinal = 0;
  private resultOrdinal = 0;
  private runStartEmitted = false;
  private terminal = false;
  private readonly compactionActivityId: string;

  constructor(
    private readonly threadId: string,
    private readonly runId: string
  ) {
    this.compactionActivityId = `${runId}:activity:compaction`;
  }

  /** RUN_STARTED for streams that attach while a run is already live. */
  runStarted(): AgUiEvent[] {
    if (this.runStartEmitted || this.terminal) return [];
    this.runStartEmitted = true;
    return [
      {
        type: EventType.RUN_STARTED,
        threadId: this.threadId,
        runId: this.runId,
      },
    ];
  }

  handleSessionEvent(event: RuntimeEvent, session: SessionLike): AgUiEvent[] {
    if (this.terminal) return [];

    switch (event.type) {
      case "agent_start":
        return this.runStarted();
      case "message_update":
        return this.handleMessageUpdate(event);
      case "message_end":
        return this.handleMessageEnd(event);
      case "tool_execution_start":
        return this.handleToolStart(event);
      case "tool_execution_update":
        return this.handleToolUpdate(event);
      case "tool_execution_end":
        return this.handleToolEnd(event);
      case "compaction_start":
        return this.handleCompactionStart(event);
      case "compaction_end":
        return this.handleCompactionEnd(event);
      case "agent_end":
        return this.handleAgentEnd();
      case "session_settled":
        return this.handleSessionSettled(session);
      case "ag_ui":
        return this.handleAgUiEvent(event);
      case "agent_error":
        return this.handleAgentError(event, session);
      default:
        return [];
    }
  }

  private handleMessageUpdate(
    event: Extract<RuntimeEvent, { type: "message_update" }>
  ): AgUiEvent[] {
    const assistantEvent = event.assistantMessageEvent;
    if (!assistantEvent) return [];

    if (assistantEvent.type === "text_delta" && assistantEvent.delta) {
      this.streamedTextThisMessage = true;
      const events: AgUiEvent[] = [...this.closeReasoning()];
      if (!this.openTextId) {
        this.openTextId = this.nextMessageId("text");
        events.push({
          type: EventType.TEXT_MESSAGE_START,
          messageId: this.openTextId,
          role: "assistant",
        });
      }
      events.push({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: this.openTextId,
        delta: assistantEvent.delta,
      });
      return events;
    }

    if (assistantEvent.type === "thinking_delta" && assistantEvent.delta) {
      const events: AgUiEvent[] = [...this.closeText()];
      if (!this.openReasoningId) {
        this.openReasoningId = this.nextMessageId("reasoning");
        events.push(
          { type: EventType.REASONING_START, messageId: this.openReasoningId },
          {
            type: EventType.REASONING_MESSAGE_START,
            messageId: this.openReasoningId,
            role: "reasoning",
          }
        );
      }
      events.push({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: this.openReasoningId,
        delta: assistantEvent.delta,
      });
      return events;
    }

    if (assistantEvent.type?.startsWith("toolcall_")) {
      return this.handleToolCallMessageUpdate(event);
    }

    return [];
  }

  private handleToolCallMessageUpdate(
    event: Extract<RuntimeEvent, { type: "message_update" }>
  ): AgUiEvent[] {
    const assistantEvent = event.assistantMessageEvent;
    const block = toolCallBlockFromMessageUpdate(event);
    if (!assistantEvent || !block) return [];

    if (assistantEvent.type === "toolcall_start") {
      return this.startStreamedToolCall(block);
    }

    if (assistantEvent.type === "toolcall_delta") {
      const alreadyStarted = this.streamedToolCallsById.has(block.id);
      const events = this.ensureStreamedToolCallStarted(block);
      const delta =
        assistantEvent.delta ??
        (alreadyStarted ? undefined : block.partialJson);
      if (delta) {
        const state = this.streamedToolCallsById.get(block.id);
        if (state) state.args += delta;
        events.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: block.id,
          delta,
        });
      }
      return events;
    }

    if (assistantEvent.type === "toolcall_end") {
      const events = this.ensureStreamedToolCallStarted(block);
      const state = this.streamedToolCallsById.get(block.id);
      if (state && !state.args) {
        const finalArgs = stringifyToolValue(block.arguments ?? {});
        if (finalArgs) {
          state.args += finalArgs;
          events.push({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: block.id,
            delta: finalArgs,
          });
        }
      }
      return [...events, ...this.endStreamedToolCall(block.id)];
    }

    return [];
  }

  private startStreamedToolCall(block: ToolCallBlock): AgUiEvent[] {
    const existing = this.streamedToolCallsById.get(block.id);
    if (existing) return [];
    const events = this.closeOpenMessages();
    this.streamedToolCallsById.set(block.id, {
      name: block.name,
      args: "",
      ended: false,
    });
    return [
      ...events,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: block.id,
        toolCallName: block.name,
      },
    ];
  }

  private ensureStreamedToolCallStarted(block: ToolCallBlock): AgUiEvent[] {
    return this.streamedToolCallsById.has(block.id)
      ? []
      : this.startStreamedToolCall(block);
  }

  private endStreamedToolCall(toolCallId: string): AgUiEvent[] {
    const state = this.streamedToolCallsById.get(toolCallId);
    if (!state || state.ended) return [];
    state.ended = true;
    return [{ type: EventType.TOOL_CALL_END, toolCallId }];
  }

  /**
   * Closes the open message at an assistant message boundary. When no text
   * was streamed for the message (non-streaming provider paths), the full
   * text is emitted as one START/CONTENT/END sandwich instead so the
   * message is not lost.
   */
  private handleMessageEnd(
    event: Extract<RuntimeEvent, { type: "message_end" }>
  ): AgUiEvent[] {
    const events = this.closeOpenMessages();
    const streamed = this.streamedTextThisMessage;
    this.streamedTextThisMessage = false;
    if (streamed) return events;

    const message = event.message;
    if (message?.role !== "assistant") return events;
    const text = extractTextContent(message.content);
    if (!text) return events;

    const messageId = this.nextMessageId("text");
    return [
      ...events,
      { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text },
      { type: EventType.TEXT_MESSAGE_END, messageId },
    ];
  }

  /**
   * RUN_FINISHED for an attach to a run this session already completed
   * (`currentRunId === runId`, no longer streaming). Unmarked — the run
   * genuinely ran to settle; its output is recovered via transcript
   * hydration, not replay.
   */
  finishRunSettled(): AgUiEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [
      ...this.closeOpenMessages(),
      {
        type: EventType.RUN_FINISHED,
        threadId: this.threadId,
        runId: this.runId,
      },
    ];
  }

  /**
   * Terminates the run for stream-level endings that do not come from a
   * session event: idle attach, wait timeout, or another run taking the
   * session. Idempotent once the run is terminal. Marked with
   * `result.reason = "stream_close"` so clients can distinguish "this
   * attach had nothing (left) to stream" from a genuinely settled turn.
   */
  finishRun(): AgUiEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [
      ...this.closeOpenMessages(),
      {
        type: EventType.RUN_FINISHED,
        threadId: this.threadId,
        runId: this.runId,
        result: { reason: "stream_close" },
      },
    ];
  }

  private handleToolStart(
    event: Extract<RuntimeEvent, { type: "tool_execution_start" }>
  ): AgUiEvent[] {
    const toolCallId = event.toolCallId;
    if (!toolCallId) return [];
    const toolCallName = event.toolName ?? "tool";

    if (this.streamedToolCallsById.has(toolCallId)) {
      return this.endStreamedToolCall(toolCallId);
    }

    // Tool args arrive complete on the start event, so the call's
    // START/ARGS/END lifecycle is emitted in one burst; the RESULT
    // follows from tool_execution_end.
    return [
      ...this.closeOpenMessages(),
      { type: EventType.TOOL_CALL_START, toolCallId, toolCallName },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: stringifyToolValue(event.args ?? {}),
      },
      { type: EventType.TOOL_CALL_END, toolCallId },
    ];
  }

  private handleToolUpdate(
    event: Extract<RuntimeEvent, { type: "tool_execution_update" }>
  ): AgUiEvent[] {
    const toolCallId = event.toolCallId;
    if (!toolCallId) return [];
    const partialResult =
      event.partialResult && typeof event.partialResult === "object"
        ? (event.partialResult as Record<string, unknown>)
        : {};
    return [
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: `${this.runId}:activity:tool:${toolCallId}`,
        activityType: "tool_call_progress",
        replace: true,
        content: {
          toolCallId,
          toolName: event.toolName ?? null,
          output: partialResult,
          details: partialResult.details,
        },
      },
    ];
  }

  private handleToolEnd(
    event: Extract<RuntimeEvent, { type: "tool_execution_end" }>
  ): AgUiEvent[] {
    const toolCallId = event.toolCallId;
    if (!toolCallId) return [];
    return [
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${this.runId}:result:${this.resultOrdinal++}`,
        toolCallId,
        content: stringifyToolValue(event.result),
        role: "tool",
      },
    ];
  }

  private handleCompactionStart(
    event: Extract<RuntimeEvent, { type: "compaction_start" }>
  ): AgUiEvent[] {
    return [
      ...this.closeOpenMessages(),
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: this.compactionActivityId,
        activityType: "compaction",
        replace: true,
        content: {
          status: "running",
          reason: event.reason || null,
        },
      },
    ];
  }

  private handleCompactionEnd(
    event: Extract<RuntimeEvent, { type: "compaction_end" }>
  ): AgUiEvent[] {
    const result = event.result;
    const summary = result?.summary ?? "";
    const errorMessage = event.errorMessage ?? "";
    const aborted = event.aborted === true;
    const status = aborted
      ? "aborted"
      : errorMessage
        ? "error"
        : summary
          ? "complete"
          : "skipped";
    return [
      ...this.closeOpenMessages(),
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: this.compactionActivityId,
        activityType: "compaction",
        replace: true,
        content: {
          status,
          reason: event.reason || null,
          willRetry: event.willRetry === true,
          errorMessage: errorMessage || null,
          tokensBefore: result ? numberField(result, "tokensBefore") : null,
        },
      },
    ];
  }

  private handleAgentEnd(): AgUiEvent[] {
    return this.closeOpenMessages();
  }

  private handleSessionSettled(session: SessionLike): AgUiEvent[] {
    const events: AgUiEvent[] = [...this.closeOpenMessages()];
    this.terminal = true;
    if (session.error && !session.abortRequested) {
      events.push({ type: EventType.RUN_ERROR, message: session.error });
      return events;
    }
    events.push({
      type: EventType.RUN_FINISHED,
      threadId: this.threadId,
      runId: this.runId,
    });
    return events;
  }

  private handleAgUiEvent(
    event: Extract<RuntimeEvent, { type: "ag_ui" }>
  ): AgUiEvent[] {
    if (
      event.event.type === EventType.RUN_FINISHED ||
      event.event.type === EventType.RUN_ERROR
    ) {
      this.terminal = true;
    }
    return [...this.closeOpenMessages(), event.event];
  }

  private handleAgentError(
    event: Extract<RuntimeEvent, { type: "agent_error" }>,
    session: SessionLike
  ): AgUiEvent[] {
    const events: AgUiEvent[] = [...this.closeOpenMessages()];
    this.terminal = true;
    const message =
      event.errorMessage ?? session.error ?? "Agent prompt failed";
    events.push({ type: EventType.RUN_ERROR, message });
    return events;
  }

  private closeOpenMessages(): AgUiEvent[] {
    return [
      ...this.closeReasoning(),
      ...this.closeText(),
      ...this.closeOpenToolCalls(),
    ];
  }

  private closeOpenToolCalls(): AgUiEvent[] {
    return Array.from(this.streamedToolCallsById.entries()).flatMap(
      ([toolCallId, state]) => {
        if (state.ended) return [];
        state.ended = true;
        return [{ type: EventType.TOOL_CALL_END, toolCallId }];
      }
    );
  }

  private closeText(): AgUiEvent[] {
    if (!this.openTextId) return [];
    const messageId = this.openTextId;
    this.openTextId = null;
    return [{ type: EventType.TEXT_MESSAGE_END, messageId }];
  }

  private closeReasoning(): AgUiEvent[] {
    if (!this.openReasoningId) return [];
    const messageId = this.openReasoningId;
    this.openReasoningId = null;
    return [
      { type: EventType.REASONING_MESSAGE_END, messageId },
      { type: EventType.REASONING_END, messageId },
    ];
  }

  private nextMessageId(kind: "text" | "reasoning"): string {
    return `${this.runId}:${kind}:${this.segmentOrdinal++}`;
  }
}
