/**
 * order.expire-unpaid — cancel online orders that were never paid.
 *
 * An online (MyFatoorah) order sits in AWAITING_PAYMENT until payment succeeds. As of the
 * stock-reservation change (H1) it HAS reserved (deducted) stock at placement, so cancelling
 * it must RESTORE that stock. If it's still unpaid after ORDER_EXPIRE_HOURS we cancel it so it
 * stops being reconciled and stops holding both stock and a payment invoice. Each order is
 * cancelled in its own row-locked transaction (SELECT ... FOR UPDATE re-checks status +
 * paymentStatus) so an order that just got paid is never cancelled. No push is sent — the
 * customer never completed checkout, so a "cancelled" notice would confuse.
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

  const candidates = await prisma.order.findMany({
    where: {
      status: 'AWAITING_PAYMENT',
      paymentStatus: { in: ['UNPAID', 'FAILED'] },
      createdAt: { lt: cutoff },
    },
    select: { id: true },
  });

  let cancelled = 0;
  for (const { id } of candidates) {
    try {
      const done = await prisma.$transaction(async (tx) => {
        // Lock + re-check inside the tx: an order that just got paid (status/paymentStatus
        // changed) no longer matches and is skipped — we never cancel a paid order.
        const locked = await tx.$queryRaw`
          SELECT id, "inventoryDeducted" FROM "Order"
          WHERE id::text = ${id}
            AND status = 'AWAITING_PAYMENT'
            AND "paymentStatus" IN ('UNPAID', 'FAILED')
          FOR UPDATE`;
        if (!Array.isArray(locked) || locked.length === 0) return false;

        // Restore the stock reserved at placement (H1) before cancelling.
        if (locked[0].inventoryDeducted) {
          await tx.$executeRaw`
            UPDATE "Product" AS p
            SET quantity = p.quantity + sub.sum_qty
            FROM (
              SELECT "productId", SUM(quantity)::int AS sum_qty
              FROM "OrderItem"
              WHERE "orderId"::text = ${id}
              GROUP BY "productId"
            ) AS sub
            WHERE p.id = sub."productId"`;
        }

        await tx.order.update({
          where: { id },
          data: { status: 'CANCELLED', inventoryDeducted: false },
        });
        return true;
      });
      if (done) cancelled += 1;
    } catch (err) {
      console.error(`[jobs] order.expire-unpaid failed to cancel order ${id}: ${err.message}`);
    }
  }

  if (cancelled > 0) console.log(`[jobs] order.expire-unpaid cancelled=${cancelled}`);
  return { cancelled };
}

module.exports = {
  queue: QUEUES.ORDER_EXPIRE_UNPAID,
  handler: handle,
  cron: process.env.ORDER_EXPIRE_CRON || '*/15 * * * *', // every 15 minutes
  options: { retryLimit: 0 },
};
