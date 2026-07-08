// Match the exact dotenv pattern used by server.js/worker.js (require('dotenv/config')
// resolves differently — and fails — inside Prisma's config loader in the Docker build).
require('dotenv').config();
const { defineConfig } = require('prisma/config');

module.exports = defineConfig({
  earlyAccess: true,
  schema: 'prisma/schema.prisma',
  migrate: {
    migrations: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
