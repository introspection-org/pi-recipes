import { randomUUID } from "node:crypto";

import type {
  ChannelCursor,
  ChannelMessageIdentity,
  ChannelRefResolver,
  MessageRef,
} from "./types.js";

const MESSAGE_PREFIX = "msg_";
const CURSOR_PREFIX = "cur_";

function handle(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/**
 * Session-scoped opaque handles for messages and pagination cursors.
 *
 * The model only ever sees a handle this store minted, so it cannot name a
 * message it was never shown, and provider id formats stay out of tool schemas.
 * The store is also where authorship lives: `resolveAuthored` is the single
 * check behind `channel_edit` and `channel_retract`, which is what keeps those
 * primitives scoped to the agent's own messages rather than to everything the
 * bot credential could reach.
 *
 * Handles die with the session. A ref from an earlier task is unresolvable
 * rather than dangerous.
 */
export class ChannelRefStore implements ChannelRefResolver {
  private readonly messages = new Map<MessageRef, ChannelMessageIdentity>();
  private readonly byIdentity = new Map<string, MessageRef>();
  private readonly cursors = new Map<ChannelCursor, string>();

  message(identity: ChannelMessageIdentity): MessageRef {
    const key = `${identity.conversation} ${identity.id}`;
    const existing = this.byIdentity.get(key);
    if (existing) {
      // Re-minting would let one message answer to two handles, and a later
      // read (which cannot know authorship) would erase an earlier
      // agent-authored mint.
      const previous = this.messages.get(existing)!;
      this.messages.set(existing, {
        ...previous,
        ...identity,
        authoredByAgent: previous.authoredByAgent || identity.authoredByAgent,
        permalink: identity.permalink ?? previous.permalink,
      });
      return existing;
    }
    const ref = handle(MESSAGE_PREFIX);
    this.messages.set(ref, identity);
    this.byIdentity.set(key, ref);
    return ref;
  }

  resolveMessage(ref: MessageRef): ChannelMessageIdentity {
    const identity = this.messages.get(ref);
    if (!identity) {
      throw new Error(
        `Unknown message reference '${ref}'. Use a reference returned by a channel tool in this session.`,
      );
    }
    return identity;
  }

  resolveAuthored(ref: MessageRef): ChannelMessageIdentity {
    const identity = this.resolveMessage(ref);
    if (!identity.authoredByAgent) {
      throw new Error(
        `Message '${ref}' was not sent by this agent. Only messages the agent posted can be edited or retracted.`,
      );
    }
    return identity;
  }

  cursor(providerCursor: string): ChannelCursor {
    const cursor = handle(CURSOR_PREFIX);
    this.cursors.set(cursor, providerCursor);
    return cursor;
  }

  resolveCursor(cursor: ChannelCursor): string {
    const providerCursor = this.cursors.get(cursor);
    if (!providerCursor) {
      throw new Error(
        `Unknown cursor '${cursor}'. Use a cursor returned by a previous channel_history call.`,
      );
    }
    return providerCursor;
  }
}
