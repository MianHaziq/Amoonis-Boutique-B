/**
 * Fixes Prisma P3009 when `20260316000000_ecommerce_entities` is stuck as "failed"
 * in `_prisma_migrations` (common after a timeout, proxy drop, or partial run).
 *
 * Heuristic:
 * - If ALL ecommerce tables from that migration exist → `migrate resolve --applied`
 * - If NONE exist → `migrate resolve --rolled-back` (next `migrate deploy` will re-apply)
 * - If MIXED → stop; database needs manual repair
 *
 * P3008 ("already recorded as applied") is treated as success — no-op, continue startup.
 *
 * Usage (local or Railway one-off with DATABASE_URL set):
 *   node scripts/fix-p3009-ecommerce-migration.js
 *   npx prisma migrate deploy
 */
require('dotenv').config();
const { spawnSync } = require('child_process');
const path = require('path');
const { Client } = require('pg');

const MIGRATION_NAME = '20260316000000_ecommerce_entities';
const TABLES = ['Category', 'Product', 'Cart', 'CartItem', 'Order', 'OrderItem'];
const REPO_ROOT = path.join(__dirname, '..');

async function tableExists(client, name) {
  const r = await client.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS x`,
    [name]
  );
  return r.rows[0].x === true;
}

/** Any row for this migration with finished_at set = Prisma considers it applied. */
async function migrationHasFinishedRow(client) {
  const r = await client.query(
    `SELECT
       COUNT(*)::int AS cnt,
       COALESCE(bool_or("finished_at" IS NOT NULL), false) AS has_finished
     FROM "_prisma_migrations"
     WHERE "migration_name" = $1`,
    [MIGRATION_NAME]
  );
  return r.rows[0];
}

async function migrationsTableExists(client) {
  const r = await client.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
    ) AS x`
  );
  return r.rows[0].x === true;
}

/**
 * Run prisma migrate resolve; treat P3008 as OK (race / already applied).
 */
function runMigrateResolve(appliedOrRolledBack) {
  const flag = appliedOrRolledBack === 'applied' ? '--applied' : '--rolled-back';
  const res = spawnSync(
    'npx',
    ['prisma', 'migrate', 'resolve', flag, MIGRATION_NAME],
    {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }
  );
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.status === 0) {
    console.log(out.trimEnd());
    return;
  }
  if (out.includes('P3008') || /already recorded as applied/i.test(out)) {
    console.log('[fix-p3009] Migration already applied in DB (P3008). Continuing.');
    return;
  }
  if (
    out.includes('P3011') ||
    /already marked as rolled back/i.test(out) ||
    /already.*rolled back/i.test(out)
  ) {
    console.log('[fix-p3009] Migration already rolled back. Continuing.');
    return;
  }
  console.error(out);
  process.exit(res.status || 1);
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('[fix-p3009] DATABASE_URL is required');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  let exists;
  try {
    const hasTable = await migrationsTableExists(client);
    if (!hasTable) {
      console.log('[fix-p3009] No _prisma_migrations table yet — fresh DB, skipping.');
      process.exit(0);
    }

    const { cnt, has_finished: hasFinished } = await migrationHasFinishedRow(client);
    if (cnt === 0) {
      console.log(`[fix-p3009] No row for ${MIGRATION_NAME} — nothing to fix.`);
      process.exit(0);
    }

    if (hasFinished === true) {
      console.log('[fix-p3009] Migration already has finished_at in _prisma_migrations. Nothing to do.');
      process.exit(0);
    }

    exists = await Promise.all(TABLES.map((t) => tableExists(client, t)));
  } finally {
    await client.end();
  }

  const count = exists.filter(Boolean).length;
  console.log('[fix-p3009] Table presence:', TABLES.map((t, i) => `${t}=${exists[i]}`).join(', '));

  if (count > 0 && count < TABLES.length) {
    console.error(
      '[fix-p3009] Partial schema detected. Do not auto-resolve. Restore from backup or fix tables manually, then ask for help.'
    );
    process.exit(1);
  }

  if (count === TABLES.length) {
    console.log('[fix-p3009] All ecommerce tables exist → marking migration as APPLIED (or no-op if already).');
    runMigrateResolve('applied');
  } else {
    console.log('[fix-p3009] No ecommerce tables → marking migration as ROLLED BACK (or no-op if already).');
    runMigrateResolve('rolled-back');
  }

  console.log('[fix-p3009] Done. Next: prisma migrate deploy');
}

main().catch((e) => {
  console.error('[fix-p3009]', e.message);
  process.exit(1);
});
