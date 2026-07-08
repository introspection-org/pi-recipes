/**
 * Interaction mechanics for recipe tools: ask the user a question or request
 * approval with one contract that works on every pi host.
 *
 * This module registers no tools. Recipes own their interaction tools and call
 * `elicit()` from the tool's `execute()`; the module resolves the best
 * available interaction channel and always returns a finished tool result:
 *
 *   1. `PI_ELICIT_AUTO_APPROVE` — headless/CI: confirmations approve,
 *      questions decline. Deterministic, never blocks.
 *   2. `ctx.hasUI` (TUI and RPC modes) — walk the built-in dialogs, or the
 *      caller's `interactive` override.
 *   3. `PI_INTERRUPT_RESUME` (host capability flag) — return an "Awaiting
 *      user response." result carrying a `details.interrupt` descriptor; the
 *      host pauses the run and later resumes it by rewriting this tool result
 *      with the user's response envelope.
 *   4. Otherwise — report that interaction is unavailable so the model asks
 *      in its plain chat reply instead. An unrendered question is never
 *      treated as declined.
 *
 * The response envelopes are a frozen wire contract shared with interrupt-
 * capable hosts (see `docs/interactions.md`): both sides must synthesize
 * byte-identical text for the same outcome so recipes cannot tell whether an
 * answer arrived through a local dialog or a remote resume.
 *
 * `details.interrupt` is a reserved key on tool results: any tool result
 * carrying it signals an interrupt-capable host to pause the run.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ExtensionContext,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";

/** Well-known `reason` for a question the model needs answered. */
export const ELICIT_REASON_INPUT_REQUIRED = "input_required";
/** Well-known `reason` for an approve/request-changes decision. */
export const ELICIT_REASON_CONFIRMATION = "confirmation";

/**
 * Default dialog timeout applied in RPC mode only. RPC clients may never
 * render a dialog, so an unanswered one must not wedge the session; the TUI
 * gets no default timeout (a visible dialog can wait for the user).
 */
export const DEFAULT_RPC_DIALOG_TIMEOUT_MS = 120_000;

const APPROVE_OPTION = "Approve";
const REQUEST_CHANGES_OPTION = "Request changes";

// Frozen envelope literals — the interaction wire contract. Interrupt-capable
// hosts synthesize the same literals when resuming a paused run, so recipes
// see identical tool results in every mode. Do not reword without a
// coordinated protocol change (see docs/interactions.md).
const DECLINED_ENVELOPE =
  "User declined to answer. Proceed with your best judgment.";
const AWAITING_USER_ENVELOPE = "Awaiting user response.";
const UNAVAILABLE_ENVELOPE =
  "User interaction is unavailable in this session; nothing was shown to the user. " +
  "Ask the user in your normal assistant reply instead, and continue after they respond.";

/** What the recipe tool wants from the user. */
export interface ElicitRequest {
  /**
   * Why the run needs the user. Open string; well-known values are
   * `input_required` (a question) and `confirmation` (approve / request
   * changes). Unknown reasons follow the question flow.
   */
  reason: string;
  /** The human-readable prompt shown to the user. */
  message: string;
  /** Optional fixed choices for a question (rendered as a select / buttons). */
  options?: readonly string[];
  /**
   * Renderer hints forwarded to hosts on the interrupt descriptor (e.g.
   * `kind` for a custom web renderer, `header` for the TUI row). Hosts fall
   * back to a generic rendering when they recognize none of them.
   */
  metadata?: Record<string, unknown>;
  /** Optional ISO-8601 instant after which a host may auto-decline. */
  expiresAt?: string;
}

/** Per-call plumbing from the owning tool's `execute()`. */
export interface ElicitOptions {
  /** The executing tool call id (first `execute()` argument). */
  toolCallId: string;
  /** The extension context (last `execute()` argument). */
  ctx: ExtensionContext;
  /**
   * The tool's own abort signal (third `execute()` argument) — NOT
   * `ctx.signal`, which may already be undefined while the tool settles.
   * Threaded into every dialog so an aborted turn dismisses them.
   */
  signal: AbortSignal | undefined;
  /**
   * Optional custom interactive walk replacing the built-in dialogs (a pure
   * TUI/RPC enhancement — the contract is unchanged). Return an outcome, or
   * undefined to fall through to the built-in walk.
   */
  interactive?: (
    ui: ExtensionUIContext,
    dialog: ExtensionUIDialogOptions
  ) => Promise<ElicitOutcome | undefined>;
  /** Dialog timeout override in milliseconds (defaults: TUI none, RPC 120s). */
  timeoutMs?: number;
  /** Environment override for tests. */
  env?: NodeJS.ProcessEnv;
}

