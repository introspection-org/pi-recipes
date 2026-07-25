# Persistence

Recipes does not ship a session store. It ships the two seams a store
plugs into, and this directory shows both ends wired to Postgres.

```
                    ┌───────────────────────────┐
   write side  ───▶ │  onEvent  (tap, per turn) │ ───▶  your rows
                    └───────────────────────────┘
                    ┌───────────────────────────┐
   read side   ◀─── │  sessionManager / restore │ ◀───  your rows
                    └───────────────────────────┘
```

The agent's transcript is observable on the way out and restorable on the
way in, so durability is a property of your infrastructure rather than a
feature of ours. Same shape whether you land it in Postgres, Redis, S3, or
a Durable Object.

## The file-backed default

If a mounted volume is enough, you do not need any of this:

```bash
recipes serve . --session-dir /sessions
```

That writes one Pi session file per task and rebuilds the task index from
the same directory at boot. `postgres.ts` here is the same contract
against a database instead of a disk.

## Running the example

```bash
export DATABASE_URL=postgres://localhost:5432/recipes
node --experimental-strip-types postgres.ts
```

Schema:

```sql
CREATE TABLE recipe_sessions (
  task_id     TEXT PRIMARY KEY,
  session     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## What to know before relying on it

- **Turn boundaries are the durable unit.** `onEvent` is a tap, not a
  write-ahead log: a crash between an event and your write loses that
  delta, and an interrupted turn replays rather than resumes.
- **Pi flushes a session only once an assistant message exists.** A task
  that never completes a turn deliberately leaves nothing behind.
- **Restoration is lazy.** `restoreTasks` rebuilds the index at boot and
  opens a Pi session only when a task is next run, so restarting with
  10,000 persisted tasks costs 10,000 index rows, not 10,000 sessions.
- **One writer per task.** These seams assume a single process owns a
  task's session. Running multiple replicas against one store needs
  sticky routing, or a lease you enforce.
