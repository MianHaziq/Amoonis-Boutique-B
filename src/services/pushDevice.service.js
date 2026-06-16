const { randomUUID } = require('crypto');
const prisma = require('../config/db');

const PLATFORMS = new Set(['IOS', 'ANDROID', 'WEB']);

// A device that hasn't refreshed its token in this long is treated as stale and
// pruned on the user's next registration. FCM tokens are refreshed by the client
// well within this window, so anything older is almost certainly a rotated-away
// token whose row would otherwise linger forever.
//
// NOTE: This is a best-effort fallback. The UserPushDevice model has no
// device-instance identifier (no deviceId column), so on token rotation we cannot
// match the new token to the exact prior row for that physical device. A proper fix
// requires adding a `deviceId` field to the schema and keying registration on
// (userId, deviceId) — see the M3 report. Until then we age out stale rows.
const STALE_TOKEN_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

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

  // Prune this user's stale tokens for the same platform. Without a deviceId we
  // cannot know which old row belongs to the device that just rotated its token, so
  // we conservatively delete only rows that haven't been refreshed in STALE_TOKEN_MS
  // (and never the row we just wrote). This stops rotated-away tokens from
  // accumulating without risking removal of a user's other live devices.
  try {
    await prisma.userPushDevice.deleteMany({
      where: {
        userId,
        platform,
        fcmToken: { not: token },
        updatedAt: { lt: new Date(Date.now() - STALE_TOKEN_MS) },
      },
    });
  } catch (err) {
    // Cleanup is best-effort; never fail a registration because pruning failed.
    console.error('[push] stale-token prune failed:', err.message);
  }

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
