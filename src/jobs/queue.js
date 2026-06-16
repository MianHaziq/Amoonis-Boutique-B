/**
 * Background-job engine (pg-boss on the existing PostgreSQL database).
 *
 * Why pg-boss: zero extra infrastructure — it stores jobs in our own Postgres
 * (a dedicated `pgboss` schema), so on a single Railway service there is no Redis
 * to run or pay for. It gives us durable queues, automatic retries with backoff,
 * dead-letter handling and cron scheduling, coordinated through the database so
 * running more than one instance never double-processes a job.
 *
 * Design goals (production / ~2k users a day):
 *   - The API must boot even if the job engine can't start. start() never throws;
 *     a failure is logged and the app keeps serving traffic.
 *   - Work is never silently lost. enqueue() falls back to running the handler
 *     INLINE when the engine is unavailable, so e.g. a password-reset email still
 *     goes out during a brief queue outage.
 *   - Small, bounded Postgres connection use — the job pool is separate from
 *     Prisma's, so we cap it low to stay well under Railway's connection limit.
 */

const PgBoss = require('pg-boss');

let boss = null;
let ready = false;
let startPromise = null;

// queueName -> { handler, options } registered by src/jobs/index.js. Used both to
// wire pg-boss workers and to power the INLINE fallback in enqueue().
const registry = new Map();

function isEnabled() {
  // Allow ops to fully disable the engine without code changes.
  return process.env.JOBS_ENABLED !== 'false';
}

function isReady() {
  return ready;
}

function getBoss() {
  return ready ? boss : null;
}

function buildBoss() {
  return new PgBoss({
    connectionString: process.env.DATABASE_URL,
    schema: process.env.PGBOSS_SCHEMA || 'pgboss',
    application_name: 'amoon-bloom-jobs',
    // Keep the job pool small — Prisma already holds its own pool against the same
    // database, and Railway Postgres has a modest connection ceiling.
    max: Math.max(2, parseInt(process.env.PGBOSS_POOL_MAX || '4', 10)),
    // Archive completed jobs after a day, purge the archive after a week. Enough
    // history for the admin UI without growing the table unbounded.
    archiveCompletedAfterSeconds: 60 * 60 * 24,
    deleteAfterDays: 7,
  });
}

/**
 * Register a queue's worker + default job options. Called by src/jobs/index.js for
 * every handler BEFORE start(). `options` are pg-boss work/send options
 * (retryLimit, retryDelay, retryBackoff, ...). `concurrency` controls how many jobs
 * this worker pulls at once.
 */
function register(queueName, handler, options = {}) {
  if (registry.has(queueName)) {
    throw new Error(`[jobs] queue "${queueName}" registered twice`);
  }
  registry.set(queueName, { handler, options });
}

function getRegistry() {
  return registry;
}

/**
 * Boot the engine: connect, create every registered queue, attach workers.
 * Idempotent and never throws — returns true on success, false if it degraded to
 * inline-only mode. Scheduling of cron jobs is done by the caller (index.js) after
 * this resolves so queues exist first.
 */
async function start() {
  if (!isEnabled()) {
    console.log('[jobs] disabled via JOBS_ENABLED=false — enqueue() will run inline');
    return false;
  }
  if (ready) return true;
  if (startPromise) return startPromise;

  startPromise = (async () => {
    try {
      boss = buildBoss();
      boss.on('error', (err) => console.error('[jobs] pg-boss error:', err.message));
      await boss.start();

      for (const [queueName, { handler, options }] of registry.entries()) {
        await boss.createQueue(queueName);
        const workOptions = {
          batchSize: options.batchSize || 1,
          pollingIntervalSeconds: options.pollingIntervalSeconds || 2,
        };
        await boss.work(queueName, workOptions, async (jobs) => {
          // pg-boss v10 always delivers an array; run them sequentially so a single
          // worker stays gentle on the DB and on third-party rate limits.
          const arr = Array.isArray(jobs) ? jobs : [jobs];
          for (const job of arr) {
            await handler(job.data || {}, job);
          }
        });
      }

      ready = true;
      console.log(`[jobs] engine started — ${registry.size} queue(s) active`);
      return true;
    } catch (err) {
      console.error('[jobs] failed to start engine — falling back to inline execution:', err.message);
      ready = false;
      boss = null;
      return false;
    }
  })();

  return startPromise;
}

