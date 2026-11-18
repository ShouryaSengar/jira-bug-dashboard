#!/bin/sh
# Starts the Cloud edition locally (workerd + local D1) on http://localhost:8787 with cron testing enabled.
# Requires `npm run build` and `npm run db:migrate:local` first (or just use `npm run dev`).
cd "$(dirname "$0")/.." || exit 1
export WRANGLER_SEND_METRICS=false
exec npx wrangler dev --env dev --port "${PORT:-8787}" --ip 127.0.0.1 --test-scheduled
