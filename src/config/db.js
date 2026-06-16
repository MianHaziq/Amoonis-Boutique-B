const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

// Use singleton pattern
const globalForPrisma = globalThis;

function createPrismaClient() {
  console.log('[DB] Initializing Prisma Client...');

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('[DB] ERROR: DATABASE_URL is not defined!');
    throw new Error('DATABASE_URL environment variable is required');
  }

  console.log('[DB] DATABASE_URL is set, creating adapter...');

  try {
    // Cap the pool explicitly. The pg driver adapter defaults to max=10 and ignores
    // ?connection_limit= in the URL, so without this each process could hold 10 Prisma
    // connections + pg-boss's pool against one Railway Postgres. Budget: PRISMA_POOL_MAX
    // + PGBOSS_POOL_MAX per process must stay under the DB's max_connections.
    const max = Math.max(2, parseInt(process.env.PRISMA_POOL_MAX || '8', 10));
    const adapter = new PrismaPg({ connectionString, max });
    console.log(`[DB] Adapter created successfully (pool max=${max})`);

    const client = new PrismaClient({
      adapter,
      log: process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
    });

    console.log('[DB] Prisma Client created successfully');
    return client;
  } catch (error) {
    console.error('[DB] Failed to create Prisma Client:', error.message);
    throw error;
  }
}

const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

module.exports = prisma;
