# Todo

Offline-first todo app (SvelteKit + Tauri + PocketBase). See `README.md` for architecture and
`docs/adr/` for decision records.

## Working in this repo

- **Data layer:** never write `db.tasks` / `db.projects` directly — all mutations go through
  `src/lib/store.ts`. Why: `docs/adr/0001-append-only-change-log-sync.md`.

## Agent skills

- **Issues** — GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.
- **Triage labels** — see `docs/agents/triage-labels.md`.
- **Domain docs / ADRs** — see `docs/agents/domain.md`.
