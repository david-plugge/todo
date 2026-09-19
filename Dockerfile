# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM node:24.20.0-bookworm-slim AS frontend
WORKDIR /src

RUN npm install --global pnpm@12.4.1

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile

COPY svelte.config.js vite.config.ts tsconfig.json ./
COPY static ./static
COPY src ./src
RUN pnpm run build

FROM --platform=$BUILDPLATFORM golang:1.27.1-bookworm AS backend
WORKDIR /src/backend

COPY backend/go.mod backend/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY backend ./
ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/todo .

FROM alpine:3.22.1 AS runtime

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S -g 10001 todo \
    && adduser -S -D -H -u 10001 -G todo todo \
    && mkdir -p /app/pb_data \
    && chown -R 10001:10001 /app

WORKDIR /app
COPY --from=backend --chown=10001:10001 /out/todo ./todo
COPY --from=frontend --chown=10001:10001 /src/pb_public ./pb_public
COPY --chmod=755 --chown=10001:10001 docker-entrypoint.sh ./docker-entrypoint.sh

USER 10001:10001
EXPOSE 8090
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8090/api/health"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]
