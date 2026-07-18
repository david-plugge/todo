# Todo

A minimal, offline-first todo app for **Mac** (Tauri) and **Android** (later, via Tauri mobile),
with self-hosted sync through **PocketBase**.

## Features

- **Offline-first** — all data lives locally in IndexedDB; the app works with no server.
- **Due date + planned date** — separate "hard deadline" and "when I'll work on it".
- **Today view** with **manual drag-to-reorder**.
- **Projects** with colors.
- **Global hotkey quick-add** on Mac — `Cmd + Shift + Space` opens a floating capture window.
- **Optional self-hosted sync** — log in to a PocketBase server to sync across
  devices. Lossless: concurrent edits to different fields both survive, and the
  full history is replayable. The app stays fully usable offline without it.
- **Runs as a web app too** — the production image builds the SPA and serves it
  straight from PocketBase, so the app is available in any browser at the server
  URL and syncs same-origin (just log in). A service worker caches the app shell
  so the web app **loads offline** after the first visit. See [`server/`](server/README.md).
- Modern minimal design, light + dark.

## Stack

| Layer                  | Choice                                                                            |
| ---------------------- | --------------------------------------------------------------------------------- |
| UI                     | Svelte 5 + TypeScript + Vite                                                      |
| Desktop / mobile shell | Tauri v2                                                                          |
| Local store            | Dexie (IndexedDB)                                                                 |
| Drag sort              | svelte-dnd-action                                                                 |
| Backend                | PocketBase in Docker (see [`server/`](server/README.md))                          |
| Sync                   | Append-only change-log, field-level LWW via Hybrid Logical Clocks, realtime (SSE) |
| Ordering               | Fractional indexing (`fractional-indexing`)                                       |

## Toolchain

Managed by [mise](https://mise.jdx.dev/). Each tool's version lives in its native file — Node + pnpm in `package.json` (`devEngines`), Rust in `rust-toolchain.toml` — and `mise.toml` just tells mise to read them (`mise install`).

```sh
mise install        # install pinned toolchain
pnpm install        # install JS deps
```

## Develop

```sh
pnpm tauri dev      # run the Mac app (Vite + native shell)
pnpm dev            # run just the web UI in a browser (no hotkey / native features)
pnpm check          # typecheck (svelte-check + tsc)
pnpm build          # build the web frontend
pnpm tauri build    # build a distributable .app / .dmg
```

The global hotkey (`Cmd + Shift + Space`) only works in the Tauri app, not the browser.
macOS will ask for **Accessibility** permission the first time so the global shortcut can register.

## Architecture notes

The sync model is an **append-only change-log** (inspired by [Actual Budget](https://actualbudget.org/)):
every field edit is an immutable, HLC-stamped change. That log is the source of truth; the
`tasks`/`projects` tables are a materialized replay of it.

- `src/lib/db.ts` — Dexie schema: materialized `tasks`/`projects` (each carries a hidden per-field
  `clocks` map) + an append-only `changes` log. Includes the v1→v2 migration from the old
  record-LWW model.
- `src/lib/hlc.ts` — Hybrid Logical Clock: a sortable timestamp that keeps causal order across
  devices with skewed clocks. String comparison of the packed form is the LWW tiebreak.
- `src/lib/reducer.ts` — applies a change to the materialized state via per-field last-write-wins
  (`change.hlc > record.clocks[field]`). Idempotent + commutative, so replay is order-independent.
- `src/lib/store.ts` — reactive queries (via Dexie `liveQuery`) and mutations. Every field edit
  becomes a change (appended, applied, then a debounced sync).
- `src/lib/live.ts` — adapts a Dexie `liveQuery` into a Svelte store.
- `src/lib/pb.ts` — PocketBase client, server-URL persistence, and login/logout with a reactive auth store.
- `src/lib/sync.ts` — the sync engine (see below).
- `src/main.ts` — routes `?quickadd` to the lightweight `QuickAdd.svelte`, everything else to `App.svelte`;
  registers the offline service worker (via `virtual:pwa-register`) for the production web build (not in Tauri / dev).
- `vite.config.ts` — configures `vite-plugin-pwa` (Workbox `generateSW`, `autoUpdate`): precaches every
  built asset — HTML shell, hashed JS/CSS, the lazy quick-add chunk, favicon — so the app loads offline.
  The sync API (`/api/`) and admin (`/_/`) are excluded from the SPA fallback, so offline falls back to
  local IndexedDB rather than serving stale API responses. The SW is disabled for Tauri builds (detected
  via `TAURI_ENV_PLATFORM`), so no `sw.js` ships inside the native app.
- `src-tauri/src/lib.rs` — registers the global shortcut and creates/toggles the quick-add window.
- `Dockerfile`, `compose.yml`, `compose.dev.yml` — at the repo root: the multi-stage image
  (builds the SPA and serves it from PocketBase) and prod/dev compose stacks.
- `server/` — backend assets: the bundled schema migration (`pb_migrations/`), setup script, JSVM
  types, and deploy notes.

### How sync works

The local IndexedDB is always the source of truth for the UI. When connected, `sync.ts`:

1. **Pulls** changes appended since our cursor (server `created`), advances the HLC past each, and
   replays them into the materialized state via per-field LWW.
2. **Pushes** locally-recorded changes the server hasn't seen (idempotent via a unique client id).
3. **Realtime** — an SSE subscription applies new changes the instant they land; a 60s poll +
   on-focus + on-reconnect are the safety net for missed events and offline catch-up.

**Why this shape:** because every change is immutable and merges by per-field HLC, replay is
order-independent and idempotent, so devices always converge and full history is reconstructable
from the log. Concurrent edits to _different_ fields both survive (record-level LWW would clobber
one). Ordering uses fractional-index string keys so drag-reorders merge without renumbering.
Delete is a `deletedAt` timestamp change — a tombstone that syncs like any other edit (and is
undoable). Single-user / few-device, so this "CRDT-lite" is enough — no full CRDT framework.

## Roadmap

- [x] **Slice 1** — local Mac app: Today view, projects, due/planned dates, manual sort, quick-add hotkey.
- [x] **Slice 2** — PocketBase (Docker) + optional login and lossless change-log sync (realtime).
- [ ] **Slice 3** — Android build (Tauri mobile) + polish.
