# Backup and restore runbook

Freiraum uses PocketBase's consistent backup API. A backup includes `data.db`,
`auxiliary.db`, and local file storage, but not the `pb_data/backups` directory
itself. Copy every completed backup to storage outside the application volume.

## Backup

Create a named backup from a stopped application container (PocketBase's admin
backup API remains the supported option for an online backup):

```sh
./freiraum backup-create freiraum-2026-09-18.zip \
  --dir /app/pb_data \
  --encryptionEnv PB_ENCRYPTION_KEY
```

The archive is written to the PocketBase backup filesystem (locally,
`/app/pb_data/backups`). Keep at least two times the size of `pb_data` free while
creating or restoring a backup. Run this daily, retain 14 generations, copy them
off-volume, and alert externally when a scheduled backup is missing. Always make
and export an additional backup before upgrading the application.

## Restore safety contract

A restore never overwrites the active data directory. First stop the service and
extract the archive into a new, empty volume:

```sh
./freiraum restore-new \
  --backup /restore-input/freiraum-2026-09-18.zip \
  --target /restore-output/pb_data \
  --restore-id 4fa496eb-48d7-4bd2-a36a-26ad9c20771b
```

`restore-id` must be generated outside the backup and retained in the deployment
log. The command rejects non-empty targets, path traversal, and symlinks. It
writes `.freiraum-restore-pending` before extraction. A normal server process
refuses to start while that marker exists.

Before the restored volume can be activated, run the finalization transaction:

```sh
./freiraum restore-finalize \
  --dir /restore-output/pb_data \
  --restore-id 4fa496eb-48d7-4bd2-a36a-26ad9c20771b \
  --encryptionEnv PB_ENCRYPTION_KEY
```

The command:

1. record the external restore ID idempotently;
2. rotate `_todo_sync_state.generation`;
3. remove restored OAuth tokens, pending grants, compact refresh-replay evidence, MFA, OTP, and auth-origin
   challenges;
4. rotate `tokenKey` for every `todo_users` and superuser record;
5. leave tasks, lists, `todo_changes`, and `todo_receipts` unchanged; and
6. remove the pending marker only after the transaction commits.

This deliberately signs out every user, including superusers. It prevents a
backup from resurrecting tokens that were revoked after that backup was made.
The external restore ID makes finalization idempotent: retrying the same ID does
not rotate the generation or credentials a second time. Never remove the marker
manually and never point the command at the active production volume.

## Client recovery protocol

Every installation has a persistent UUID sync generation. `pull` without the
current generation returns reset mode and a fixed `until` revision. The client
pages both entity kinds from `/api/todo/snapshot` at that `until`, replaces its
materialized server state, and then resumes change pulls with the returned
generation. Snapshot pages reconstruct the latest change per entity at or before
the fixed boundary; later updates therefore cannot make records disappear from
the snapshot.

Pushes must carry the exact generation in `X-Todo-Sync-Generation`. A mismatch
returns HTTP 409 before any mutation transaction starts. After restore
finalization, stale clients consequently cannot write against the restored
history until they complete reset recovery.

## Restore drill

At least monthly, restore an exported archive into a disposable new volume,
finalize it, and verify login, a complete list/task snapshot, push/pull, and a
second restart from the same volume. Never run a drill against production
`pb_data`. Record the archive checksum, restore ID, generation change, row counts,
and test result.
