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

/** Order placed (checkout for COD, or payment success for online). */
function orderPlaced(userId, orderId) {
  return enqueue(QUEUES.PUSH_SEND, {
    userId,
    prefKey: 'orderStatus',
    type: 'ORDER_PLACED',
    copyKey: 'ORDER_PLACED',
    data: { type: 'ORDER_PLACED', orderId, status: 'PENDING' },
  });
}

/** Order moved to a new lifecycle status by staff (CONFIRMED…CANCELLED). */
function orderStatusChange(userId, orderId, status) {
  // PENDING is already covered by the "order placed" push.
  if (status === 'PENDING') return Promise.resolve(null);
  return enqueue(QUEUES.PUSH_SEND, {
    userId,
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
function adminNewOrder({ orderId, totalAmount, currency, buyerId } = {}) {
  if (!orderId) return Promise.resolve(null);
  return enqueue(QUEUES.ADMIN_ORDER_ALERT, {
    orderId,
    totalAmount,
    currency: currency || 'AED',
    buyerId: buyerId || null,
  });
}

/** Order confirmation email (best-effort; queued with retries). */
function orderConfirmationEmail(order) {
  if (!order || !order.userEmail) return Promise.resolve(null);
  return enqueue(QUEUES.EMAIL_SEND, {
    template: 'order-confirmation',
    to: order.userEmail,
    order: {
      id: order.id,
      orderNumber: order.orderNumber || order.id,
      totalAmount: order.totalAmount,
      currency: order.currency || 'AED',
    },
  });
}

/** Generic transactional email (e.g. password reset). */
function email(to, subject, html) {
  return enqueue(QUEUES.EMAIL_SEND, { to, subject, html });
}

module.exports = { orderPlaced, orderStatusChange, adminNewOrder, orderConfirmationEmail, email };