/**
 * Enqueue a job. If the engine is up it's persisted and processed by a worker with
 * retries. If the engine is unavailable, the work runs INLINE so nothing is lost.
 * The inline fallback is fire-and-forget (NOT awaited): it runs in the background
 * with a .catch logger so a queue outage never couples HTTP request latency to slow
 * FCM/SMTP calls. Callers that don't want any inline fallback can pass
 * { allowInlineFallback: false }.
 *
 * Returns the job id (queued), 'inline' (scheduled to run inline), or null
 * (dropped/failed). The 'inline' return resolves immediately — it does not wait for
 * the handler to finish.
 */
async function enqueue(queueName, data = {}, options = {}) {
  const { allowInlineFallback = true, ...sendOptions } = options;
  const entry = registry.get(queueName);

  if (ready && boss) {
    try {
      const defaults = entry ? entry.options : {};
      const id = await boss.send(queueName, data, {
        retryLimit: defaults.retryLimit ?? 5,
        retryDelay: defaults.retryDelay ?? 30,
        retryBackoff: defaults.retryBackoff ?? true,
        ...sendOptions,
      });
      return id;
    } catch (err) {
      console.error(`[jobs] enqueue "${queueName}" failed:`, err.message);
      // fall through to inline
    }
  }

  if (allowInlineFallback && entry) {
    // Fire-and-forget: run the handler in the background so the caller's request is
    // not blocked on FCM/SMTP during a queue outage. Errors are logged, never thrown.
    Promise.resolve()
      .then(() => entry.handler(data, { id: 'inline', data }))
      .catch((err) => console.error(`[jobs] inline "${queueName}" failed:`, err.message));
    return 'inline';
  }

  if (!entry) console.error(`[jobs] enqueue for unknown queue "${queueName}"`);
  return null;
}

/**
 * Enqueue many jobs for a single queue in one durable batch insert (pg-boss v10
 * `insert`), instead of one `send` per job. Used by high-fan-out producers like the
 * broadcast handler so we issue a handful of multi-row inserts rather than thousands
 * of single-row ones.
 *
 * Per-job options default to the queue's registered retry settings; `jobs` may
 * override per item. If the engine isn't ready it falls back to enqueue() per job so
 * the inline path still applies. Returns the number of jobs inserted/enqueued.
 */
async function enqueueMany(queueName, jobs = [], options = {}) {
  if (!Array.isArray(jobs) || jobs.length === 0) return 0;
  const entry = registry.get(queueName);
  const defaults = entry ? entry.options : {};

  if (ready && boss) {
    try {
      const rows = jobs.map((j) => ({
        name: queueName,
        data: j.data ?? {},
        retryLimit: j.retryLimit ?? options.retryLimit ?? defaults.retryLimit ?? 5,
        retryDelay: j.retryDelay ?? options.retryDelay ?? defaults.retryDelay ?? 30,
        retryBackoff: j.retryBackoff ?? options.retryBackoff ?? defaults.retryBackoff ?? true,
      }));
      await boss.insert(rows);
      return rows.length;
    } catch (err) {
      console.error(`[jobs] enqueueMany "${queueName}" failed:`, err.message);
      // fall through to per-job enqueue (which itself handles inline fallback)
    }
  }

  let count = 0;
  for (const j of jobs) {
    const id = await enqueue(queueName, j.data ?? {}, options);
    if (id) count += 1;
  }
  return count;
}

async function stop() {
  if (boss && ready) {
    try {
      await boss.stop({ graceful: true, timeout: 8000 });
    } catch (err) {
      console.error('[jobs] error during stop:', err.message);
    }
  }
  ready = false;
  boss = null;
  startPromise = null;
}

module.exports = {
  register,
  start,
  stop,
  enqueue,
  enqueueMany,
  isEnabled,
  isReady,
  getBoss,
  getRegistry,
};
