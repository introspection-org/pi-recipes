import { build } from "esbuild";

await build({
  entryPoints: ["src/mcp-daemon.ts"],
  outfile: "dist/mcp-daemon.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  mainFields: ["module", "main"],
  packages: "bundle",
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
