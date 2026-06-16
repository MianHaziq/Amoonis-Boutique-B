/**
 * payment.reconcile — recover online payments whose browser callback never arrived.
 *
 * MyFatoorah confirms a payment two ways: the browser redirect back to our callback
 * URL, and a server-to-server webhook. If BOTH are lost (customer closes the app mid-pay,
 * webhook misconfigured/dropped), a genuinely-paid order is stranded in AWAITING_PAYMENT
 * and the customer is charged with no order — silent revenue loss. This scheduled job is
 * the safety net: it re-checks each pending invoice directly with MyFatoorah.
 *
 * Window: only orders older than MIN_AGE minutes (so we don't fight an active checkout —
 * confirmOrderPayment marks a not-yet-paid invoice FAILED) and younger than MAX_AGE hours
 * (old abandoned attempts are handled by order.expire-unpaid). confirmOrderPayment is
 * idempotent, so re-checking an already-settled order is a safe no-op.
 */

const prisma = require('../../config/db');
const orderService = require('../../services/order.service');
const paymentService = require('../../services/payment.service');
const { QUEUES } = require('../queues');

async function handle() {
  if (!paymentService.isConfigured()) return { skipped: 'payment_not_configured' };

  const now = Date.now();
  const minAgeMs = Math.max(1, parseInt(process.env.PAYMENT_RECONCILE_MIN_AGE_MIN || '15', 10)) * 60_000;
  const maxAgeMs = Math.max(1, parseInt(process.env.PAYMENT_RECONCILE_MAX_AGE_HOURS || '24', 10)) * 3_600_000;
  const batch = Math.min(Math.max(parseInt(process.env.PAYMENT_RECONCILE_BATCH || '50', 10), 1), 200);

  const orders = await prisma.order.findMany({
    where: {
      paymentMethod: 'MYFATOORAH',
      status: 'AWAITING_PAYMENT',
      paymentStatus: { in: ['UNPAID', 'FAILED'] },
      paymentInvoiceId: { not: null },
      createdAt: { lte: new Date(now - minAgeMs), gte: new Date(now - maxAgeMs) },
    },
    select: { id: true, paymentInvoiceId: true },
    orderBy: { createdAt: 'asc' },
    take: batch,
  });

  let confirmed = 0;
  let stillPending = 0;
  let failed = 0;

  for (const o of orders) {
    try {
      const res = await orderService.confirmOrderPayment(o.paymentInvoiceId, 'InvoiceId');
      if (res.isPaid) confirmed += 1;
      else stillPending += 1;
    } catch (err) {
      failed += 1;
      console.error(`[jobs] payment.reconcile order ${o.id}:`, err.message);
    }
  }

  if (orders.length > 0) {
    console.log(
      `[jobs] payment.reconcile checked=${orders.length} confirmed=${confirmed} pending=${stillPending} failed=${failed}`
    );
  }
  return { checked: orders.length, confirmed, stillPending, failed };
}

module.exports = {
  queue: QUEUES.PAYMENT_RECONCILE,
  handler: handle,
  cron: process.env.PAYMENT_RECONCILE_CRON || '*/3 * * * *', // every 3 minutes
  options: { retryLimit: 0 }, // it re-runs on the next tick anyway
};
