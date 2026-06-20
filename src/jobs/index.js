/**
 * Job system bootstrap. Imported by both the API process (server.js, in-process
 * worker) and the standalone worker.js. Registers every handler, starts the engine,
 * then installs cron schedules.
 *
 * Adding a job = create a handler module that exports { queue, handler, options?, cron? }
 * (or an array of them) and add it to `defs` below. Nothing else to wire.
 */

const queue = require('./queue');

const defs = [
  require('./handlers/email.job'),
  require('./handlers/push.job'),
  require('./handlers/broadcast.job'),
  require('./handlers/adminOrderAlert.job'),
  require('./handlers/paymentReconcile.job'),
  require('./handlers/orderExpire.job'),
  require('./handlers/lowStock.job'),
  require('./handlers/promoAnnounce.job'),
  require('./handlers/cleanup.job'), // array of housekeeping defs
].flat();

let started = false;

/**
 * Register handlers, start the engine, schedule cron jobs. Never throws — if the
 * engine can't start, enqueue() transparently falls back to inline execution.
 * Returns true if the durable engine came up, false if degraded to inline-only.
 */
async function startJobs() {
  if (started) return queue.isReady();
  started = true;

  for (const def of defs) {
    queue.register(def.queue, def.handler, def.options || {});
  }

  const ok = await queue.start();
  if (!ok) return false;

  const boss = queue.getBoss();
  for (const def of defs) {
    if (!def.cron) continue;
    try {
      // Idempotent: re-scheduling the same queue updates its cron, so a deploy that
      // changes a schedule just takes effect on next boot.
      await boss.schedule(def.queue, def.cron, {}, def.options || {});
    } catch (err) {
      console.error(`[jobs] failed to schedule ${def.queue}:`, err.message);
    }
  }

  const scheduled = defs.filter((d) => d.cron).map((d) => `${d.queue}(${d.cron})`);
  console.log(`[jobs] scheduled: ${scheduled.join(', ') || 'none'}`);
  return true;
}

async function stopJobs() {
  await queue.stop();
  started = false;
}

// Metadata for the admin status endpoint.
function listDefs() {
  return defs.map((d) => ({ queue: d.queue, cron: d.cron || null, scheduled: Boolean(d.cron) }));
}

module.exports = { startJobs, stopJobs, listDefs };
