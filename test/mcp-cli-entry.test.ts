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
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ servers: [] }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runCli(
    entry: string,
    args: string[],
    opts: { input?: string; env?: Record<string, string> } = {}
  ): {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    output: string;
  } {
    const child = spawnSync(process.execPath, [entry, ...args], {
      env: {
        ...process.env,
        MCPORTER_CONFIG: join(dir, "mcporter.json"),
        PI_RECIPES_MCP_MANIFEST: join(dir, "mcp.json"),
        ...opts.env,
      },
      encoding: "utf8",
      timeout: 30_000,
      input: opts.input,
    });
    return {
      status: child.status,
      signal: child.signal,
      stdout: child.stdout,
      stderr: child.stderr,
      output: `${child.stdout}${child.stderr}`,
    };
  }

  it("runs main when invoked directly", () => {
    const result = runCli(distCli, ["--help"]);
    expect(result.status).toBe(0);
    expect(result.output).toContain("mcp <command> --help");
    expect(result.output).toContain("not `mcporter` or `npx mcporter`");
    expect(result.output).toContain("MCP resources");
    expect(result.output).toContain("CallResult");
    expect(result.output).toContain("multi-value |");
    expect(result.output).toContain(
      "Inspect the exact tool before supplying arguments: mcp list <server.tool> --schema"
    );
  });

  it("exits cleanly when a downstream pipeline closes stdout", () => {
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        [
          'const { spawn } = require("node:child_process");',
          `const child = spawn(process.execPath, [${JSON.stringify(distCli)}, "--help"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });`,
          "let stderr = '';",
          "child.stderr.setEncoding('utf8');",
          "child.stderr.on('data', chunk => { stderr += chunk; });",
          "child.stdout.destroy();",
          "child.on('close', code => { process.stderr.write(stderr); process.exit(code ?? 1); });",
        ].join("\n"),
      ],
      {
        env: {
          ...process.env,
          MCPORTER_CONFIG: join(dir, "mcporter.json"),
          PI_RECIPES_MCP_MANIFEST: join(dir, "mcp.json"),
        },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    expect(probe.status).toBe(0);
    expect(probe.stderr).not.toContain("EPIPE");
    expect(probe.stderr).not.toContain("Unhandled 'error' event");
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
    expect(search.output).toContain("Try broader or alternate terms");
    expect(search.output).toContain("mcp list <server.tool> --schema");

    const run = runCli(distCli, ["run", "--help"]);
    expect(run.status).toBe(0);
    expect(run.output.trim().length).toBeGreaterThan(0);
    expect(run.output).toContain("PI_RECIPES_MCP_RUN_TIMEOUT_MS");
    expect(run.output).toContain("MCP calls are always headless");
    expect(run.output).not.toContain("managed");
  });

  it("keeps an empty search on the progressive-disclosure path", () => {
    const result = runCli(distCli, ["search", "unlikely-capability"]);
    expect(result.status).toBe(0);
    expect(result.output).toContain("Try broader or alternate terms");
    expect(result.output).toContain("Use `mcp list` only to identify exact tool names");
    expect(result.output).toContain("mcp list <server.tool> --schema");
    expect(result.output).not.toContain("run `mcp list` to inspect available servers");
  });

  it("provides recipe-scoped help for delegated commands", () => {
    for (const command of ["list", "call"]) {
      const result = runCli(distCli, [command, "--help"]);
      expect(result.status).toBe(0);
      expect(result.output).toContain("recipe session");
      expect(result.output).not.toContain("--http-url");
      expect(result.output).not.toContain("--stdio");
    }
  });

  it("documents exact-target list flags and keeps quiet mode free of the capability banner", () => {
    const help = runCli(distCli, ["list", "--help"]);
    expect(help.output).toContain("exact server target");
    expect(help.output).toContain("--no-oauth");

    const quiet = runCli(distCli, ["list", "--quiet"]);
    expect(quiet.status).toBe(2);
    expect(quiet.output).not.toContain("Only exact tool names shown");
  });

  it("keeps exact-tool schema JSON machine-readable on delegated failures", () => {
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        servers: [
          {
            id: "offline",
            base_url: "http://127.0.0.1:9/mcp",
            tools: [
              {
                name: "lookup",
                input_schema: { type: "object", properties: {} },
                output_schema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                },
              },
            ],
          },
        ],
      })
    );
    writeFileSync(
      join(dir, "mcporter.json"),
      JSON.stringify({
        imports: [],
        mcpServers: {
          offline: {
            baseUrl: "http://127.0.0.1:9/mcp",
            allowedTools: ["lookup"],
          },
        },
      })
    );

    const result = runCli(distCli, [
      "list",
      "offline.lookup",
      "--schema",
      "--json",
      "--timeout",
      "100",
    ]);
    expect(result.status).not.toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stdout).not.toContain("Output schema (response shape)");
    expect(result.stderr).not.toContain("Only exact tool names shown");
  });

  it("documents JSON stdin, structured call errors, and headless authentication", () => {
    const call = runCli(distCli, ["call", "--help"]);
    expect(call.output).toContain("--args <json|->");
    expect(call.output).toContain("CLI usage/policy errors stay on stderr with exit 2");
    expect(call.output).toContain("--no-oauth");
    expect(call.output).toContain("Quote argument tokens containing shell operators");

    const auth = runCli(distCli, ["auth", "contacts"]);
    expect(auth.status).toBe(2);
    expect(auth.output).toContain("Ask the user to authenticate");
    expect(auth.output).not.toContain("managed");
  });

  it("blocks mcporter administration and ad-hoc connection surfaces", () => {
    for (const args of [
      ["config", "list"],
      ["resource", "contacts"],
      ["generate-cli", "contacts"],
      ["list", "--http-url", "https://example.test/mcp"],
    ]) {
      const result = runCli(distCli, args);
      expect(result.status).toBe(2);
      expect(result.output).toContain("unavailable");
    }
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

  it("reports uncertain remote outcome on a yielding timeout", () => {
    const result = runCli(distCli, ["run"], {
      input: "await new Promise(() => {})",
      env: { PI_RECIPES_MCP_RUN_TIMEOUT_MS: "100" },
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("Remote side effects may already have occurred");
    expect(result.output).toContain("inspect state before retrying");
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

  it("rejects fractional search limits and unknown options", () => {
    const fractional = runCli(distCli, ["search", "profile", "--limit", "1.5"]);
    expect(fractional.status).toBe(2);
    expect(fractional.output).toContain("--limit expects a positive integer");

    const unknown = runCli(distCli, ["search", "profile", "--limt", "2"]);
    expect(unknown.status).toBe(2);
    expect(unknown.output).toContain("Unknown mcp search option '--limt'");
  });

  it("rejects a call argument key passed more than once", () => {
    const result = runCli(distCli, ["call", "ghost.lookup", "q:a", "limit:5", "q:b"]);
    expect(result.status).toBe(2);
    expect(result.output).toContain("argument 'q' was passed more than once");
    expect(result.output).not.toContain("argument 'limit'");
  });

  it("rejects invalid run timeout configuration", () => {
    const result = runCli(distCli, ["run"], {
      input: "return 1",
      env: { PI_RECIPES_MCP_RUN_TIMEOUT_MS: "NaN" },
    });
    expect(result.status).toBe(2);
    expect(result.output).toContain("PI_RECIPES_MCP_RUN_TIMEOUT_MS expects a positive integer");
  });
});
