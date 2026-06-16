/**
 * order.expire-unpaid — cancel online orders that were never paid.
 *
 * An online (MyFatoorah) order sits in AWAITING_PAYMENT until payment succeeds; it has
 * NOT deducted stock and is hidden from the customer's history. If it's still unpaid
 * after ORDER_EXPIRE_HOURS we cancel it so it stops being reconciled and stops holding
 * a payment invoice. The updateMany guard (status + paymentStatus) makes this race-safe:
 * an order that just got paid no longer matches, so we never cancel a paid order. No push
 * is sent — the customer never completed checkout, so a "cancelled" notice would confuse.
 */

const prisma = require('../../config/db');
const { QUEUES } = require('../queues');

async function handle() {
  // Must stay strictly LARGER than PAYMENT_RECONCILE_MAX_AGE_HOURS (default 24h) so the
  // reconciler always gets a chance to confirm a stranded-but-paid order before we cancel
  // it. Otherwise a late payment confirmation could land on an already-cancelled order
  // (→ "PAID but CANCELLED, manual refund").
  const reconcileMaxAge = Math.max(1, parseInt(process.env.PAYMENT_RECONCILE_MAX_AGE_HOURS || '24', 10));
  const configured = Math.max(1, parseInt(process.env.ORDER_EXPIRE_HOURS || '48', 10));
  const hours = Math.max(configured, reconcileMaxAge + 6);
  const cutoff = new Date(Date.now() - hours * 3_600_000);

  const res = await prisma.order.updateMany({
    where: {
      status: 'AWAITING_PAYMENT',
      paymentStatus: { in: ['UNPAID', 'FAILED'] },
      createdAt: { lt: cutoff },
    },
    data: { status: 'CANCELLED' },
  });

  if (res.count > 0) console.log(`[jobs] order.expire-unpaid cancelled=${res.count}`);
  return { cancelled: res.count };
}

module.exports = {
  queue: QUEUES.ORDER_EXPIRE_UNPAID,
  handler: handle,
  cron: process.env.ORDER_EXPIRE_CRON || '*/15 * * * *', // every 15 minutes
  options: { retryLimit: 0 },
};
