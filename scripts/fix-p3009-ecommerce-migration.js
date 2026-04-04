/**
 * Fixes Prisma P3009 when `20260316000000_ecommerce_entities` is stuck as "failed"
 * in `_prisma_migrations` (common after a timeout, proxy drop, or partial run).
 *
 * Heuristic:
 * - If ALL ecommerce tables from that migration exist → `migrate resolve --applied`
 * - If NONE exist → `migrate resolve --rolled-back` (next `migrate deploy` will re-apply)
 * - If MIXED → stop; database needs manual repair
 *
 * Usage (local or Railway one-off with DATABASE_URL set):
 *   node scripts/fix-p3009-ecommerce-migration.js
 *   npx prisma migrate deploy
 */
require('dotenv').config();
const { execSync } = require('child_process');
const { Client } = require('pg');

const MIGRATION_NAME = '20260316000000_ecommerce_entities';
const TABLES = ['Category', 'Product', 'Cart', 'CartItem', 'Order', 'OrderItem'];

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

async function getMigrationRow(client) {
  const r = await client.query(
    `SELECT "finished_at", "logs", "rolled_back_at"
     FROM "_prisma_migrations"
     WHERE "migration_name" = $1`,
    [MIGRATION_NAME]
  );
  return r.rows[0] || null;
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

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('[fix-p3009] DATABASE_URL is required');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  let exists;
  let migrationRow;
  try {
    const hasTable = await migrationsTableExists(client);
    if (!hasTable) {
      console.log('[fix-p3009] No _prisma_migrations table yet — fresh DB, skipping.');
      process.exit(0);
    }

    migrationRow = await getMigrationRow(client);
    if (!migrationRow) {
      console.log(`[fix-p3009] No row for ${MIGRATION_NAME} — migration not started or not yet recorded. Nothing to fix.`);
      process.exit(0);
    }

    if (migrationRow.finished_at != null) {
      console.log('[fix-p3009] Migration is already recorded as finished (applied). Nothing to do.');
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

  let cmd;
  if (count === TABLES.length) {
    console.log('[fix-p3009] All ecommerce tables exist → marking migration as APPLIED.');
    cmd = `npx prisma migrate resolve --applied ${MIGRATION_NAME}`;
  } else {
    console.log('[fix-p3009] No ecommerce tables → marking migration as ROLLED BACK (safe to re-run deploy).');
    cmd = `npx prisma migrate resolve --rolled-back ${MIGRATION_NAME}`;
  }

  execSync(cmd, { stdio: 'inherit', env: process.env, cwd: require('path').join(__dirname, '..') });
  console.log('[fix-p3009] Done. Run: npx prisma migrate deploy');
}

main().catch((e) => {
  console.error('[fix-p3009]', e.message);
  process.exit(1);
});
