import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { ChannelRefStore } from "./refs.js";
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelCapabilities,
  ChannelTarget,
} from "./types.js";

/**
 * The neutral operation vocabulary.
 *
 * These ids are what a Recipe writes in `package.json#pi.connectors[].tools.include`;
 * the registered Pi tool name is `channel_<id>`. The same id means the same
 * thing on every provider, which is the whole point: one prompt, one tool
 * allowlist, any channel.
 */
export const CHANNEL_TOOL_IDS = [
  "info",
  "reply",
  "history",
  "react",
  "edit",
  "retract",
  "attach",
  "fetch_file",
  "post_document",
] as const;

export type ChannelToolId = (typeof CHANNEL_TOOL_IDS)[number];

/** Active without a search. The rest are reachable through `tool_search`. */
const DEFAULT_ACTIVE: readonly ChannelToolId[] = ["info", "reply", "history"];

export function channelToolName(id: ChannelToolId): string {
  return `channel_${id}`;
}

/** Which operations an adapter's capabilities actually support. */
export function channelToolIdsFor(
  capabilities: ChannelCapabilities,
): ChannelToolId[] {
  const supported: ChannelToolId[] = ["info", "reply"];
  if (capabilities.history !== false) supported.push("history");
  if (capabilities.react) supported.push("react");
  if (capabilities.edit) supported.push("edit");
  if (capabilities.retract) supported.push("retract");
  if (capabilities.attach) supported.push("attach");
  if (capabilities.fetchFile) supported.push("fetch_file");
  if (capabilities.documents !== false) supported.push("post_document");
  return supported;
}

export function channelConnectorTools(capabilities: ChannelCapabilities) {
  const active = new Set<string>(DEFAULT_ACTIVE);
  return channelToolIdsFor(capabilities).map((id) => ({
    id,
    name: channelToolName(id),
    defaultActive: active.has(id),
  }));
}

/**
 * A capability an adapter declares but did not implement is a promise the
 * agent would discover by failing a call. Caught at registration instead.
 */
function assertImplemented(adapter: ChannelAdapter): void {
  const missing = channelToolIdsFor(adapter.capabilities).filter((id) => {
    switch (id) {
      case "info":
        return typeof adapter.info !== "function";
      case "reply":
        return typeof adapter.reply !== "function";
      case "history":
        return typeof adapter.history !== "function";
      case "react":
        return typeof adapter.react !== "function";
      case "edit":
        return typeof adapter.edit !== "function";
      case "retract":
        return typeof adapter.retract !== "function";
      case "attach":
        return typeof adapter.attach !== "function";
      case "fetch_file":
        return typeof adapter.fetchFile !== "function";
      case "post_document":
        return typeof adapter.postDocument !== "function";
    }
  });
  if (missing.length > 0) {
    throw new Error(
      `Channel adapter '${adapter.provider}' declares capabilities it does not implement: ${missing.join(", ")}`,
    );
  }
}

export interface RegisterChannelToolsOptions {
  /**
   * The bound conversation, or a thunk resolving it.
   *
   * Resolved by the host, never from model input. A thunk defers the "this
   * task has no channel origin" failure to the first tool call, so a Recipe
   * that declares a channel connector still starts when the same Recipe is
   * run from a non-channel trigger such as an automation.
   */
  target: ChannelTarget | (() => ChannelTarget);
  /** Restrict registration to these ids; defaults to everything supported. */
  tools?: readonly ChannelToolId[];
  refs?: ChannelRefStore;
}

/** Host surface used here. Opaque so Pi's TypeBox copy stays behind this seam. */
export interface ChannelToolHost {
  registerTool(...args: never[]): unknown;
}

function toolResult(details: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(details, null, 2) },
    ],
    details,
  };
}

/**
 * Register the bound channel tools an adapter supports.
 *
 * Two invariants are enforced by construction rather than by review:
 *
 * 1. **No schema below carries a conversation, thread, workspace, or user
 *    argument.** The conversation comes from `options.target`, closed over
 *    here. A model that cannot name a destination cannot reach one, so an
 *    agent bound to a thread stays bound to that thread even if the underlying
 *    credential could reach the whole workspace.
 * 2. **Unsupported operations are absent**, not stubs that answer "this
 *    channel cannot do that" — such a stub costs a turn every time and teaches
 *    the model nothing durable.
 */
