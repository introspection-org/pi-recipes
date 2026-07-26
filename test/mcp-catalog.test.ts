import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearMcpCatalogPreload,
  preloadMcpCatalogs,
} from "../src/mcp-catalog.js";
import {
  MCP_DAEMON_FINGERPRINT_ENV,
  MCP_DAEMON_SOCKET_ENV,
  MCP_DAEMON_TOKEN_ENV,
} from "../src/mcp-daemon-protocol.js";

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("MCP catalog preload", () => {
  it("delegates retry ownership to the daemon and reuses the successful result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "recipes-catalog-"));
    directories.push(directory);
    const socketPath = join(directory, "mcp.sock");
    const token = "test-token";
    const fingerprint = "test-fingerprint";
    let catalogAttempts = 0;
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (chunk) => {
        const request = JSON.parse(String(chunk).split("\n")[0]!);
        if (request.token !== token) {
          socket.end(`${JSON.stringify({ id: request.id, error: "unauthorized" })}\n`);
          return;
        }
        if (request.type === "ping") {
          socket.end(
            `${JSON.stringify({ id: request.id, ready: true, fingerprint })}\n`
          );
          return;
        }
        catalogAttempts += 1;
        socket.end(
          `${JSON.stringify({
            id: request.id,
            catalogs: [
              {
                id: "crm",
                name: "CRM",
                tools: [{ name: "search_contacts", input_schema: { type: "object" } }],
              },
            ],
          })}\n`
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [MCP_DAEMON_SOCKET_ENV]: socketPath,
      [MCP_DAEMON_TOKEN_ENV]: token,
      [MCP_DAEMON_FINGERPRINT_ENV]: fingerprint,
    };

    const catalogs = await preloadMcpCatalogs({ env, timeoutMs: 100 });
    expect(catalogAttempts).toBe(1);
    expect(catalogs[0]?.tools.map((tool) => tool.name)).toEqual([
      "search_contacts",
    ]);

    await preloadMcpCatalogs({ env, timeoutMs: 100 });
    expect(catalogAttempts).toBe(1);
    clearMcpCatalogPreload(env);
  });
});
