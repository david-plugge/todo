# Pinned, reproducible image: builds the SPA and serves it from PocketBase.
# Arch-aware so it builds on both an arm64 Mac (local) and an amd64 VPS.
# The build context is the REPO ROOT (see compose.yml) so the web stage
# can compile the frontend.

# ---- fetch the PocketBase binary (arch-aware) ----
FROM alpine:3.21 AS fetch
ARG PB_VERSION=0.39.7
ARG TARGETARCH
RUN apk add --no-cache ca-certificates unzip wget
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) PB_ARCH=amd64 ;; \
      arm64) PB_ARCH=arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    wget -q "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${PB_ARCH}.zip" -O /tmp/pb.zip; \
    unzip /tmp/pb.zip -d /pb

# ---- build the SPA ----
FROM node:24-alpine AS web
RUN corepack enable && corepack prepare pnpm@11.13.1 --activate
WORKDIR /app
# Install deps first so this layer caches unless the manifests change.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
# Then build the frontend (SvelteKit adapter-static → /app/build).
COPY . .
RUN pnpm build

# ---- runtime base: PocketBase + migrations only (the dev target, no SPA) ----
# `--target server` skips the web/Node stage entirely, so a dev build is fast.
FROM alpine:3.21 AS server
RUN apk add --no-cache ca-certificates
COPY --from=fetch /pb/pocketbase /usr/local/bin/pocketbase
# Bundled schema migrations — applied automatically on startup (automigrate),
# so a fresh deploy provisions the `changes` collection with no manual step.
COPY server/pb_migrations/ /pb_migrations/
# Empty by default; the `full` stage fills it. Present so PocketBase's
# --publicDir has a directory to serve (dev just gets 404s for static paths).
RUN mkdir -p /pb_public
EXPOSE 8090
VOLUME /pb_data
# --dir keeps runtime state in the volume; migrations are baked in. --publicDir
# serves the SPA in the `full` image (index fallback on by default for SPA routes).
ENTRYPOINT ["pocketbase", "serve", "--http=0.0.0.0:8090", "--dir=/pb_data", "--migrationsDir=/pb_migrations", "--publicDir=/pb_public"]

# ---- production (default): the base image plus the built SPA in /pb_public ----
FROM server AS full
COPY --from=web /app/build/ /pb_public/
