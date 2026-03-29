# Railway deployment

## Required variables

Set these in the Railway service **Variables** tab:

| Variable | Notes |
|----------|--------|
| `DATABASE_URL` | Use the variable **from your Railway Postgres** plugin (reference `${{Postgres.DATABASE_URL}}` or paste the connection string). |
| `JWT_SECRET` | Long random string (production). Without it, the app exits on startup in `NODE_ENV=production`. |

Railway injects **`PORT`** automatically. The server listens on `process.env.PORT` and binds to `0.0.0.0`.

## Healthcheck

The deploy healthcheck uses **`GET /`**, which returns JSON with `"status": "healthy"`.

## Startup sequence (`start.sh`)

1. **`node scripts/fix-p3009-ecommerce-migration.js`** — clears stuck Prisma **P3009** for `20260316000000_ecommerce_entities` when needed (no-op otherwise). If Prisma returns **P3008** (already applied), the script treats that as success so the container still runs **`migrate deploy`**.
2. `npx prisma migrate deploy`
3. Optional: `node prisma/seed.js` only if **`RUN_SEED=true`**
4. `node server.js`

Seeding is **off by default** so deploys start faster and are less likely to fail before the server listens. For a **first** environment, enable seed once:

- Add variable `RUN_SEED=true`, deploy, confirm admin user exists, then remove `RUN_SEED` or set it to `false`.

Or run seed manually: `railway run npm run seed` (or a one-off job).

## If the healthcheck still fails

1. Open **Deploy logs** and confirm you see `[STARTUP] Starting Node.js server...` and `[SERVER] Server running on port ...`.
2. If the process exits earlier, check **migrate** errors (database URL, network) or missing **`JWT_SECRET`**.
3. Do **not** set `internalPort` in `railway.toml` to a value that disagrees with Railway’s **`PORT`** (see repo `railway.toml` comments).

## Error P3009 — “failed migrations in the target database”

**What it means:** A migration (often `20260316000000_ecommerce_entities`) **started** on Postgres but Prisma recorded it as **failed**. Until that row is resolved, **`prisma migrate deploy` will refuse to run** (your container restarts forever on migrate).

**Typical causes:** network blip to the DB proxy, statement timeout, or the process dying mid-migration. The database may be either **empty** for that migration (transaction rolled back) or **fully applied** (objects exist but Prisma still shows “failed”).

### Fix (one-time, from your machine)

1. Install [Railway CLI](https://docs.railway.com/guides/cli) and link the project, **or** copy **`DATABASE_URL`** from the Railway Postgres service (same DB the app uses).

2. From the **repo root**, with `DATABASE_URL` set to that Railway URL:

   ```bash
   npm run migrate:fix-p3009
   npx prisma migrate deploy
   ```

   The script checks whether the six ecommerce tables (`Category`, `Product`, `Cart`, `CartItem`, `Order`, `OrderItem`) exist:

   - **All present** → runs `prisma migrate resolve --applied 20260316000000_ecommerce_entities` so Prisma marks that migration as done, then you run **`migrate deploy`** to apply any later migrations.
   - **None present** → runs `prisma migrate resolve --rolled-back …` so Prisma clears the failed state; then **`migrate deploy`** will **re-apply** that migration from scratch.
   - **Some but not all** → the script exits with an error; treat the DB as inconsistent (backup / manual SQL / support).

3. Redeploy the app on Railway (or push an empty commit) so `start.sh` runs **`migrate deploy`** successfully.

**Railway one-off (if you use the CLI):**

```bash
railway run npm run migrate:fix-p3009
railway run npx prisma migrate deploy
```

### Manual alternative (no script)

- If tables **exist**: `npx prisma migrate resolve --applied 20260316000000_ecommerce_entities`
- If tables **do not** exist: `npx prisma migrate resolve --rolled-back 20260316000000_ecommerce_entities`

Then run `npx prisma migrate deploy` again. See [Prisma: production troubleshooting](https://www.prisma.io/docs/guides/migrate/production-troubleshooting).

## Error P3018 — `string contains embedded null`

**Cause:** A migration SQL file was saved as **UTF-16** (e.g. from some Windows editors). PostgreSQL rejects query strings that contain **NUL bytes**, which appear between ASCII characters in UTF-16.

**Fix in this repo:** `20260316000000_ecommerce_entities/migration.sql` was converted to **UTF-8** without embedded nulls. Redeploy after pulling latest `main`.

If you add migrations on Windows, save `migration.sql` as **UTF-8** (in VS Code: bottom-right encoding → “Save with Encoding” → UTF-8).
