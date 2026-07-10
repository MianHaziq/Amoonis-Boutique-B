const jwt = require('jsonwebtoken');
const prisma = require('../config/db');
const { error } = require('../utils/response');

/**
 * Small in-memory cache so verifyToken doesn't hit the DB on every authenticated
 * request. TTL is intentionally short (30s) so a status/role change propagates
 * quickly without a full token expiry. Cleared on signal events (password
 * change, status update) is handled by bumping User.tokenVersion — the cached
 * entry then no longer matches the JWT claim and is rejected.
 */
const USER_CACHE_TTL_MS = 30 * 1000;
const USER_CACHE_MAX = 10000;
const userCache = new Map();

function getCached(userId) {
  const entry = userCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > USER_CACHE_TTL_MS) {
    userCache.delete(userId);
    return null;
  }
  return entry;
}

function setCached(userId, payload) {
  if (userCache.size >= USER_CACHE_MAX) {
    // Evict the oldest 25% in a single pass — cheaper than full LRU bookkeeping.
    const sorted = [...userCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    const drop = Math.floor(sorted.length / 4);
    for (let i = 0; i < drop; i++) userCache.delete(sorted[i][0]);
  }
  userCache.set(userId, { ...payload, fetchedAt: Date.now() });
}

function invalidateCachedUser(userId) {
  userCache.delete(userId);
}

/**
 * Load the current authoritative user fields used by middleware, hitting the
 * in-memory cache when fresh. Returns null when the user no longer exists.
 */
async function loadUserForAuth(userId) {
  const cached = getCached(userId);
  if (cached) return cached;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      status: true,
      tokenVersion: true,
      managerPermissions: true,
    },
  });
  if (!user) return null;
  setCached(user.id, user);
  return user;
}

/**
 * Verify JWT and load the live user record. Rejects deactivated, deleted, or
 * stale-token-version sessions. Preserves the existing { success: false, message }
 * shape on every failure so the mobile app keeps parsing errors unchanged.
 */
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, 'Access denied. No token provided.', 401);
    }

    const token = authHeader.split(' ')[1];

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return error(res, 'Token expired. Please login again.', 401);
      }
      if (err.name === 'JsonWebTokenError') {
        return error(res, 'Invalid token.', 401);
      }
      throw err;
    }

    const user = await loadUserForAuth(decoded.id);
    if (!user) {
      return error(res, 'Invalid token.', 401);
    }
    if (user.status !== 'ACTIVE') {
      return error(res, 'Your account has been deactivated. Please contact support.', 403);
    }
    // Reject tokens issued before the user's tokenVersion was bumped.
    // Legacy tokens (no `tv` claim) are accepted during the rollout window so
    // existing sessions don't get logged out at deployment.
    if (decoded.tv != null && decoded.tv !== user.tokenVersion) {
      return error(res, 'Session expired. Please login again.', 401);
    }

    req.userId = user.id;
    req.userRole = user.role;
    req.userStatus = user.status;
    req.managerPermissions = user.managerPermissions || [];
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Optional customer auth. Behaves like verifyToken but NEVER rejects the request:
 *   - No / invalid / expired / stale token  -> continue anonymously (req.userId stays undefined).
 *   - Valid, active, non-stale token         -> attach req.userId/req.userRole (+ manager perms).
 * Use on endpoints that must serve BOTH signed-in customers and guests (guest
 * checkout, promo preview) so the same handler can branch on `req.userId`.
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      // Invalid/expired token on an optional-auth route — treat as guest, don't block.
      return next();
    }

    const user = await loadUserForAuth(decoded.id);
    if (!user || user.status !== 'ACTIVE') return next();
    // Honor token-version revocation, same as verifyToken.
    if (decoded.tv != null && decoded.tv !== user.tokenVersion) return next();

    req.userId = user.id;
    req.userRole = user.role;
    req.userStatus = user.status;
    req.managerPermissions = user.managerPermissions || [];
    return next();
  } catch {
    // Defensive: optional auth must never break the request.
    return next();
  }
};

/**
 * Verify admin token middleware. Returns consistent { success: false, message } on failure.
 */
const verifyAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, 'Access denied. No token provided.', 401);
    }

    const token = authHeader.split(' ')[1];

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return error(res, 'Token expired. Please login again.', 401);
      }
      if (err.name === 'JsonWebTokenError') {
        return error(res, 'Invalid token.', 401);
      }
      throw err;
    }

    const user = await loadUserForAuth(decoded.id);

    if (!user || user.role !== 'ADMIN') {
      return error(res, 'Access denied. Admin privileges required.', 403);
    }
    if (user.status !== 'ACTIVE') {
      return error(res, 'Your account has been deactivated. Please contact support.', 403);
    }
    if (decoded.tv != null && decoded.tv !== user.tokenVersion) {
      return error(res, 'Session expired. Please login again.', 401);
    }

    req.userId = user.id;
    req.user = user;
    req.isAdmin = true;

    next();
  } catch (err) {
    next(err);
  }
};

module.exports = {
  verifyToken,
  optionalAuth,
  verifyAdmin,
  invalidateCachedUser,
  loadUserForAuth,
};
