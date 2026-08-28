import { mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

export const SLACK_RECIPE_CONNECTOR_PACKAGE =
  "@introspection-ai/recipe-connector-slack";

export function installSlackRecipeConnector(recipeDir: string): void {
  const scopeDir = join(recipeDir, "node_modules", "@introspection-ai");
  const packageDir = resolve(
    import.meta.dirname,
    "../../packages/recipe-connector-slack"
  );
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(
    packageDir,
    join(scopeDir, "recipe-connector-slack"),
    process.platform === "win32" ? "junction" : "dir"
  );
}
