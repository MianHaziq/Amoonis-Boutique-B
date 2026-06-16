/**
 * Standalone background-job worker.
 *
 * By default the API process runs the job engine in-process (see server.js), which is
 * all a single Railway service needs at this scale. To scale the worker independently,
 * set JOBS_IN_PROCESS=false on the API service and deploy a SECOND service from this
 * same repo with start command `node worker.js`. Both point at the same DATABASE_URL;
 * pg-boss coordinates through Postgres so jobs are never processed twice.
 */

require('dotenv').config();

const { validateEnv } = require('./src/config/env');
try {
  validateEnv();
} catch (e) {
  console.error('[WORKER] Environment validation failed:', e.message);
  process.exit(1);
}

const prisma = require('./src/config/db');
const { startJobs, stopJobs } = require('./src/jobs');

process.on('unhandledRejection', (reason) => console.error('[WORKER] Unhandled Rejection:', reason));
// On an uncaught exception the process state is unknown — exit and let Railway restart
// a clean worker rather than keep processing jobs in a possibly-corrupt state.
process.on('uncaughtException', (err) => {
  console.error('[WORKER] Uncaught Exception:', err);
  process.exit(1);
});

(async () => {
  console.log('[WORKER] Starting Amoon Bloom job worker...');
  const ok = await startJobs();
  if (!ok) {
    console.error('[WORKER] Job engine failed to start (check DATABASE_URL / JOBS_ENABLED). Exiting.');
    process.exit(1);
  }
  console.log('[WORKER] Job worker ready — processing queues.');
})();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[WORKER] ${signal} received — shutting down...`);
  try {
    await stopJobs();
    await prisma.$disconnect();
  } catch (err) {
    console.error('[WORKER] shutdown error:', err.message);
  }
  setTimeout(() => process.exit(0), 10000).unref();
  process.exit(0);
}
['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => shutdown(sig)));
