/**
 * Provider-neutral channel primitives.
 *
 * A channel-origin task answers exactly one conversation. For a task without
 * an inbound origin, a host may bind one fallback target for a proactive
 * top-level reply. These types describe those operations in vocabulary that is the
 * same for Slack, Teams, or anything else, so one prompt serves every channel.
 *
 * Two properties are structural rather than documented:
 *
 * - **Every destination is bound.** An adapter method takes the conversation from
 *   a trusted `ChannelTarget` the host resolved; no tool schema built from
 *   these types carries a channel, thread, workspace, or user argument.
 * - **Unsupported is absent.** Tools are registered from `ChannelCapabilities`,
 *   so a channel that cannot read earlier messages simply has no read tool. A
 *   tool that always answers "unsupported" costs a model turn and teaches
 *   nothing.
 *
 * Operations outside the bound inbound and proactive targets, including workspace search,
 * directory lookups, and arbitrary sends to another conversation, are unsupported. Their
 * contract and access model are deferred to a separate proposal.
 */

/** The conversation a task answers. Resolved by the host, never by the model. */
export interface ChannelTarget {
  readonly provider: string;
  /** Provider conversation id (Slack channel, Teams conversation). */
  readonly conversation: string;
  /** Thread root within the conversation, when the origin is threaded. */
  readonly thread?: string | null;
  /** Human-readable conversation name, when the provider supplies one. */
  readonly name?: string | null;
  /** Stable link to the conversation, when the provider can produce one. */
  readonly permalink?: string | null;
}

/**
 * What a channel can actually do.
 *
 * Declared as static data by the adapter, never probed at runtime: a capability
 * that has to be discovered by failing a call is a capability the agent has
 * already wasted a turn on.
 */
export interface ChannelCapabilities {
  readonly react: boolean;
  readonly edit: boolean;
  readonly retract: boolean;
  /** `false`, or the widest scope the provider will return. */
  readonly read: false | "thread" | "channel";
  readonly attach: boolean;
  readonly fetchFile: boolean;
  readonly documents: false | "native" | "attachment";
  /** Enrichment performed in trusted code, not exposed as lookup tools. */
  readonly resolveAuthors: boolean;
  readonly permalinks: boolean;
}

/**
 * An opaque handle for one message.
 *
 * Never a provider id. The model cannot mint one, so it cannot name a message
 * it has not seen, and a provider changing its id format never reaches a tool
 * schema. The store behind it also records whether the agent authored the
 * message, which is what bounds `edit` and `retract`.
 */
export type MessageRef = string;

/** Whether `channel_react` adds or removes the agent's reaction. */
export type ChannelReactionAction = "add" | "remove";

/** An opaque pagination token. Same reasoning as `MessageRef`. */
export type ChannelCursor = string;

/**
 * An opaque handle for one file seen in this conversation.
 *
 * Same reasoning as `MessageRef`, and for the same threat: a provider file id
 * is reachable across every conversation the bot belongs to, so accepting one
 * from the model would reintroduce the addressing argument the bound tier
 * exists to remove — just spelled `file` instead of `channel`.
 */
export type FileRef = string;

export interface ChannelAuthor {
  readonly id: string;
  readonly display_name?: string;
  readonly is_agent?: boolean;
}

export interface ChannelAttachment {
  /**
   * Opaque session handle, not the provider's file id.
   *
   * Minted when the file is seen in this conversation, and the only
   * thing `channel_fetch_file` accepts. A raw provider file id would be an
   * addressing argument in everything but name: a bot can usually read files
   * from every conversation it belongs to, so a model that could pass one
   * could reach a file this conversation never carried.
   */
  readonly id: FileRef;
  readonly name?: string;
  readonly mime_type?: string;
  readonly size?: number;
}

/** One message as the model sees it: opaque ref, resolved author, no provider ids. */
export interface ChannelMessage {
  readonly ref: MessageRef;
  readonly author: ChannelAuthor;
  readonly text: string;
  readonly timestamp?: string;
  readonly permalink?: string;
  readonly attachments?: readonly ChannelAttachment[];
}

