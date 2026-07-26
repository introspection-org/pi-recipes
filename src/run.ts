import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { promptResultText } from "./child-agent.js";
import {
  createAgentSessionFromRecipe,
  type CreateAgentSessionFromRecipeOptions,
} from "./session.js";

/**
 * One turn, no server: create session → single prompt → await settle →
 * dispose, always. The programmatic analog of `pi --mode json -p`.
 *
 * Agent-level failure never throws — it lands in `status: "failed"`. Only
 * caller mistakes (bad options, unreadable recipe, missing credentials)
 * throw, from session construction.
 */
export interface RunRecipeOptions extends CreateAgentSessionFromRecipeOptions {
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Session factory; defaults to `createAgentSessionFromRecipe`. Test/DI seam. */
  sessionFactory?: (
    options: CreateAgentSessionFromRecipeOptions
  ) => Promise<import("./session.js").RecipeSessionHandle>;
}

export interface RunRecipeResult {
  status: "finished" | "failed" | "cancelled";
  /** Final assistant message text ("" if none). */
  text: string;
  /** Full transcript, Pi's message shape. */
  messages: AgentMessage[];
  /** Present iff status === "failed". */
  error?: string;
}

function lastAssistantStop(messages: readonly AgentMessage[]): {
  stopReason?: string;
  errorMessage?: string;
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as unknown as Record<string, unknown>;
    if (message?.role !== "assistant") continue;
    return {
      ...(typeof message.stopReason === "string"
        ? { stopReason: message.stopReason }
        : {}),
      ...(typeof message.errorMessage === "string"
        ? { errorMessage: message.errorMessage }
        : {}),
    };
  }
  return {};
}

export async function runRecipe(
  options: RunRecipeOptions
): Promise<RunRecipeResult> {
  const { prompt, timeoutMs, signal, sessionFactory, ...sessionOptions } =
    options;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new TypeError("runRecipe requires a non-empty prompt");
  }
  if (signal?.aborted) {
    return { status: "cancelled", text: "", messages: [] };
  }

  const handle = await (sessionFactory ?? createAgentSessionFromRecipe)(sessionOptions);
  let timedOut = false;
  let aborted = false;
  let timer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    aborted = true;
    void handle.session.abort().catch(() => {});
  };

  try {
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        void handle.session.abort().catch(() => {});
      }, timeoutMs);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    // The signal may have fired while the asynchronous session factory was
    // resolving, before the listener existed.
    if (signal?.aborted) {
      aborted = true;
      await handle.session.abort().catch(() => {});
      return {
        status: "cancelled",
        text: "",
        messages: [...handle.session.messages],
      };
    }

    let promptError: string | undefined;
    try {
      await handle.session.prompt(prompt);
    } catch (err) {
      promptError = err instanceof Error ? err.message : String(err);
    }

    const messages = [...handle.session.messages];
    const text = promptResultText({ messages });
    const { stopReason, errorMessage } = lastAssistantStop(messages);

    if (timedOut || aborted || stopReason === "aborted") {
      return { status: "cancelled", text, messages };
    }
    if (promptError !== undefined || stopReason === "error") {
      return {
        status: "failed",
        text,
        messages,
        error: promptError ?? errorMessage ?? "agent error",
      };
    }
    return { status: "finished", text, messages };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    await handle.dispose();
  }
}
