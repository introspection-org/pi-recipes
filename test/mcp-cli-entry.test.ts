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

  function runCli(
    entry: string,
    args: string[],
    opts: { input?: string; env?: Record<string, string> } = {}
  ): { status: number | null; signal: NodeJS.Signals | null; output: string } {
    const child = spawnSync(process.execPath, [entry, ...args], {
      env: { ...process.env, MCPORTER_CONFIG: join(dir, "mcporter.json"), ...opts.env },
      encoding: "utf8",
      timeout: 30_000,
      input: opts.input,
    });
    return { status: child.status, signal: child.signal, output: `${child.stdout}${child.stderr}` };
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
    expect(run.output).toContain("PI_RECIPES_MCP_RUN_TIMEOUT_MS");
  });

  it("rejects an empty run script as a usage error", () => {
    const result = runCli(distCli, ["run"], { input: "  \n" });
    expect(result.status).toBe(2);
    expect(result.output).toContain("mcp run: empty script");
  });

  it("reports unknown servers in run scripts with the available list", () => {
    const result = runCli(distCli, ["run"], { input: "await tools.ghost.lookup({})" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("Unknown MCP server 'ghost'");
    expect(result.output).toContain("No MCP servers are configured.");
  });

  it("force-kills run scripts that never yield", () => {
    const result = runCli(distCli, ["run"], {
      input: "while (true) {}",
      env: { PI_RECIPES_MCP_RUN_TIMEOUT_MS: "500" },
    });
    expect(result.signal).toBe("SIGKILL");
    expect(result.output).toContain("mcp run: killed after 2500ms");
    expect(result.output).toContain("synchronous busy-loop");
  });

  it("rejects malformed call expressions before the ad-hoc spawn path", () => {
    const result = runCli(distCli, ["call", 'ghost.lookup(q: "x", limit:']);
    expect(result.status).toBe(2);
    expect(result.output).toContain("malformed tool expression");
    expect(result.output).toContain("balanced quotes and parentheses");
  });

  it("accepts well-formed call expressions and plain refs with dots", () => {
    // Balanced expression → not flagged (fails later on the unknown server).
    const expr = runCli(distCli, ["call", 'ghost.lookup(q: "x")']);
    expect(expr.output).not.toContain("malformed tool expression");
    const plain = runCli(distCli, ["call", "ghost.lookup", "q:a"]);
    expect(plain.output).not.toContain("malformed tool expression");
  });

  it("rejects non-numeric search limits", () => {
    const result = runCli(distCli, ["search", "profile", "--limit", "abc"]);
    expect(result.status).toBe(2);
    expect(result.output).toContain("--limit expects a positive integer, got 'abc'");
  });

  it("warns when a call argument key is passed more than once", () => {
    const result = runCli(distCli, ["call", "ghost.lookup", "q:a", "limit:5", "q:b"]);
    expect(result.output).toContain("argument 'q' was passed more than once");
    expect(result.output).not.toContain("argument 'limit'");
  });
});
