#!/bin/sh
set -e

echo "[STARTUP] Running database migrations..."
npx prisma migrate deploy

echo "[STARTUP] Seeding database..."
node prisma/seed.js

echo "[STARTUP] Starting Node.js server..."
exec node server.js