export interface ChannelPostResult {
  readonly ref: MessageRef;
  readonly permalink?: string;
  /**
   * Whether the platform recorded the posted thread for reply bridging. False
   * with a reason is not a failure of the post — the message is out.
   */
  readonly bridge_recorded?: boolean;
  readonly bridge_error?: string;
}

export interface ChannelReadPage {
  readonly messages: readonly ChannelMessage[];
  readonly cursor?: ChannelCursor;
}

export interface ChannelLocalFile {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly mime_type: string;
  readonly size: number;
  readonly sha256: string;
}

/** Raw message identity an adapter hands to the ref store. Never model-facing. */
export interface ChannelMessageIdentity {
  readonly conversation: string;
  readonly id: string;
  readonly thread?: string | null;
  readonly authoredByAgent?: boolean;
  readonly permalink?: string;
}

/** The provider identity behind a `FileRef`, resolvable only in-session. */
export interface ChannelFileIdentity {
  readonly conversation: string;
  readonly id: string;
}

/**
 * Resolves opaque handles for one session.
 *
 * Passed to adapters so they mint refs for what they return and resolve refs
 * the model hands back — an adapter never invents its own handle format.
 */
export interface ChannelRefResolver {
  message(identity: ChannelMessageIdentity): MessageRef;
  resolveMessage(ref: MessageRef): ChannelMessageIdentity;
  /** Throws unless the agent authored the message. Guards edit and retract. */
  resolveAuthored(ref: MessageRef): ChannelMessageIdentity;
  cursor(providerCursor: string): ChannelCursor;
  resolveCursor(cursor: ChannelCursor): string;
  /** Mint a handle for a file seen in this conversation. */
  file(identity: ChannelFileIdentity): FileRef;
  /** Resolve a handle back to a provider file id. Guards fetch_file. */
  resolveFile(ref: FileRef): ChannelFileIdentity;
}

export interface ChannelAdapterContext {
  readonly target: ChannelTarget;
  /** True when reply fell back to the configured proactive target. */
  readonly proactive?: boolean;
  readonly refs: ChannelRefResolver;
  readonly signal?: AbortSignal;
}

/**
 * What a provider package implements.
 *
 * Every method takes the bound conversation from `ChannelAdapterContext`. An
 * optional method must be present exactly when the matching capability is
 * true — `channelConnectorTools` asserts that, so a capability cannot claim
 * something the adapter cannot do.
 */
export interface ChannelAdapter {
  readonly provider: string;
  readonly capabilities: ChannelCapabilities;

  /** Add provider metadata to the trusted target before it enters the prompt. */
  enrichTarget?(ctx: ChannelAdapterContext): Promise<ChannelTarget>;
  reply(
    ctx: ChannelAdapterContext,
    input: { text: string },
  ): Promise<ChannelPostResult>;

  react?(
    ctx: ChannelAdapterContext,
    input: {
      ref: MessageRef;
      emoji: string;
      action: ChannelReactionAction;
    },
  ): Promise<void>;
  edit?(
    ctx: ChannelAdapterContext,
    input: { ref: MessageRef; text: string },
  ): Promise<ChannelPostResult>;
  retract?(
    ctx: ChannelAdapterContext,
    input: { ref: MessageRef },
  ): Promise<void>;
  read?(
    ctx: ChannelAdapterContext,
    input: { limit?: number; cursor?: string },
  ): Promise<ChannelReadPage>;
  attach?(
    ctx: ChannelAdapterContext,
    input: { path: string; title?: string; comment?: string },
  ): Promise<ChannelPostResult>;
  fetchFile?(
    ctx: ChannelAdapterContext,
    input: { file: FileRef; variant?: string },
  ): Promise<ChannelLocalFile>;
  postDocument?(
    ctx: ChannelAdapterContext,
    input: { title: string; markdown: string },
  ): Promise<ChannelPostResult>;
}