export function registerChannelTools(
  pi: ChannelToolHost,
  adapter: ChannelAdapter,
  options: RegisterChannelToolsOptions,
): void {
  assertImplemented(adapter);
  const host = pi as unknown as ExtensionAPI;
  const refs = options.refs ?? new ChannelRefStore();
  const supported = new Set(channelToolIdsFor(adapter.capabilities));
  const selected = new Set(options.tools ?? [...supported]);
  const resolveTarget =
    typeof options.target === "function" ? options.target : () => options.target as ChannelTarget;
  const context = (signal?: AbortSignal): ChannelAdapterContext => ({
    target: resolveTarget(),
    refs,
    signal,
  });
  const definitions = new Map<ChannelToolId, Record<string, unknown>>();
  const register = (
    id: ChannelToolId,
    define: () => Record<string, unknown>,
  ) => {
    if (supported.has(id) && selected.has(id)) definitions.set(id, define());
  };

  register("info", () => ({
    name: channelToolName("info"),
    label: "Channel info",
    description:
      "Describe the conversation this task answers: provider, conversation name, and whether it is threaded. Every other channel tool already acts on this conversation, so its identifiers are not needed and cannot be supplied.",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId: string, _params: unknown, signal?: AbortSignal) {
      const target = await adapter.info(context(signal));
      return toolResult({
        provider: target.provider,
        name: target.name ?? null,
        threaded: Boolean(target.thread),
      });
    },
  }));

  register("reply", () => ({
    name: channelToolName("reply"),
    label: "Reply in channel",
    description:
      "Post a message to the conversation this task answers. Text is Markdown and is rendered in the channel's native format. Replies land in the origin thread when there is one.",
    parameters: Type.Object(
      { text: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: { text: string },
      signal?: AbortSignal,
    ) {
      return toolResult(await adapter.reply(context(signal), params));
    },
  }));

  register("history", () => ({
    name: channelToolName("history"),
    label: "Read channel history",
    description:
      adapter.capabilities.history === "thread"
        ? "Read earlier messages in this conversation's thread, most recent last."
        : "Read earlier messages in this conversation, most recent last.",
    parameters: Type.Object(
      {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        cursor: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: { limit?: number; cursor?: string },
      signal?: AbortSignal,
    ) {
      const cursor = params.cursor
        ? refs.resolveCursor(params.cursor)
        : undefined;
      return toolResult(
        await adapter.history!(context(signal), {
          limit: params.limit,
          cursor,
        }),
      );
    },
  }));

  register("react", () => ({
    name: channelToolName("react"),
    label: "React to a message",
    description:
      "Add an emoji reaction to a message in this conversation, named by a reference a channel tool returned.",
    parameters: Type.Object(
      {
        message: Type.String({ minLength: 1 }),
        emoji: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: { message: string; emoji: string },
      signal?: AbortSignal,
    ) {
      await adapter.react!(context(signal), {
        ref: params.message,
        emoji: params.emoji,
      });
      return toolResult({ reacted: true });
    },
  }));

  register("edit", () => ({
    name: channelToolName("edit"),
    label: "Edit a message",
    description:
      "Replace the text of a message this agent posted. Messages from other authors cannot be edited.",
    parameters: Type.Object(
      {
        message: Type.String({ minLength: 1 }),
        text: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: { message: string; text: string },
      signal?: AbortSignal,
    ) {
      return toolResult(
        await adapter.edit!(context(signal), {
          ref: params.message,
          text: params.text,
        }),
      );
    },
  }));

  register("retract", () => ({
    name: channelToolName("retract"),
    label: "Retract a message",
    description:
      "Delete a message this agent posted. Messages from other authors cannot be retracted.",
    parameters: Type.Object(
      { message: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: { message: string },
      signal?: AbortSignal,
    ) {
      await adapter.retract!(context(signal), { ref: params.message });
      return toolResult({ retracted: true });
    },
  }));

  register("attach", () => ({
    name: channelToolName("attach"),
    label: "Attach a file",
    description:
      "Upload a file from the task workspace into this conversation.",
    parameters: Type.Object(
      {
        path: Type.String({ minLength: 1 }),
        title: Type.Optional(Type.String()),
        comment: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: { path: string; title?: string; comment?: string },
      signal?: AbortSignal,
    ) {
      return toolResult(await adapter.attach!(context(signal), params));
    },
  }));

  register("fetch_file", () => ({
    name: channelToolName("fetch_file"),
    label: "Fetch a channel file",
    description:
      "Download a file shared in this conversation into the task workspace and return its local path, size, and digest. Takes a file reference from a message returned by channel_history — a provider file id is not accepted. The bytes stay on disk; they are not read into this conversation.",
    parameters: Type.Object(
      {
        file: Type.String({ minLength: 1, maxLength: 200 }),
        variant: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: { file: string; variant?: string },
      signal?: AbortSignal,
    ) {
      return toolResult(await adapter.fetchFile!(context(signal), params));
    },
  }));

  register("post_document", () => ({
    name: channelToolName("post_document"),
    label: "Post a document",
    description:
      "Publish long-form Markdown to this conversation as a document rather than a message, for output that reads badly when split across chat messages.",
    parameters: Type.Object(
      {
        title: Type.String({ minLength: 1 }),
        markdown: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: { title: string; markdown: string },
      signal?: AbortSignal,
    ) {
      return toolResult(await adapter.postDocument!(context(signal), params));
    },
  }));

  // Built as definitions first, then registered, so the name is applied in
  // exactly one place and cannot drift per tool.
  for (const [id, definition] of definitions) {
    host.registerTool({ ...definition, name: channelToolName(id) } as never);
  }
}
