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
    const adapter = new PrismaPg({ connectionString });
    console.log('[DB] Adapter created successfully');

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
