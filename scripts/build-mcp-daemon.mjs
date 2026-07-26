import { build } from "esbuild";

await build({
  entryPoints: {
    "mcp-daemon": "src/mcp-daemon.ts",
    "mcp-run-worker": "src/mcp-run-worker.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  splitting: true,
  chunkNames: "mcp-chunks/[name]-[hash]",
  mainFields: ["module", "main"],
  packages: "bundle",
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
