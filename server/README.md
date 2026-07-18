# Todo sync backend (PocketBase)

Self-hosted [PocketBase](https://pocketbase.io) — the sync server for the app.
Pinned to **v0.39.7** in a small, arch-aware Docker image (builds on both an
arm64 Mac and an amd64 VPS).

The app is offline-first: this server is optional and only enables sync across
devices. Auth is **login-only** — you seed one user here; there is no in-app
signup.

## Data model

One append-only collection, `changes`, scoped to an `owner` (a `users` record)
so every device that logs in sees only its own log. Each row is one immutable
field edit:

- `cid` — client change id; globally unique (dedupes re-pushes across devices).
- `entity` / `entityId` — which task or project the change targets.
- `field` / `value` — the field set and its new value (any JSON).
- `hlc` — Hybrid Logical Clock; the per-field last-write-wins key.
- `created` — server-clock autodate; the pull cursor.

The app materializes this log into tasks/projects locally. The collection is
create + read only for the owner (no update/delete), so the log is immutable.

The schema is defined by a **bundled migration** in `pb_migrations/`, baked into
the image and applied automatically on first start — a fresh deploy needs no
manual schema step.

## Run it

The compose files (`compose.yml`, `compose.dev.yml`) and the `Dockerfile` live
at the **repo root**; run `docker compose` from there. The backend assets —
this README, `setup.mjs`, `types.d.ts`, and `pb_migrations/` — stay here in
`server/`.

```sh
docker compose up -d --build          # from the repo root; PocketBase on :8090
```

The image also **builds the web app and serves it** from PocketBase, so once
it's up the todo app is at <http://localhost:8090/> — opened there in a browser
it syncs against that same origin (no server URL to type, just log in). The API
is under `/api/` and the admin dashboard under `/_/`.

> The build context is the repo root (`compose.yml` sets `context: .`) so the
> image can compile the SPA from source.

### Dev backend (PocketBase only)

While developing the frontend you run it with `pnpm dev` (vite, HMR), so you
don't want to rebuild and bundle the SPA into the image on every change. Use the
dev compose file — it targets the Dockerfile's `server` stage (PocketBase +
migrations, no SPA build), so it builds in seconds:

```sh
docker compose -f compose.dev.yml up -d --build   # from the repo root; PocketBase only on :8090
```

Then run `pnpm dev` at the repo root and connect the app to `http://localhost:8090`.
It shares the `pb_data` volume with the full image, so your local data is the same
either way. (The Dockerfile's `full` stage — the default `docker compose` build —
is just this `server` stage plus the compiled SPA copied into `pb_public`.)

State lives in the `pb_data` Docker volume, so it survives restarts and image
rebuilds.

### 1. Create the admin (superuser)

```sh
docker compose exec pocketbase pocketbase superuser upsert you@example.com 'a-strong-admin-password' --dir=/pb_data
```

The admin dashboard is then at `http://localhost:8090/_/`.

### 2. Seed your login user

The `changes` schema is already applied by the bundled migration, so this step
only creates your one login user (the `pocketbase` CLI can make superusers but
not regular `users` accounts). From the repo root (so Node finds the
`pocketbase` package):

```sh
SUPERUSER_EMAIL=you@example.com \
SUPERUSER_PASSWORD='a-strong-admin-password' \
APP_USER_EMAIL=me@example.com \
APP_USER_PASSWORD='your-app-password' \
PB_URL=http://127.0.0.1:8090 \
node server/setup.mjs
```

`setup.mjs` is idempotent — re-run it any time to rotate the app password.

Then in the app: **sidebar → Connect to sync**, enter the server URL and the
`APP_USER_*` credentials.

To evolve the schema later, change it, let PocketBase auto-generate a migration
into `pb_migrations/`, commit it, and rebuild the image — it applies on restart.

### Migration type safety

Migrations reference `../types.d.ts` (`/// <reference … />`) for editor
autocomplete of the PocketBase JSVM API (`Collection`, `migrate`, `$app`, …).
It's a generated artifact tied to the PocketBase **version**, not to our schema,
so it's stable while we stay on a pinned version. It lives in `server/` (not
`pb_migrations/`) so it's not copied into the image. Regenerate it after a
version bump:

```sh
docker compose exec -T pocketbase cat /pb_data/types.d.ts > server/types.d.ts
```

## Deploying to the VPS

1. Copy the **repo** up (the image builds the SPA from source, so `server/`
   alone isn't enough) and run `docker compose up -d --build` from the repo root.
2. Put it behind a TLS reverse proxy (Caddy/nginx/Traefik) — PocketBase speaks
   plain HTTP on 8090; terminate HTTPS in front of it. Point the proxy at
   `127.0.0.1:8090` and give it a hostname like `https://todo.example.com`.
   The web app is then at `https://todo.example.com/` and syncs same-origin.
3. Create the superuser and run `setup.mjs` with `PB_URL=https://todo.example.com`
   (schema auto-applies from the bundled migration; this just seeds your user).
4. Connect the app to the HTTPS URL.

By default PocketBase allows cross-origin API calls, which is what the app
needs. Keep the admin dashboard (`/_/`) behind the proxy / firewall or IP-allowlist it.

## Stop / reset

```sh
docker compose down                   # stop (keeps data)
docker compose down -v                # stop and DELETE all data (the pb_data volume)
```
