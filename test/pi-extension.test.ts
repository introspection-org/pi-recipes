import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPiRecipesExtension } from "../src/pi-extension.js";
import { createMockExtensionAPI } from "../src/testing.js";

function commandContext(notify = vi.fn()) {
  return {
    hasUI: true,
    cwd: process.cwd(),
    ui: { notify },
  } as any;
}

describe("Pi recipes extension", () => {
  it("registers the recipe command", () => {
    const pi = createMockExtensionAPI();
    createPiRecipesExtension({ libraryDir: "/tmp/pi-recipes-test" })(pi);

    expect(pi.commands.has("recipe")).toBe(true);
  });

  it("creates, lists, and inspects local recipes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-extension-"));
    const notify = vi.fn();
    try {
      const pi = createMockExtensionAPI();
      createPiRecipesExtension({ libraryDir: root })(pi);
      const command = pi.commands.get("recipe");
      expect(command).toBeDefined();

      await command!.handler("new demo", commandContext(notify));
      await command!.handler("list", commandContext(notify));
      await command!.handler("inspect demo", commandContext(notify));

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Created recipe demo"), "info");
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("demo - demo@0.1.0"), "info");
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Recipe: demo@0.1.0"), "info");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs recipes through the fixed local runner hook", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recipes-extension-"));
    const source = join(root, "source");
    const library = join(root, "library");
    const notify = vi.fn();
    const runRecipe = vi.fn(async (request) => ({
      output: `ran: ${request.prompt}`,
      workspaceDir: request.workspaceDir,
    }));
    try {
      mkdirSync(join(source, "agents"), { recursive: true });
      writeFileSync(
        join(source, "package.json"),
        JSON.stringify({ name: "demo", version: "1.0.0", pi: { agents: ["agents/*.yaml"] } })
      );
      writeFileSync(join(source, "agents", "agent.yaml"), "name: agent\ndescription: Demo\n");

      const pi = createMockExtensionAPI();
      createPiRecipesExtension({ libraryDir: library, runRecipe })(pi);
      const command = pi.commands.get("recipe")!;

      await command.handler(`import "${source}" demo`, commandContext(notify));
      await command.handler("run demo check this", commandContext(notify));

      expect(runRecipe).toHaveBeenCalledWith(
        expect.objectContaining({
          recipeDir: join(library, "demo"),
          prompt: "check this",
        })
      );
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("ran: check this"), "info");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
