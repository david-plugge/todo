# Sync via an append-only, HLC-stamped change-log

Every field edit is recorded as an immutable change stamped with a Hybrid Logical Clock and
appended to a log; the `tasks`/`projects` tables are a materialized replay of that log via
per-field last-write-wins. We chose this over record-level LWW so that concurrent edits to
_different_ fields of the same entity both survive (record-level LWW clobbers one), history is
fully replayable, and convergence is order-independent and idempotent. Scope is
single-user / few-device, so this "CRDT-lite" is enough without a full CRDT framework.

## Consequences

- **Never write `db.tasks` / `db.projects` directly.** All mutations go through `src/lib/store.ts`,
  which appends a change per field, replays it, and schedules a sync. A direct table write bypasses
  the log and silently breaks sync and convergence. Reads via `liveQuery` (`src/lib/live.ts`) are fine.
- Adding a persisted field to `Task` / `Project` means touching three places: `src/lib/types.ts`,
  the skeleton in `src/lib/reducer.ts`, and the recording mutation in `src/lib/store.ts`.
