#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { stdin, stderr, stdout } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  MCP_DAEMON_FINGERPRINT_ENV,
  MCP_DAEMON_SOCKET_ENV,
  MCP_DAEMON_TOKEN_ENV,
  MCP_SESSION_ROOT_ENV,
  type McpDaemonEnvelope,
  type McpDaemonRequest,
} from "./mcp-daemon-protocol.js";

const START_TIMEOUT_MS = 20_000;

function daemonPath(): string {
  return fileURLToPath(new URL("./mcp-daemon.js", import.meta.url));
}

function environment(): { socketPath: string; token: string; fingerprint: string } {
  const socketPath = process.env[MCP_DAEMON_SOCKET_ENV];
  const token = process.env[MCP_DAEMON_TOKEN_ENV];
  const fingerprint = process.env[MCP_DAEMON_FINGERPRINT_ENV];
  if (!socketPath || !token || !fingerprint) {
    throw new Error("MCP daemon environment is incomplete.");
  }
  return { socketPath, token, fingerprint };
}

function commandNeedsStdin(args: readonly string[]): boolean {
  if (args.some((arg, index) => arg === "--json" && args[index + 1] === "-")) return true;
  if (args[0] !== "run") return false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json-errors") continue;
    if (arg === "--var") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--var=")) continue;
    return false;
  }
  return true;
}

function readStdin(): Promise<string> {
  if (!commandNeedsStdin(process.argv.slice(2))) return Promise.resolve("");
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.on("data", (chunk) => (value += chunk));
    stdin.once("end", () => resolve(value));
    stdin.once("error", reject);
  });
}

function exchange(
  request: McpDaemonRequest,
  onEnvelope: (envelope: McpDaemonEnvelope, socket: Socket) => void
): Promise<void> {
  const { socketPath } = environment();
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) onEnvelope(JSON.parse(line) as McpDaemonEnvelope, socket);
        newline = buffer.indexOf("\n");
      }
    });
    socket.once("end", resolve);
    socket.once("error", reject);
  });
}

async function ping(): Promise<boolean> {
  const { token, fingerprint } = environment();
  let ready = false;
  await exchange(
    { type: "ping", id: randomUUID(), token, fingerprint },
    (envelope) => {
      if ("ready" in envelope && envelope.fingerprint === fingerprint) ready = true;
    }
  ).catch(() => {});
  return ready;
}

async function ensureDaemon(): Promise<void> {
  if (await ping()) return;
  const { socketPath } = environment();
  const lockPath = `${socketPath}.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = Number(await readFile(lockPath, "utf8").catch(() => ""));
    if (Number.isSafeInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code === "ESRCH") {
          await rm(lockPath, { force: true });
          return ensureDaemon();
        }
      }
    }
  }

  if (lock) {
    try {
      await lock.writeFile(String(process.pid));
      if (process.platform !== "win32") await rm(socketPath, { force: true });
      const child = spawn(process.execPath, [daemonPath()], {
        detached: true,
        stdio: "ignore",
        env: process.env,
        cwd: process.env[MCP_SESSION_ROOT_ENV] || process.cwd(),
      });
      child.unref();
    } finally {
      await lock.close();
    }
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await ping()) {
      if (lock) await rm(lockPath, { force: true });
      return;
    }
    await delay(50);
  }
  if (lock) await rm(lockPath, { force: true });
  throw new Error("MCP daemon did not become ready before the startup deadline.");
}

async function sendCancel(requestId: string): Promise<void> {
  const { token } = environment();
  await exchange(
    { type: "cancel", id: randomUUID(), token, requestId },
    () => {}
  ).catch(() => {});
}

async function main(args = process.argv.slice(2)): Promise<number> {
  await ensureDaemon();
  if (args.length === 1 && args[0] === "--start-daemon") return 0;
  const { token, fingerprint } = environment();
  const id = randomUUID();
  const input = await readStdin();
  let exitCode: number | undefined;
  let daemonError: string | undefined;
  let interrupted = false;
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    void sendCancel(id);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await exchange(
      { type: "execute", id, token, fingerprint, args, stdin: input },
      (envelope, socket) => {
        if ("stream" in envelope) {
          (envelope.stream === "stdout" ? stdout : stderr).write(envelope.data);
        } else if ("exitCode" in envelope) {
          exitCode = envelope.exitCode;
          socket.end();
        } else if ("error" in envelope) {
          daemonError = envelope.error;
          socket.end();
        }
      }
    );
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  if (daemonError) throw new Error(`MCP daemon: ${daemonError}`);
  return interrupted ? 130 : (exitCode ?? 1);
}

main()
  .then((code) => (process.exitCode = code))
  .catch((error) => {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
