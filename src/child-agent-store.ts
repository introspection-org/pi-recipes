/**
 * Filesystem persistence for recipe child agent runs.
 *
 * Each run owns a status file under Pi's recipe runtime state directory — a
 * rolling snapshot of the run state. Snapshots let a later Pi process in the
 * same workspace rehydrate
 * run ids referenced by a resumed conversation: rehydrated runs are readable
 * (status/wait) but not controllable, and a run persisted as `running` died
 * with the previous process, so it is flipped to `interrupted` on rehydrate
 * rather than silently "resumed".
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { childAgentRunsDir, legacyChildAgentRunsDir } from "./runtime-paths.js";

export type ChildRunStatus = "running" | "completed" | "failed" | "interrupted";
export type ChildToolStatus = "running" | "completed" | "failed";

export interface ChildToolActivity {
  id: string;
  name: string;
  args: unknown;
  status: ChildToolStatus;
  startedAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
}

export interface ChildRunSnapshot {
  id: string;
  agent: string;
  label?: string;
  task: string;
  status: ChildRunStatus;
  startedAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
  toolCalls: ChildToolActivity[];
}

const RUN_STATUSES: readonly string[] = [
  "running",
  "completed",
  "failed",
  "interrupted",
];

function isChildRunSnapshot(value: unknown): value is ChildRunSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.agent === "string" &&
    typeof record.task === "string" &&
    typeof record.status === "string" &&
    RUN_STATUSES.includes(record.status) &&
    typeof record.startedAt === "string" &&
    Array.isArray(record.toolCalls)
  );
}

export class ChildAgentRunStore {
  private readonly root: string;
  private readonly legacyRoot: string;
  // Concurrent writes to one status.json interleave (each truncates on open),
  // so snapshot writes for a run are chained behind the previous one.
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(workspaceDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.root = childAgentRunsDir(workspaceDir, env);
    this.legacyRoot = legacyChildAgentRunsDir(workspaceDir);
  }

  async writeStatus(snapshot: ChildRunSnapshot): Promise<void> {
    const previous = this.pendingWrites.get(snapshot.id) ?? Promise.resolve();
    const write = previous
      .catch(() => {})
      .then(async () => {
        const runDir = join(this.root, snapshot.id);
        await mkdir(runDir, { recursive: true });
        await writeFile(
          join(runDir, "status.json"),
          `${JSON.stringify(snapshot, null, 2)}\n`,
          "utf8"
        );
      });
    this.pendingWrites.set(snapshot.id, write);
    try {
      await write;
    } finally {
      if (this.pendingWrites.get(snapshot.id) === write) {
        this.pendingWrites.delete(snapshot.id);
      }
    }
  }

  /**
   * Status snapshots persisted by any prior process for this workspace, one
   * per `<runId>/status.json`. Unreadable or malformed entries are skipped —
   * rehydration is best-effort. The legacy workspace-local directory is still
   * read so existing resumed conversations do not lose old run ids.
   */
  async readPersistedSnapshots(): Promise<ChildRunSnapshot[]> {
    const seen = new Set<string>();
    const snapshots: ChildRunSnapshot[] = [];
    for (const root of [this.root, this.legacyRoot]) {
      for (const snapshot of await this.readSnapshotsFrom(root)) {
        if (seen.has(snapshot.id)) continue;
        seen.add(snapshot.id);
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  }

  private async readSnapshotsFrom(root: string): Promise<ChildRunSnapshot[]> {
    let runIds: string[];
    try {
      runIds = await readdir(root);
    } catch {
      return [];
    }
    const snapshots: ChildRunSnapshot[] = [];
    for (const runId of runIds) {
      try {
        const raw = await readFile(
          join(root, runId, "status.json"),
          "utf8"
        );
        const parsed: unknown = JSON.parse(raw);
        if (isChildRunSnapshot(parsed) && parsed.id === runId) {
          snapshots.push(parsed);
        }
      } catch {
        // skip unreadable runs
      }
    }
    return snapshots;
  }
}
