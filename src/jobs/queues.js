/**
 * Canonical queue names + their default job policies.
 *
 * One place for every background-job identifier so producers (controllers/services)
 * and the worker can never drift on a string. Changing a name here is a breaking
 * change — pg-boss tracks jobs by queue name, so renaming orphans in-flight jobs.
 */

const QUEUES = {
  // JOB-2: shared dead-letter queue. Jobs that exhaust their retries are routed here
  // (instead of vanishing after the archive purge) so failures can be inspected/alerted.
  // It has no worker — landing here is a terminal, visible state.
  DEAD_LETTER: 'dead-letter',

  // On-demand (enqueued from request handlers)
  EMAIL_SEND: 'email.send',
  PUSH_SEND: 'push.send',
  PUSH_BROADCAST: 'push.broadcast',
  ADMIN_ORDER_ALERT: 'order.admin-alert',

  // Scheduled (cron — registered in src/jobs/index.js)
  PAYMENT_RECONCILE: 'payment.reconcile',
  ORDER_EXPIRE_UNPAID: 'order.expire-unpaid',
  INVENTORY_LOW_STOCK: 'inventory.low-stock',
  CLEANUP_RESET_TOKENS: 'cleanup.reset-tokens',
  CLEANUP_REFRESH_TOKENS: 'cleanup.refresh-tokens',
  CLEANUP_NOTIFICATIONS: 'cleanup.notifications',
  CART_ABANDONED: 'cart.abandoned',
  PROMO_ARCHIVE: 'promo.archive-expired',
  PROMO_ANNOUNCE: 'promo.announce-active',
};

// Every scheduled queue, so the UI/status endpoint can report on each even before
// its first run, and so we can de-duplicate stale schedules on boot.
const SCHEDULED_QUEUES = [
  QUEUES.PAYMENT_RECONCILE,
  QUEUES.ORDER_EXPIRE_UNPAID,
  QUEUES.INVENTORY_LOW_STOCK,
  QUEUES.CLEANUP_RESET_TOKENS,
  QUEUES.CLEANUP_REFRESH_TOKENS,
  QUEUES.CLEANUP_NOTIFICATIONS,
  QUEUES.CART_ABANDONED,
  QUEUES.PROMO_ARCHIVE,
  QUEUES.PROMO_ANNOUNCE,
];

const ALL_QUEUES = Object.values(QUEUES);

module.exports = { QUEUES, SCHEDULED_QUEUES, ALL_QUEUES };
