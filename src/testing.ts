import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";

export interface MockExtensionAPI extends ExtensionAPI {
  commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
}

export function createMockExtensionAPI(): MockExtensionAPI {
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  return {
    commands,
    on() {},
    registerTool() {},
    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      commands.set(name, options);
    },
    registerShortcut() {},
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    events: {
      emit() {},
      on() {
        return () => {};
      },
      off() {},
    },
  } as unknown as MockExtensionAPI;
}
