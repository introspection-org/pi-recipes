import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const distCli = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "mcp-cli.js"
);

describe("mcp CLI entry detection", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-recipes-mcp-entry-"));
    writeFileSync(join(dir, "mcporter.json"), JSON.stringify({ imports: [], mcpServers: {} }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runCli(entry: string, args: string[]): { status: number | null; output: string } {
    const child = spawnSync(process.execPath, [entry, ...args], {
      env: { ...process.env, MCPORTER_CONFIG: join(dir, "mcporter.json") },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: child.status, output: `${child.stdout}${child.stderr}` };
  }

  it("runs main when invoked directly", () => {
    const result = runCli(distCli, ["--help"]);
    expect(result.status).toBe(0);
    expect(result.output).toContain("mcp");
  });

  it("runs main when invoked through a symlink (pnpm/npm bin shims)", () => {
    // pnpm exposes packages through node_modules symlinks and npm bin shims
    // symlink to the entry script; argv[1] is then the symlink while
    // import.meta.url is the realpath. The CLI must still self-detect.
    const linkDir = join(dir, "bin");
    mkdirSync(linkDir, { recursive: true });
    const link = join(linkDir, "mcp-cli.js");
    symlinkSync(distCli, link);

    const result = runCli(link, ["--help"]);
    expect(result.status).toBe(0);
    expect(result.output).toContain("mcp");
  });

  it("provides wrapper help for search and run subcommands", () => {
    const search = runCli(distCli, ["search", "--help"]);
    expect(search.status).toBe(0);
    expect(search.output.trim().length).toBeGreaterThan(0);

    const run = runCli(distCli, ["run", "--help"]);
    expect(run.status).toBe(0);
    expect(run.output.trim().length).toBeGreaterThan(0);
  });
});
