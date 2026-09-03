import type { ChannelAdapter, ChannelTarget } from "./types.js";

export interface ChannelConnectorSession {
  readonly adapter: ChannelAdapter;
  /** Resolved lazily so a task with no channel origin still starts. */
  readonly target: ChannelTarget | (() => ChannelTarget);
}

export interface ChannelConnectorSessionService {
  register(provider: string, session: ChannelConnectorSession): void;
  get(): ChannelConnectorSession | undefined;
  require(): ChannelConnectorSession;
}

export function createChannelConnectorSessionService(): ChannelConnectorSessionService {
  const sessions = new Map<string, ChannelConnectorSession>();

  function get(): ChannelConnectorSession | undefined {
    if (sessions.size === 0) return undefined;
    if (sessions.size > 1) {
      throw new Error(
        `Recipe session has multiple channel connector sessions: ${[...sessions.keys()].join(", ")}`,
      );
    }
    return sessions.values().next().value;
  }

  return Object.freeze({
    register(provider: string, session: ChannelConnectorSession) {
      sessions.set(provider, session);
    },
    get,
    require() {
      const session = get();
      if (!session) {
        throw new Error("Recipe session has no channel connector session");
      }
      return session;
    },
  });
}
