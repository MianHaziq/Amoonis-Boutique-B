/**
 * Housekeeping jobs — keep tables from growing unbounded and purge sensitive,
 * expired data. Each exports its own queue, so this file returns an ARRAY of job
 * definitions (src/jobs/index.js accepts arrays).
 */

const prisma = require('../../config/db');
const { QUEUES } = require('../queues');

// Null out expired password-reset tokens so a leaked DB snapshot can't be used to
// reset a password with a long-dead token, and the column stays clean.
async function cleanupResetTokens() {
  const res = await prisma.user.updateMany({
    where: { resetTokenExpiry: { lt: new Date() } },
    data: { resetToken: null, resetTokenExpiry: null },
  });
  if (res.count > 0) console.log(`[jobs] cleanup.reset-tokens cleared=${res.count}`);
  return { cleared: res.count };
}

// Delete refresh tokens that are expired (unusable) or were revoked long enough ago
// that they no longer need to exist for audit/rotation.
async function cleanupRefreshTokens() {
  const retainDays = Math.max(1, parseInt(process.env.REFRESH_TOKEN_RETAIN_DAYS || '7', 10));
  const revokedCutoff = new Date(Date.now() - retainDays * 86_400_000);
  const res = await prisma.refreshToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: revokedCutoff } }],
    },
  });
  if (res.count > 0) console.log(`[jobs] cleanup.refresh-tokens deleted=${res.count}`);
  return { deleted: res.count };
}

// Clear cart items untouched for CART_ABANDON_DAYS so stale carts don't accumulate.
async function cleanupAbandonedCarts() {
  const days = Math.max(1, parseInt(process.env.CART_ABANDON_DAYS || '30', 10));
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const res = await prisma.cartItem.deleteMany({ where: { updatedAt: { lt: cutoff } } });
  if (res.count > 0) console.log(`[jobs] cart.abandoned items_deleted=${res.count}`);
  return { deleted: res.count };
}

// Prune the in-app notification inbox so it doesn't grow without bound. Read
// notifications are deleted after NOTIFICATION_RETAIN_DAYS; unread ones are kept much
// longer (NOTIFICATION_UNREAD_RETAIN_DAYS) so a user who hasn't opened the app still
// sees them, but are eventually purged too. Deletes in capped batches to avoid a single
// huge statement locking the table.
async function cleanupNotifications() {
  const readDays = Math.max(1, parseInt(process.env.NOTIFICATION_RETAIN_DAYS || '90', 10));
  const unreadDays = Math.max(readDays, parseInt(process.env.NOTIFICATION_UNREAD_RETAIN_DAYS || '180', 10));
  const readCutoff = new Date(Date.now() - readDays * 86_400_000);
  const unreadCutoff = new Date(Date.now() - unreadDays * 86_400_000);

  const where = {
    OR: [
      { readAt: { not: null }, createdAt: { lt: readCutoff } },
      { createdAt: { lt: unreadCutoff } },
    ],
  };

  // JOB-3: delete in capped batches (select ids, then delete by id) so the first run on a
  // large table doesn't take one long table-locking statement. Loop until a short batch.
  const BATCH = Math.max(500, parseInt(process.env.NOTIFICATION_CLEANUP_BATCH || '5000', 10));
  let deleted = 0;
  for (;;) {
    const rows = await prisma.notification.findMany({ where, select: { id: true }, take: BATCH });
    if (rows.length === 0) break;
    const res = await prisma.notification.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    deleted += res.count;
    if (rows.length < BATCH) break;
  }
  if (deleted > 0) console.log(`[jobs] cleanup.notifications deleted=${deleted}`);
  return { deleted };
}

// Deactivate promo codes whose expiry has passed so they drop out of active lookups.
async function archiveExpiredPromos() {
  const res = await prisma.promoCode.updateMany({
    where: { isActive: true, expiresAt: { lt: new Date() } },
    data: { isActive: false },
  });
  if (res.count > 0) console.log(`[jobs] promo.archive-expired deactivated=${res.count}`);
  return { deactivated: res.count };
}

module.exports = [
  {
    queue: QUEUES.CLEANUP_RESET_TOKENS,
    handler: cleanupResetTokens,
    cron: process.env.CLEANUP_RESET_TOKENS_CRON || '0 3 * * *', // daily 03:00 (JOBS_TIMEZONE, default Asia/Dubai)
    options: { retryLimit: 0 },
  },
  {
    queue: QUEUES.CLEANUP_REFRESH_TOKENS,
    handler: cleanupRefreshTokens,
    cron: process.env.CLEANUP_REFRESH_TOKENS_CRON || '15 3 * * *', // daily 03:15 (JOBS_TIMEZONE, default Asia/Dubai)
    options: { retryLimit: 0 },
  },
  {
    queue: QUEUES.CART_ABANDONED,
    handler: cleanupAbandonedCarts,
    cron: process.env.CART_ABANDONED_CRON || '30 3 * * *', // daily 03:30 (JOBS_TIMEZONE, default Asia/Dubai)
    options: { retryLimit: 0 },
  },
  {
    queue: QUEUES.CLEANUP_NOTIFICATIONS,
    handler: cleanupNotifications,
    cron: process.env.CLEANUP_NOTIFICATIONS_CRON || '50 3 * * *', // daily 03:50 (JOBS_TIMEZONE, default Asia/Dubai)
    options: { retryLimit: 0 },
  },
  {
    queue: QUEUES.PROMO_ARCHIVE,
    handler: archiveExpiredPromos,
    cron: process.env.PROMO_ARCHIVE_CRON || '45 3 * * *', // daily 03:45 (JOBS_TIMEZONE, default Asia/Dubai)
    options: { retryLimit: 0 },
  },
];
