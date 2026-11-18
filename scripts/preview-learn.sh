#!/bin/sh
# Preview this branch's Local edition (including /learn/) next to your normal app on 4545.
cd "$(dirname "$0")/.." || exit 1
npm run build >/dev/null && PORT=4547 exec node dist/server/index.js
