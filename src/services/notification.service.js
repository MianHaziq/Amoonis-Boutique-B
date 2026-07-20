/**
 * In-app notification inbox: persistence + read-state queries.
 *
 * Every push the app sends is also written here (write-through, from the push job)
 * so a user who was offline still sees it and the app can show an unread badge.
 * All writes are best-effort — a failure to persist must never block or fail the
 * actual push, so callers wrap create() in their own try/catch where appropriate.
 */

const prisma = require('../config/db');

/**
 * `userId` XOR `guestEmail` — a guest order's status-change notification is
 * written with `userId: null, guestEmail` set (normalized, matching
 * Order.guestEmail's convention) so it can be claimed later; see
 * order.service.js's `linkGuestOrdersToUser`, which re-points these rows to
 * the account on signup/login.
 */
async function create({ userId, guestEmail, type, title, body, data = null }) {
  return prisma.notification.create({
    data: {
      userId: userId || null,
      guestEmail: userId ? null : guestEmail ? String(guestEmail).trim().toLowerCase() : null,
      type,
      title,
      body,
      data: data || undefined,
    },
  });
}

/**
 * A user's inbox, newest first. `unreadOnly` filters to readAt = null.
 * Returns { data, page, limit, total, totalPages, unreadCount }.
 */
async function list(userId, { page = 1, limit = 20, unreadOnly = false } = {}) {
  const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const where = { userId, ...(unreadOnly ? { readAt: null } : {}) };

  const [rows, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);

  return {
    data: rows,
    page: Math.max(parseInt(page, 10) || 1, 1),
    limit: take,
    total,
    totalPages: Math.ceil(total / take) || 1,
    unreadCount,
  };
}

async function unreadCount(userId) {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

/** Mark one notification read (scoped to the owner). Returns affected count. */
async function markRead(userId, id) {
  const res = await prisma.notification.updateMany({
    where: { id, userId, readAt: null },
    data: { readAt: new Date() },
  });
  return res.count;
}

/** Mark every unread notification for a user as read. Returns affected count. */
async function markAllRead(userId) {
  const res = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return res.count;
}

module.exports = { create, list, unreadCount, markRead, markAllRead };
