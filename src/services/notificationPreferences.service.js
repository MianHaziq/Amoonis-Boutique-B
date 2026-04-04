const prisma = require('../config/db');

const DEFAULTS = {
  orderStatus: true,
  promotions: true,
  announcements: true,
};

async function getOrCreate(userId) {
  let row = await prisma.userNotificationPreferences.findUnique({
    where: { userId },
  });
  if (!row) {
    row = await prisma.userNotificationPreferences.create({
      data: { userId, ...DEFAULTS },
    });
  }
  return {
    orderStatus: row.orderStatus,
    promotions: row.promotions,
    announcements: row.announcements,
    updatedAt: row.updatedAt,
  };
}

async function update(userId, body) {
  await getOrCreate(userId);
  const data = {};
  if (typeof body.orderStatus === 'boolean') data.orderStatus = body.orderStatus;
  if (typeof body.promotions === 'boolean') data.promotions = body.promotions;
  if (typeof body.announcements === 'boolean') data.announcements = body.announcements;
  if (Object.keys(data).length === 0) {
    return getOrCreate(userId);
  }
  const row = await prisma.userNotificationPreferences.update({
    where: { userId },
    data,
  });
  return {
    orderStatus: row.orderStatus,
    promotions: row.promotions,
    announcements: row.announcements,
    updatedAt: row.updatedAt,
  };
}

module.exports = { getOrCreate, update, DEFAULTS };
