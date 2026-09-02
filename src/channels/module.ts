import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { RecipeConnectorModule } from "../connector-tools.js";
import { ChannelRefStore } from "./refs.js";
import {
  CHANNEL_TOOL_IDS,
  channelConnectorTools,
  registerChannelTools,
  type ChannelToolId,
} from "./tools.js";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelTarget,
} from "./types.js";

export interface ChannelConnectorSession {
  readonly adapter: ChannelAdapter;
  /** Resolved lazily so a task with no channel origin still starts. */
  readonly target: ChannelTarget | null | (() => ChannelTarget | null);
  /** Top-level fallback used by channel_reply when no inbound origin exists. */
  readonly sendTarget?: ChannelTarget | (() => ChannelTarget);
}

export interface ChannelConnectorModuleOptions {
  provider: string;
  /**
   * What this channel supports, as static data.
   *
   * Declared separately from `createSession` because the loader builds the tool
   * catalog before any session exists. A capability discovered by failing a
   * call would also waste an agent turn.
   */
  capabilities: ChannelCapabilities;
  /**
   * Resolve the bound conversation and a client for it.
   *
   * Called once per session. Throwing is the right failure for a task with no
   * channel origin: the tools would have nowhere to act.
   */
  createSession(options: {
    env: NodeJS.ProcessEnv;
    cwd: string;
  }): ChannelConnectorSession;
}

const channelToolIds = new Set<string>(CHANNEL_TOOL_IDS);

/** Whether two capability descriptors say the same thing. */
function sameCapabilities(
  left: ChannelCapabilities,
  right: ChannelCapabilities,
): boolean {
  const keys = Object.keys(right) as (keyof ChannelCapabilities)[];
  return (
    Object.keys(left).length === keys.length &&
    keys.every((key) => left[key] === right[key])
  );
}

/**
 * Build a `RecipeConnectorModule` from a channel adapter.
 *
 * A provider package supplies transport plus a capability descriptor; the
 * neutral tool schemas, the opaque handles, and the capability filtering live
 * here. Two providers therefore cannot drift into differently-shaped versions
 * of the same operation, and neither can quietly grow an addressing argument,
 * because neither writes a tool schema at all.
 *
 * The result satisfies the existing connector contract. The manifest selects
 * the provider package, the agent list selects tools from its catalog, and
 * `tool_search` exposes selected tools that are not active by default.
 */
export function createChannelConnectorModule(
  options: ChannelConnectorModuleOptions,
): RecipeConnectorModule {
  const connectorTools = channelConnectorTools(options.capabilities);
  const deferredToolIds = new Set(
    connectorTools
      .filter((tool) => !tool.defaultActive)
      .map((tool) => tool.id as ChannelToolId),
  );
  return {
    provider: options.provider,
    tools: connectorTools,
    createExtension(moduleOptions): ExtensionFactory {
      const unknown = moduleOptions.tools.filter(
        (tool) => !channelToolIds.has(tool),
      );
      if (unknown.length > 0) {
        throw new Error(
          `Unknown ${options.provider} channel tool(s): ${unknown.join(", ")}`,
        );
      }
      const tools = moduleOptions.tools as readonly ChannelToolId[];
      return (pi) => {
        const session = options.createSession({
          env: moduleOptions.env ?? process.env,
          cwd: moduleOptions.cwd ?? process.cwd(),
        });
        if (session.adapter.provider !== options.provider) {
          throw new Error(
            `Channel adapter for '${options.provider}' returned provider '${session.adapter.provider}'`,
          );
        }
        if (!sameCapabilities(session.adapter.capabilities, options.capabilities)) {
          // The loader selected tools from the declared catalog. An adapter
          // with a different capability set would register a different tool
          // surface. Compare values so an adapter may rebuild the descriptor.
          throw new Error(
            `Channel adapter '${options.provider}' returned capabilities that differ from its declared catalog`,
          );
        }
        registerChannelTools(pi, session.adapter, {
          target: session.target,
          sendTarget: session.sendTarget,
          tools,
          deferredTools: tools.filter((tool) => deferredToolIds.has(tool)),
          refs: new ChannelRefStore(),
        });
      };
    },
  };
}
