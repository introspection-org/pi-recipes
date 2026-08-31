import { randomUUID } from "node:crypto";

import type {
  ChannelCursor,
  ChannelFileIdentity,
  ChannelMessageIdentity,
  ChannelRefResolver,
  FileRef,
  MessageRef,
} from "./types.js";

const MESSAGE_PREFIX = "msg_";
const CURSOR_PREFIX = "cur_";
const FILE_PREFIX = "file_";

function handle(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/**
 * Session-scoped opaque handles for messages and pagination cursors.
 *
 * The model only ever sees a handle this store minted, so it cannot name a
 * message it was never shown, and provider id formats stay out of tool schemas.
 * Handles die with the session. A ref from an earlier task is unresolvable
 * rather than dangerous.
 */
export class ChannelRefStore implements ChannelRefResolver {
  private readonly messages = new Map<MessageRef, ChannelMessageIdentity>();
  private readonly byIdentity = new Map<string, MessageRef>();
  private readonly cursors = new Map<ChannelCursor, string>();
  private readonly files = new Map<FileRef, ChannelFileIdentity>();
  private readonly byFileIdentity = new Map<string, FileRef>();

  message(identity: ChannelMessageIdentity): MessageRef {
    const key = `${identity.conversation} ${identity.id}`;
    const existing = this.byIdentity.get(key);
    if (existing) {
      const previous = this.messages.get(existing)!;
      this.messages.set(existing, {
        ...previous,
        ...identity,
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

  cursor(providerCursor: string): ChannelCursor {
    const cursor = handle(CURSOR_PREFIX);
    this.cursors.set(cursor, providerCursor);
    return cursor;
  }

  resolveCursor(cursor: ChannelCursor): string {
    const providerCursor = this.cursors.get(cursor);
    if (!providerCursor) {
      throw new Error(
        `Unknown cursor '${cursor}'. Use a cursor returned by a previous channel_read call.`,
      );
    }
    return providerCursor;
  }

  file(identity: ChannelFileIdentity): FileRef {
    const key = `${identity.conversation} ${identity.id}`;
    const existing = this.byFileIdentity.get(key);
    if (existing) return existing;
    const ref = handle(FILE_PREFIX);
    this.files.set(ref, identity);
    this.byFileIdentity.set(key, ref);
    return ref;
  }

  resolveFile(ref: FileRef): ChannelFileIdentity {
    const identity = this.files.get(ref);
    if (!identity) {
      // The whole point: a provider file id the model invented resolves to
      // nothing, so `channel_fetch_file` can only reach files this
      // conversation actually carried.
      throw new Error(
        `Unknown file reference '${ref}'. Use a file reference from a message in this conversation.`,
      );
    }
    return identity;
  }
}
