/**
 * Per-user push notification channel preferences (orderStatus / promotions /
 * announcements). A row is created lazily with all channels ON the first time a user's
 * preferences are read or a notification is sent to them.
 *
 * Reads and writes are concurrency-safe: `userId` is the primary key, so a naive
 * find-then-create races (two simultaneous pushes for a brand-new user would both
 * INSERT and the second would hit a unique-constraint error). getOrCreate tolerates
 * that race, and update() uses a single atomic upsert.
 */

const prisma = require('../config/db');

const DEFAULTS = {
  orderStatus: true,
  promotions: true,
  announcements: true,
};

function shape(row) {
  return {
    orderStatus: row.orderStatus,
    promotions: row.promotions,
    announcements: row.announcements,
    updatedAt: row.updatedAt,
  };
}

async function getOrCreate(userId) {
  const existing = await prisma.userNotificationPreferences.findUnique({ where: { userId } });
  if (existing) return shape(existing);

  // No row yet — create with defaults. If a concurrent request created it first
  // (P2002 on the userId PK), fall back to reading the now-existing row rather than
  // failing the caller. Reads must never bump updatedAt, so we don't upsert here.
  try {
    const row = await prisma.userNotificationPreferences.create({ data: { userId, ...DEFAULTS } });
    return shape(row);
  } catch (e) {
    if (e && e.code === 'P2002') {
      const row = await prisma.userNotificationPreferences.findUnique({ where: { userId } });
      if (row) return shape(row);
    }
    throw e;
  }
}

async function update(userId, body) {
  const data = {};
  if (typeof body.orderStatus === 'boolean') data.orderStatus = body.orderStatus;
  if (typeof body.promotions === 'boolean') data.promotions = body.promotions;
  if (typeof body.announcements === 'boolean') data.announcements = body.announcements;

  if (Object.keys(data).length === 0) {
    return getOrCreate(userId);
  }

  // Single atomic write: create the row (defaults + the requested changes) if it
  // doesn't exist yet, otherwise apply just the changed channels.
  const row = await prisma.userNotificationPreferences.upsert({
    where: { userId },
    create: { userId, ...DEFAULTS, ...data },
    update: data,
  });
  return shape(row);
}

module.exports = { getOrCreate, update, DEFAULTS };
