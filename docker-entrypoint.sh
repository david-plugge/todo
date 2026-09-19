#!/bin/sh
set -eu

if [ "$#" -ne 0 ]; then
  echo "The production container does not accept command overrides." >&2
  exit 64
fi

/app/todo production-check

exec /app/todo serve \
  --http=0.0.0.0:8090 \
  --dir=/app/pb_data \
  --publicDir=/app/pb_public \
  "--origins=${TODO_PUBLIC_URL}" \
  --encryptionEnv=PB_ENCRYPTION_KEY
