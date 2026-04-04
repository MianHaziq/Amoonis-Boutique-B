const jwt = require('jsonwebtoken');
const prisma = require('../config/db');
const { error } = require('../utils/response');

/**
 * Admin or manager with active account. Loads managerPermissions for MANAGER role.
 */
const verifyAdminOrManager = async (req, res, next) => {
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

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, role: true, status: true, managerPermissions: true },
    });

    if (!user) {
      return error(res, 'Access denied. User not found.', 403);
    }
    if (user.status !== 'ACTIVE') {
      return error(res, 'Account is inactive.', 403);
    }

    if (user.role === 'ADMIN') {
      req.userId = user.id;
      req.user = user;
      req.isAdmin = true;
      return next();
    }

    if (user.role === 'MANAGER') {
      req.userId = user.id;
      req.user = user;
      req.isManager = true;
      req.managerPermissions = user.managerPermissions || [];
      return next();
    }

    return error(res, 'Access denied. Admin or manager privileges required.', 403);
  } catch (err) {
    next(err);
  }
};

function requireManagerPermission(permission) {
  return (req, res, next) => {
    if (req.isAdmin) return next();
    if (req.isManager && Array.isArray(req.managerPermissions) && req.managerPermissions.includes(permission)) {
      return next();
    }
    return error(res, 'You do not have permission to perform this action.', 403);
  };
}

function requireAnyManagerPermission(permissions) {
  const list = permissions;
  return (req, res, next) => {
    if (req.isAdmin) return next();
    if (req.isManager && Array.isArray(req.managerPermissions)) {
      if (list.some((p) => req.managerPermissions.includes(p))) return next();
    }
    return error(res, 'You do not have permission to perform this action.', 403);
  };
}

/**
 * Use after verifyToken on GET /orders/:id so managers with ORDERS can read any order.
 */
const attachOrderStaffAccess = async (req, res, next) => {
  try {
    if (!req.userId) return next();

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true, status: true, managerPermissions: true },
    });

    if (!user || user.status !== 'ACTIVE') {
      return error(res, 'Account is inactive.', 403);
    }

    if (user.role === 'ADMIN') {
      req.isAdmin = true;
    }
    if (user.role === 'MANAGER' && user.managerPermissions.includes('ORDERS')) {
      req.canViewAllOrders = true;
    }

    next();
  } catch (err) {
    next(err);
  }
};

module.exports = {
  verifyAdminOrManager,
  requireManagerPermission,
  requireAnyManagerPermission,
  attachOrderStaffAccess,
};
