/**
 * order.admin-alert — notify staff (ADMIN + MANAGER) that a customer placed an order.
 *
 * Data: { orderId, orderNumber?, totalAmount?, currency?, buyerId? }
 *
 * Recipients: every active ADMIN, plus MANAGERs who hold the `ORDERS` permission —
 * managers without it can't open the order screen, so alerting them would be noise that
 * deep-links into a screen they can't access.
 *
 * Fans out one push.send job per recipient. These are OPERATIONAL alerts (prefKey: null)
 * so they bypass the staff member's personal customer notification preferences — an admin
 * can't accidentally silence new-order alerts by turning off their own "order updates"
 * toggle. The push carries `type: ORDER_PLACED` so the app routes admins/managers to the
 * admin order screen (it branches on the logged-in role).
 *
 * The buyer is excluded so an admin who places an order as a customer doesn't get both
 * the customer push and the staff alert.
 */

const prisma = require('../../config/db');
const { enqueueMany } = require('../queue');
const { QUEUES } = require('../queues');

function shortRef(orderId) {
  return String(orderId).slice(0, 8).toUpperCase();
}

async function handle(data) {
  const { orderId, orderNumber, totalAmount, currency = 'AED', buyerId } = data;
  if (!orderId) {
    console.warn('[jobs] order.admin-alert skipped — no orderId');
    return { enqueued: 0 };
  }
  // Prefer the human-friendly sequential number; fall back to a short id slice for any
  // legacy order placed before order numbers existed.
  const ref = orderNumber != null ? `#${orderNumber}` : `#${shortRef(orderId)}`;

  const staff = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      ...(buyerId ? { id: { not: buyerId } } : {}),
      OR: [
        { role: 'ADMIN' },
        { role: 'MANAGER', managerPermissions: { has: 'ORDERS' } },
      ],
    },
    select: { id: true },
  });
  if (staff.length === 0) return { enqueued: 0 };

  const amount = totalAmount != null ? ` — ${Number(totalAmount)} ${currency}` : '';
  const title = 'New Order';
  const body = `Order ${ref} placed${amount}.`;

  const jobs = staff.map((u) => ({
    data: {
      userId: u.id,
      prefKey: null, // operational — always delivered to staff
      type: 'ORDER_PLACED',
      title,
      body,
      data: { type: 'ORDER_PLACED', orderId, status: 'PENDING' },
    },
  }));

  const enqueued = await enqueueMany(QUEUES.PUSH_SEND, jobs);
  console.log(`[jobs] order.admin-alert order=${orderId} staff=${staff.length} enqueued=${enqueued}`);
  return { enqueued };
}

module.exports = {
  queue: QUEUES.ADMIN_ORDER_ALERT,
  handler: handle,
  // A few retries: the staff list is tiny and these alerts are operationally important.
  options: { retryLimit: 2, retryDelay: 10, retryBackoff: true },
};