/** How the elicitation settled. */
export type ElicitOutcome =
  | { type: "answered"; answer: string }
  | { type: "approved"; feedback?: string }
  | { type: "revision_requested"; feedback?: string }
  | { type: "declined" }
  /** Interrupt emitted — the host pauses the run and rewrites this result. */
  | { type: "awaiting_user" }
  /** No interaction channel — the model should ask in plain chat. */
  | { type: "unavailable" };

/**
 * The pause descriptor placed on `details.interrupt`. An exact subset of the
 * AG-UI `InterruptSchema` (`@ag-ui/core`), kept dependency-free here.
 */
export interface InterruptDescriptor {
  id: string;
  reason: string;
  message: string;
  toolCallId: string;
  /**
   * Flat single-object response schema (the MCP elicitation form subset:
   * primitive properties, titled enums) describing the expected resume
   * payload.
   */
  responseSchema: Record<string, unknown>;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

/** Structured details attached to every elicit tool result. */
export interface ElicitDetails {
  elicitation: {
    reason: string;
    message: string;
    options?: string[];
    outcome: ElicitOutcome;
  };
  /** Present only for `awaiting_user` — reserved pause signal for hosts. */
  interrupt?: InterruptDescriptor;
}

/**
 * A finished tool result: return it (or spread it) from the owning tool's
 * `execute()`. The envelope text in `content` is what the model sees.
 */
export interface ElicitResult {
  outcome: ElicitOutcome;
  content: Array<{ type: "text"; text: string }>;
  details: ElicitDetails;
}

const interruptResumeSuppression = new AsyncLocalStorage<boolean>();

/**
 * Run `fn` with the interrupt branch of `elicit()` suppressed.
 *
 * Used by the in-process child agent runner: an interrupt-capable host only
 * observes the root session's tool results, so an interrupt emitted from a
 * child session would never pause anything and the child would stall on
 * "Awaiting user response." forever. Inside this scope `elicit()` skips
 * straight to the plain-chat fallback.
 */
export function suppressInterruptResume<T>(fn: () => Promise<T>): Promise<T> {
  return interruptResumeSuppression.run(true, fn);
}

/** Ask the user, resolving the best available interaction channel. */
export async function elicit(
  request: ElicitRequest,
  opts: ElicitOptions
): Promise<ElicitResult> {
  const env = opts.env ?? process.env;

  if (flagEnabled(env.PI_ELICIT_AUTO_APPROVE)) {
    return finishedResult(
      request,
      request.reason === ELICIT_REASON_CONFIRMATION
        ? { type: "approved" }
        : { type: "declined" }
    );
  }

  if (opts.ctx.hasUI) {
    const timeout =
      opts.timeoutMs ??
      (opts.ctx.mode === "rpc" ? DEFAULT_RPC_DIALOG_TIMEOUT_MS : undefined);
    const dialog: ExtensionUIDialogOptions = {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
    const custom = opts.interactive
      ? await opts.interactive(opts.ctx.ui, dialog)
      : undefined;
    throwIfAborted(opts.signal);
    const outcome =
      custom ?? (await dialogWalk(request, opts.ctx.ui, dialog, opts.signal));
    return finishedResult(request, outcome);
  }

  if (
    flagEnabled(env.PI_INTERRUPT_RESUME) &&
    interruptResumeSuppression.getStore() !== true
  ) {
    return awaitingUserResult(request, opts.toolCallId);
  }

  return finishedResult(request, { type: "unavailable" });
}

function flagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  // Dialogs resolve undefined for both a user dismissal and a turn abort;
  // only the signal distinguishes them. A dismissal is a decline, an abort
  // must not fabricate an outcome.
  if (signal?.aborted) {
    throw new Error("User interaction aborted");
  }
}

/**
 * Built-in dialog walk. Deliberately minimal: a select for fixed choices or
 * approvals, a text input otherwise. Empty and dismissed answers decline —
 * the user saw the question and chose not to answer it.
 */
async function dialogWalk(
  request: ElicitRequest,
  ui: ExtensionUIContext,
  dialog: ExtensionUIDialogOptions,
  signal: AbortSignal | undefined
): Promise<ElicitOutcome> {
  if (request.reason === ELICIT_REASON_CONFIRMATION) {
    // ui.confirm() cannot carry per-option labels, so approvals use a select.
    const choice = await ui.select(
      request.message,
      [APPROVE_OPTION, REQUEST_CHANGES_OPTION],
      dialog
    );
    throwIfAborted(signal);
    if (choice === undefined) return { type: "declined" };
    if (choice === APPROVE_OPTION) return { type: "approved" };
    const feedback = await ui.input(
      "Feedback",
      "Describe the changes you want (optional)",
      dialog
    );
    throwIfAborted(signal);
    const trimmed = feedback?.trim();
    return trimmed
      ? { type: "revision_requested", feedback: trimmed }
      : { type: "revision_requested" };
  }

  if (request.options && request.options.length > 0) {
    const choice = await ui.select(request.message, [...request.options], dialog);
    throwIfAborted(signal);
    return choice === undefined
      ? { type: "declined" }
      : { type: "answered", answer: choice };
  }

  const text = await ui.input(request.message, undefined, dialog);
  throwIfAborted(signal);
  const trimmed = text?.trim();
  return trimmed
    ? { type: "answered", answer: trimmed }
    : { type: "declined" };
}

function envelopeText(outcome: ElicitOutcome): string {
  switch (outcome.type) {
    case "answered":
      return `Answer: ${outcome.answer}`;
    case "approved":
      return outcome.feedback
        ? `Approved. Feedback: ${outcome.feedback}`
        : "Approved.";
    case "revision_requested":
      return outcome.feedback
        ? `Revision requested. Feedback: ${outcome.feedback}`
        : "Revision requested.";
    case "declined":
      return DECLINED_ENVELOPE;
    case "awaiting_user":
      return AWAITING_USER_ENVELOPE;
    case "unavailable":
      return UNAVAILABLE_ENVELOPE;
  }
}

function elicitationDetails(
  request: ElicitRequest,
  outcome: ElicitOutcome
): ElicitDetails {
  return {
    elicitation: {
      reason: request.reason,
      message: request.message,
      ...(request.options && request.options.length > 0
        ? { options: [...request.options] }
        : {}),
      outcome,
    },
  };
}

function finishedResult(
  request: ElicitRequest,
  outcome: ElicitOutcome
): ElicitResult {
  return {
    outcome,
    content: [{ type: "text", text: envelopeText(outcome) }],
    details: elicitationDetails(request, outcome),
  };
}

function responseSchemaFor(request: ElicitRequest): Record<string, unknown> {
  if (request.reason === ELICIT_REASON_CONFIRMATION) {
    return {
      type: "object",
      properties: {
        approved: { type: "boolean", title: "Approve" },
        feedback: { type: "string", title: "Feedback" },
      },
      required: ["approved"],
    };
  }
  return {
    type: "object",
    properties: {
      answer: {
        type: "string",
        title: "Answer",
        ...(request.options && request.options.length > 0
          ? { enum: [...request.options] }
          : {}),
      },
    },
    required: ["answer"],
  };
}

function awaitingUserResult(
  request: ElicitRequest,
  toolCallId: string
): ElicitResult {
  const outcome: ElicitOutcome = { type: "awaiting_user" };
  const kind =
    typeof request.metadata?.kind === "string" && request.metadata.kind
      ? request.metadata.kind
      : request.reason;
  const interrupt: InterruptDescriptor = {
    id: `${kind}:${toolCallId}`,
    reason: request.reason,
    message: request.message,
    toolCallId,
    responseSchema: responseSchemaFor(request),
    ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    // `question`/`options` let a host reconstruct the originating tool call
    // after a restart; caller metadata rides along as renderer hints.
    metadata: {
      ...(request.metadata ?? {}),
      question: request.message,
      ...(request.options && request.options.length > 0
        ? { options: [...request.options] }
        : {}),
    },
  };
  return {
    outcome,
    content: [{ type: "text", text: envelopeText(outcome) }],
    details: { ...elicitationDetails(request, outcome), interrupt },
  };
}
