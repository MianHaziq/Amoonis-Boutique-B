/**
 * Notification dispatch — the API services/controllers call THIS, not FCM/SMTP
 * directly. Each function enqueues a durable background job (with retries); if the
 * job engine is down, queue.enqueue() runs the work inline so nothing is lost.
 *
 * Keeping every "what to notify" decision here means request handlers stay free of
 * notification mechanics, and copy/i18n/persistence all live behind the push job.
 */

const { enqueue } = require('../jobs/queue');
const { QUEUES } = require('../jobs/queues');

/**
 * Order placed (checkout for COD, or payment success for online). Exactly one
 * of `userId`/`guestEmail` should be set — a guest order gets an inbox row
 * (no device to push to) that `linkGuestOrdersToUser` claims on signup/login.
 */
function orderPlaced({ userId, guestEmail, orderId } = {}) {
  if (!userId && !guestEmail) return Promise.resolve(null);
  return enqueue(QUEUES.PUSH_SEND, {
    userId: userId || undefined,
    guestEmail: userId ? undefined : guestEmail,
    prefKey: 'orderStatus',
    type: 'ORDER_PLACED',
    copyKey: 'ORDER_PLACED',
    data: { type: 'ORDER_PLACED', orderId, status: 'PENDING_PAYMENT' },
  });
}

/**
 * Order moved to a new lifecycle status by staff (PROCESSING…CANCELLED/REFUNDED/etc.).
 * Same userId/guestEmail contract as orderPlaced above.
 */
function orderStatusChange({ userId, guestEmail, orderId, status } = {}) {
  // PENDING_PAYMENT is already covered by the "order placed" push.
  if (status === 'PENDING_PAYMENT') return Promise.resolve(null);
  if (!userId && !guestEmail) return Promise.resolve(null);
  return enqueue(QUEUES.PUSH_SEND, {
    userId: userId || undefined,
    guestEmail: userId ? undefined : guestEmail,
    prefKey: 'orderStatus',
    type: 'ORDER_STATUS',
    status,
    data: { type: 'ORDER_STATUS', orderId, status },
  });
}

/**
 * Notify staff (ADMIN + MANAGER) that a customer placed an order. Operational alert —
 * not gated by the staff member's personal notification preferences. `buyerId` is
 * excluded so an admin buying as a customer isn't notified twice.
 */
function adminNewOrder({ orderId, orderNumber, totalAmount, currency, buyerId } = {}) {
  if (!orderId) return Promise.resolve(null);
  return enqueue(QUEUES.ADMIN_ORDER_ALERT, {
    orderId,
    orderNumber: orderNumber ?? null,
    totalAmount,
    currency: currency || 'AED',
    buyerId: buyerId || null,
  });
}

/**
 * Order confirmation email (best-effort; queued with retries). Only the orderId + email
 * are passed — the email.send job loads the full order (items, shipping, payment status)
 * from the DB at send time, so the rich template can never drift from how callers happen
 * to shape their in-memory order object.
 */
function orderConfirmationEmail({ orderId, to } = {}) {
  if (!orderId || !to) return Promise.resolve(null);
  return enqueue(QUEUES.EMAIL_SEND, { template: 'order-confirmation', orderId, to });
}

// Only these lifecycle transitions get a customer-facing status email — matches the
// site's three "moments that matter": placed (orderConfirmationEmail, above), processing,
// completed. ON_HOLD/CANCELLED/REFUNDED/FAILED are covered by push/in-app only.
const STATUS_EMAIL_STATUSES = new Set(['PROCESSING', 'COMPLETED']);

/**
 * Order status-change email (Processing / Completed). No `to` here — the email.send job
 * resolves the recipient itself (user's account email, or the guest's email) so this
 * fires the same way for a guest order as a signed-in one; the job silently no-ops if
 * the order somehow has neither.
 */
function orderStatusEmail(orderId, status) {
  if (!orderId || !STATUS_EMAIL_STATUSES.has(status)) return Promise.resolve(null);
  return enqueue(QUEUES.EMAIL_SEND, { template: 'order-status', orderId, status });
}

/** Generic transactional email (e.g. password reset). */
function email(to, subject, html) {
  return enqueue(QUEUES.EMAIL_SEND, { to, subject, html });
}

module.exports = {
  orderPlaced,
  orderStatusChange,
  adminNewOrder,
  orderConfirmationEmail,
  orderStatusEmail,
  email,
};
