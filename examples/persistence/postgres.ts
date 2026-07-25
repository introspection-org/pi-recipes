/**
 * Serve a recipe with task sessions persisted in Postgres.
 *
 * Demonstrates both halves of the persistence contract:
 *
 *   write  — `onTask` taps the session and mirrors the transcript to a row
 *   read   — `restoreTasks` rebuilds the index at boot; each entry reopens
 *            its transcript lazily, on first use
 *
 * Nothing here is recipes-specific plumbing you must copy exactly. Swap
 * `pg` for Redis, S3, or a Durable Object and the shape is unchanged.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Pool } from "pg";
import { serveRecipe, type RestorableTask } from "@introspection-ai/pi-recipes/serve";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Pi persists a session as JSONL. We store those lines verbatim rather
 * than reshaping them: the entry format is public and typed, and keeping
 * it intact means `SessionManager.open` can read the session back without
 * a lossy translation step in the middle.
 */
async function saveSession(taskId: string, jsonl: string): Promise<void> {
  await pool.query(
    `INSERT INTO recipe_sessions (task_id, session)
       VALUES ($1, $2::jsonb)
     ON CONFLICT (task_id)
       DO UPDATE SET session = EXCLUDED.session, updated_at = now()`,
    [taskId, JSON.stringify({ jsonl })]
  );
}

/**
 * Materialize a stored transcript back onto disk so Pi can open it. The
 * scratch file is an implementation detail of this adapter — the durable
 * copy is the row.
 */
function openFromRow(taskId: string, jsonl: string): SessionManager {
  const dir = mkdtempSync(join(tmpdir(), `recipe-session-${taskId}-`));
  const path = join(dir, `${taskId}.jsonl`);
  writeFileSync(path, jsonl);
  return SessionManager.open(path, dir);
}

const restoreTasks = async (): Promise<RestorableTask[]> => {
  const { rows } = await pool.query<{
    task_id: string;
    session: { jsonl: string };
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT task_id, session, created_at, updated_at
       FROM recipe_sessions
      ORDER BY created_at`
  );
  return rows.map((row) => ({
    taskId: row.task_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    // Lazy: nothing touches Postgres or Pi until the task is next run.
    open: () => openFromRow(row.task_id, row.session.jsonl),
  }));
};

const server = serveRecipe({
  recipeDir: ".",
  restoreTasks,
  // Mirror each settled turn into the row. `agent_end` is the turn
  // boundary — the durable unit — so writing there matches the guarantee
  // the seam actually offers rather than implying a finer one.
  onTask: (taskId, handle) => {
    handle.session.subscribe((event) => {
      if ((event as { type?: string }).type !== "agent_end") return;
      const jsonl = handle.session.messages
        .map((message) => JSON.stringify({ type: "message", message }))
        .join("\n");
      void saveSession(taskId, jsonl).catch((error: unknown) => {
        // Never let a storage failure take down the turn; surface it and
        // let the next turn re-write the full transcript.
        console.error(`[persistence] save failed for ${taskId}:`, error);
      });
    });
  },
});

await server.listen({ port: 8888, hostname: "0.0.0.0" });
console.error("serving on :8888 with Postgres-backed sessions");
