const crypto = require('crypto');
const prisma = require('../config/db');

/**
 * Refresh token semantics:
 *   - Raw token is a 64-char hex string, returned to the client only once.
 *   - We persist only the SHA-256 hash (no raw token ever sits in the DB).
 *   - Default lifetime is 90 days; configurable via REFRESH_TOKEN_TTL_DAYS env.
 *   - Refresh is single-use: the old token is revoked the moment a new pair is issued.
 *   - Logout / password change revokes all of a user's refresh tokens at once.
 */

const DEFAULT_TTL_DAYS = 90;

function ttlMs() {
  const fromEnv = Number(process.env.REFRESH_TOKEN_TTL_DAYS);
  const days = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TTL_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

function generateRawToken() {
  return crypto.randomBytes(48).toString('hex');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * Issue a brand-new refresh token for a user. Returns the raw token (only place it exists).
 */
async function issueRefreshToken(userId, userAgent = null) {
  const raw = generateRawToken();
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + ttlMs());

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      userAgent: userAgent ? String(userAgent).slice(0, 255) : null,
    },
  });

  return { token: raw, expiresAt };
}

/**
 * Find an active (not revoked, not expired) refresh token row by raw token.
 * Returns the row (with userId) or null. Does NOT consume the token.
 */
async function findActiveByRawToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const tokenHash = hashToken(rawToken.trim());
  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash },
  });
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt <= new Date()) return null;
  return row;
}

/**
 * Atomically rotate: revoke the old token and issue a new one for the same user.
 * Returns `{ token, expiresAt, userId }` or `null` if the old token is unusable.
 */
async function rotateRefreshToken(rawOldToken, userAgent = null) {
  const oldRow = await findActiveByRawToken(rawOldToken);
  if (!oldRow) return null;

  const newRaw = generateRawToken();
  const newHash = hashToken(newRaw);
  const expiresAt = new Date(Date.now() + ttlMs());

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: oldRow.id },
      data: { revokedAt: new Date() },
    }),
    prisma.refreshToken.create({
      data: {
        userId: oldRow.userId,
        tokenHash: newHash,
        expiresAt,
        userAgent: userAgent ? String(userAgent).slice(0, 255) : null,
      },
    }),
  ]);

  return { token: newRaw, expiresAt, userId: oldRow.userId };
}

/**
 * Revoke a single refresh token. Safe to call with an unknown or stale token (no-op).
 */
async function revokeRawToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return { revoked: false };
  const tokenHash = hashToken(rawToken.trim());
  const result = await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { revoked: result.count > 0 };
}

/**
 * Revoke every refresh token for a user. Used by changePassword and adminstrative kicks.
 */
async function revokeAllForUser(userId) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

module.exports = {
  issueRefreshToken,
  findActiveByRawToken,
  rotateRefreshToken,
  revokeRawToken,
  revokeAllForUser,
  hashToken,
};
