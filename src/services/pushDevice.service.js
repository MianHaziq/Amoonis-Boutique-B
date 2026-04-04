const { randomUUID } = require('crypto');
const prisma = require('../config/db');

const PLATFORMS = new Set(['IOS', 'ANDROID', 'WEB']);

function normalizePlatform(value) {
  if (value == null || String(value).trim() === '') return 'ANDROID';
  const p = String(value).trim().toUpperCase();
  return PLATFORMS.has(p) ? p : 'ANDROID';
}

/**
 * Register or refresh an FCM device token for the current user.
 * If the token was registered to another account, it is moved to this user.
 */
async function registerDevice(userId, fcmToken, platformInput) {
  const token = String(fcmToken || '').trim();
  if (!token) {
    return { device: null, error: 'fcmToken is required' };
  }
  const platform = normalizePlatform(platformInput);

  const existing = await prisma.userPushDevice.findUnique({
    where: { fcmToken: token },
  });
  if (existing && existing.userId !== userId) {
    await prisma.userPushDevice.delete({ where: { id: existing.id } });
  }

  const device = await prisma.userPushDevice.upsert({
    where: { fcmToken: token },
    create: {
      id: randomUUID(),
      userId,
      fcmToken: token,
      platform,
    },
    update: {
      userId,
      platform,
    },
  });

  return { device, error: null };
}

async function removeDeviceByToken(userId, fcmToken) {
  const token = String(fcmToken || '').trim();
  if (!token) return { removed: false, error: 'fcmToken is required' };
  const result = await prisma.userPushDevice.deleteMany({
    where: { userId, fcmToken: token },
  });
  return { removed: result.count > 0, error: null };
}

async function listTokensForUser(userId) {
  const rows = await prisma.userPushDevice.findMany({
    where: { userId },
    select: { fcmToken: true },
  });
  return rows.map((r) => r.fcmToken);
}

async function deleteInvalidToken(fcmToken) {
  await prisma.userPushDevice.deleteMany({ where: { fcmToken } });
}

module.exports = {
  registerDevice,
  removeDeviceByToken,
  listTokensForUser,
  deleteInvalidToken,
  normalizePlatform,
};
