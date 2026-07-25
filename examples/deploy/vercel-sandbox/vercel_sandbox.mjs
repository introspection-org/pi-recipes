// Serve a recipe from a Vercel Sandbox.
//
// Run with VERCEL_TOKEN / VERCEL_TEAM_ID / VERCEL_PROJECT_ID set (or inside
// a Vercel function with OIDC), plus the recipe's provider keys.
import { Sandbox } from "@vercel/sandbox";

const sandbox = await Sandbox.create({
  runtime: "node24",
  timeout: 45 * 60 * 1000,
  ports: [8888],
  source: {
    // The recipe repository (recipes create scaffold layout).
    type: "git",
    url: process.env.RECIPE_GIT_URL ?? "https://github.com/owner/my-recipe.git",
  },
});

await sandbox.runCommand({
  cmd: "npm",
  args: ["install", "--omit=dev", "@introspection-ai/pi-recipes"],
});

// Fail-fast: a recipe that cannot serve exits non-zero here.
await sandbox.runCommand({
  cmd: "sh",
  args: [
    "-c",
    "nohup npx recipes serve . --host 0.0.0.0 --port 8888 > serve.log 2>&1 &",
  ],
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    RECIPES_SERVE_TOKEN: process.env.RECIPES_SERVE_TOKEN ?? "",
  },
});

console.log(`Tasks API base URL: ${sandbox.domain(8888)}`);
