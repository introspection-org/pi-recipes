import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecipesExtension } from "../src/pi-extension.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const MANAGED_FETCH_INSTALLER_SYMBOL = Symbol.for(
  "introspection.installManagedFetch"
);

function context() {
  return {
    cwd: process.cwd(),
    hasUI: false,
    model: undefined,
    ui: { notify: vi.fn() },
  } as any;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, MANAGED_FETCH_INSTALLER_SYMBOL);
});

describe("Recipes managed fetch integration", () => {
  it("ensures the managed fetch after Pi session startup", async () => {
    const install = vi.fn();
    Reflect.set(globalThis, MANAGED_FETCH_INSTALLER_SYMBOL, install);
    const pi = createMockExtensionAPI();
    createRecipesExtension()(pi);

    await pi.emitExtensionEvent(
      { type: "session_start", reason: "startup" } as any,
      context()
    );

    expect(install).toHaveBeenCalledOnce();
  });

  it("rechecks the managed fetch immediately before provider requests", async () => {
    const install = vi.fn();
    Reflect.set(globalThis, MANAGED_FETCH_INSTALLER_SYMBOL, install);
    const pi = createMockExtensionAPI();
    createRecipesExtension()(pi);

    await pi.emitExtensionEvent(
      { type: "before_provider_request", payload: {} } as any,
      context()
    );

    expect(install).toHaveBeenCalledOnce();
  });

  it("is a no-op outside an Introspection-managed Runtime", async () => {
    const pi = createMockExtensionAPI();
    createRecipesExtension()(pi);

    await expect(
      pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        context()
      )
    ).resolves.toBeDefined();
  });
});
