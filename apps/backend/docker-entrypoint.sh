#!/bin/sh
# Apply pending DB migrations, then start the backend (ADR-0021 §3).
set -e
echo "[zantiflow] applying migrations…"
node_modules/.bin/prisma migrate deploy
echo "[zantiflow] starting backend…"
exec node dist/index.js
