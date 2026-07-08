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
 *      user response." result carrying a `details.interrupt` pause
 *      descriptor; the host pauses the run and later resumes it by rewriting
 *      this tool result with the user's response envelope.
 *   4. Otherwise — report that interaction is unavailable so the model asks
 *      in its plain chat reply instead. An unrendered question is never
 *      treated as declined.
 *
 * The response envelopes are a frozen wire contract shared with interrupt-
 * capable hosts (see `docs/interactions.md`): both sides must synthesize
 * byte-identical text for the same outcome so recipes cannot tell whether an
 * answer arrived through a local dialog or a remote resume.
 *
 * A `details.interrupt` with `outcome.type === "awaiting_user"` is the pause
 * signal. Runtime hosts may adapt it to their own pause/resume state.
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
/** Well-known `reason` for a decision bound to a specific tool call. */
export const ELICIT_REASON_TOOL_CALL = "tool_call";

/**
 * Default dialog timeout applied in RPC mode only. RPC clients may never
 * render a dialog, so an unanswered one must not wedge the session; the TUI
 * gets no default timeout (a visible dialog can wait for the user).
 */
export const DEFAULT_RPC_DIALOG_TIMEOUT_MS = 120_000;

const APPROVE_OPTION = "Approve";
const REQUEST_CHANGES_OPTION = "Request changes";
const CUSTOM_ANSWER_OPTION = "Other";

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

/** Optional structured rendering hints for hosts with richer UI. */
export interface ElicitDisplay {
  /** Renderer kind, e.g. `search_proposal`. */
  kind: string;
  /** Short title for local dialogs and rich cards. */
  title?: string;
  /** Main body copy. Plain text or markdown-style text. */
  body?: string;
  /** Optional grouped content for clients that render rows or sections. */
  sections?: Array<{
    title: string;
    body?: string;
    items?: string[];
  }>;
}

/** A selectable answer option. `value` is what the tool receives. */
export interface ElicitOption {
  label: string;
  value?: string;
  description?: string;
}

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
  /** Optional choices for a question. Hosts may also allow a custom answer. */
  options?: readonly (string | ElicitOption)[];
  /**
   * Native renderer or tool hints for hosts that can render richer UI.
   */
  metadata?: Record<string, unknown>;
  /**
   * Structured display copy. Local pi dialogs format this for readability;
   * remote hosts can adapt it into their own UI.
   */
  display?: ElicitDisplay;
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

/** How the interaction settled. */
export type ElicitOutcome =
  | { type: "answered"; answer: string }
  | { type: "approved"; feedback?: string }
  | { type: "revision_requested"; feedback?: string }
  | { type: "declined" }
  /** Interrupt emitted — the host pauses the run and rewrites this result. */
  | { type: "awaiting_user" }
  /** No interaction channel — the model should ask in plain chat. */
  | { type: "unavailable" };

/** The pi-recipes interrupt request stored in Pi's arbitrary details field. */
export interface ElicitInterrupt {
  reason: string;
  message: string;
  options?: ElicitOption[];
  metadata?: Record<string, unknown>;
  display?: ElicitDisplay;
  expiresAt?: string;
  outcome: ElicitOutcome;
}

/** Structured details attached to every elicit tool result. */
export interface ElicitDetails {
  interrupt: ElicitInterrupt;
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
      isApprovalReason(request.reason)
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

function isApprovalReason(reason: string): boolean {
  return (
    reason === ELICIT_REASON_CONFIRMATION || reason === ELICIT_REASON_TOOL_CALL
  );
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
  if (isApprovalReason(request.reason)) {
    // ui.confirm() cannot carry per-option labels, so approvals use a select.
    const choice = await ui.select(
      localDialogMessage(request),
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
    const options = normalizeOptions(request.options);
    const selectOptions = [...options.map((option) => option.label)];
    if (!selectOptions.includes(CUSTOM_ANSWER_OPTION)) {
      selectOptions.push(CUSTOM_ANSWER_OPTION);
    }
    const choice = await ui.select(
      localDialogMessage(request),
      selectOptions,
      dialog
    );
    throwIfAborted(signal);
    if (choice === undefined) return { type: "declined" };
    if (choice === CUSTOM_ANSWER_OPTION) {
      const text = await ui.input(
        "Answer",
        "Type your own answer",
        dialog
      );
      throwIfAborted(signal);
      const trimmed = text?.trim();
      return trimmed
        ? { type: "answered", answer: trimmed }
        : { type: "declined" };
    }
    const selected = options.find((option) => option.label === choice);
    return {
      type: "answered",
      answer: selected?.value?.trim() || selected?.label || choice,
    };
  }

  const text = await ui.input(localDialogMessage(request), undefined, dialog);
  throwIfAborted(signal);
  const trimmed = text?.trim();
  return trimmed
    ? { type: "answered", answer: trimmed }
    : { type: "declined" };
}

function localDialogMessage(request: ElicitRequest): string {
  const display = request.display;
  if (!display) return request.message;

  const lines: string[] = [];
  const title = display.title?.trim();
  if (title) {
    lines.push(title);
  } else {
    lines.push(request.message);
  }

  const body = display.body?.trim();
  if (body) {
    lines.push("", body);
  }

  for (const section of display.sections ?? []) {
    const sectionTitle = section.title.trim();
    const sectionBody = section.body?.trim();
    const items = section.items?.map((item) => item.trim()).filter(Boolean) ?? [];

    if (!sectionTitle && !sectionBody && items.length === 0) continue;
    lines.push("");
    if (sectionTitle) lines.push(`${sectionTitle}:`);
    if (sectionBody) lines.push(sectionBody);
    for (const item of items) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join("\n");
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

function normalizeOptions(
  options: readonly (string | ElicitOption)[] | undefined
): ElicitOption[] {
  return (options ?? []).flatMap((option) => {
    if (typeof option === "string") {
      const label = option.trim();
      return label ? [{ label }] : [];
    }
    const label = option.label.trim();
    if (!label) return [];
    const value = option.value?.trim();
    const description = option.description?.trim();
    return [
      {
        label,
        ...(value ? { value } : {}),
        ...(description ? { description } : {}),
      },
    ];
  });
}

function interruptDetails(
  request: ElicitRequest,
  outcome: ElicitOutcome
): ElicitDetails {
  const options = normalizeOptions(request.options);
  return {
    interrupt: {
      reason: request.reason,
      message: request.message,
      ...(options.length > 0 ? { options } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
      ...(request.display ? { display: request.display } : {}),
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
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
    details: interruptDetails(request, outcome),
  };
}

function awaitingUserResult(
  request: ElicitRequest,
  _toolCallId: string
): ElicitResult {
  const outcome: ElicitOutcome = { type: "awaiting_user" };
  return {
    outcome,
    content: [{ type: "text", text: envelopeText(outcome) }],
    details: interruptDetails(request, outcome),
  };
}
