/**
 * Provider-neutral channel primitives.
 *
 * A channel-origin task answers exactly one conversation. These types describe
 * what an agent may do *inside* that conversation, in vocabulary that is the
 * same for Slack, Teams, or anything else, so one prompt serves every channel.
 *
 * Two properties are structural rather than documented:
 *
 * - **The destination is bound.** An adapter method takes the conversation from
 *   the trusted `ChannelTarget` the host resolved; no tool schema built from
 *   these types carries a channel, thread, workspace, or user argument.
 * - **Unsupported is absent.** Tools are registered from `ChannelCapabilities`,
 *   so a channel that cannot edit simply has no edit tool. A tool that always
 *   answers "unsupported" costs a model turn and teaches nothing.
 *
 * Workspace-wide operations (search, cross-conversation sends, directory
 * lookups) are deliberately *not* here. They do not correspond across
 * providers, so a neutral name buys nothing, and they need a broader grant. A
 * Recipe that needs them declares a provider's hosted MCP server instead.
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
  readonly history: false | "thread" | "channel";
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

/** An opaque pagination token. Same reasoning as `MessageRef`. */
export type ChannelCursor = string;

export interface ChannelAuthor {
  readonly id: string;
  readonly display_name?: string;
  readonly is_agent?: boolean;
}

export interface ChannelAttachment {
  readonly id: string;
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

export interface ChannelHistoryPage {
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
}

export interface ChannelAdapterContext {
  readonly target: ChannelTarget;
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

  /** The bound conversation, for a model that needs to name it in prose. */
  info(ctx: ChannelAdapterContext): Promise<ChannelTarget>;
  reply(
    ctx: ChannelAdapterContext,
    input: { text: string },
  ): Promise<ChannelPostResult>;

  react?(
    ctx: ChannelAdapterContext,
    input: { ref: MessageRef; emoji: string },
  ): Promise<void>;
  edit?(
    ctx: ChannelAdapterContext,
    input: { ref: MessageRef; text: string },
  ): Promise<ChannelPostResult>;
  retract?(
    ctx: ChannelAdapterContext,
    input: { ref: MessageRef },
  ): Promise<void>;
  history?(
    ctx: ChannelAdapterContext,
    input: { limit?: number; cursor?: string },
  ): Promise<ChannelHistoryPage>;
  attach?(
    ctx: ChannelAdapterContext,
    input: { path: string; title?: string; comment?: string },
  ): Promise<ChannelPostResult>;
  fetchFile?(
    ctx: ChannelAdapterContext,
    input: { file: string; variant?: string },
  ): Promise<ChannelLocalFile>;
  postDocument?(
    ctx: ChannelAdapterContext,
    input: { title: string; markdown: string },
  ): Promise<ChannelPostResult>;
}
