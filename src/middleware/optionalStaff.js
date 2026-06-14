/**
 * Optional-auth for otherwise-public read endpoints.
 *
 * The storefront read endpoints (products, categories, banners, sections) are
 * consumed by BOTH the mobile app (anonymous) and the admin panel (authenticated
 * admin/manager). This middleware lets the same route serve both:
 *
 *   - No / invalid token  -> request continues anonymously (req.isStaff = false).
 *   - Valid admin token   -> req.isStaff = true, req.isAdmin = true.
 *   - Valid manager token -> req.isStaff = true, req.isManager = true,
 *                            req.managerPermissions populated.
 *
 * Services use `req.isStaff` to decide whether to bypass region/published filtering
 * (staff see everything, including DRAFT content and all regions). It NEVER rejects.
 */
const jwt = require('jsonwebtoken');
const { loadUserForAuth } = require('./auth');

async function attachStaffIfPresent(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      // Invalid/expired token on a public route — treat as anonymous, don't block.
      return next();
    }

    const user = await loadUserForAuth(decoded.id);
    if (!user || user.status !== 'ACTIVE') return next();
    // Honor token-version revocation, same as verifyToken.
    if (decoded.tv != null && decoded.tv !== user.tokenVersion) return next();

    if (user.role === 'ADMIN') {
      req.userId = user.id;
      req.isStaff = true;
      req.isAdmin = true;
    } else if (user.role === 'MANAGER') {
      req.userId = user.id;
      req.isStaff = true;
      req.isManager = true;
      req.managerPermissions = user.managerPermissions || [];
    }
    return next();
  } catch (err) {
    // Defensive: never let optional auth break a public read.
    return next();
  }
}

module.exports = { attachStaffIfPresent };
