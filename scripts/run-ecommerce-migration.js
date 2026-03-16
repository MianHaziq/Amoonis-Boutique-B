/**
 * Apply ecommerce migration SQL manually to avoid "embedded null" error
 * when Prisma reads the file on Windows. Uses pg to run the SQL.
 *
 * Run: node scripts/run-ecommerce-migration.js
 * Then: npx prisma migrate resolve --applied 20260316000000_ecommerce_entities
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');

const migrationPath = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20260316000000_ecommerce_entities',
  'migration.sql'
);

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  let sql = fs.readFileSync(migrationPath, 'utf8');
  sql = sql.replace(/\0/g, '').trim();

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(sql);
    console.log('Migration SQL applied successfully.');
    console.log('Run: npx prisma migrate resolve --applied 20260316000000_ecommerce_entities');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
