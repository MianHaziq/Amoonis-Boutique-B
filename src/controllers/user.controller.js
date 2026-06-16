const prisma = require('../config/db');
const bcrypt = require('bcryptjs');
const { success, error } = require('../utils/response');
const { invalidateCachedUser } = require('../middleware/auth');

// Sentinel id that can never match a real region row — used so an unknown region
// filter returns an empty set instead of injecting an arbitrary string as a UUID
// filter (which would error or match nothing unpredictably). Mirrors the pattern
// in utils/visibilityFromReq.js and services/analytics.service.js.
const NO_MATCH_REGION_ID = '00000000-0000-0000-0000-000000000000';
const {
  normalizeManagerPermissions,
  MANAGER_PERMISSION_CATALOG,
} = require('../constants/managerPermissions');

/**
 * Capitalize first letter, lowercase rest (e.g., "ADMIN" -> "Admin")
 */
const capitalize = (str) => {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
};

const getAvatarInitials = (displayName) => {
  const parts = (displayName || '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0)?.toUpperCase() || '';
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0).toUpperCase() : '';
  return `${first}${last}`;
};

/**
 * Helper to transform user data for frontend
 */
const transformUser = (user) => {
  const displayName = (user.fullName || '').trim();
  return {
    id: user.id,
    name: displayName,
    fullName: displayName || null,
    email: user.email,
    avatar: user.avatar || getAvatarInitials(displayName),
    role: capitalize(user.role) || 'Customer',
    managerTitle: user.role === 'MANAGER' ? user.managerTitle || null : null,
    managerPermissions: user.role === 'MANAGER' ? user.managerPermissions || [] : [],
    status: capitalize(user.status) || 'Active',
    isEmailVerified: user.isEmailVerified,
    regionId: user.regionId || null,
    region: user.region
      ? { id: user.region.id, code: user.region.code, name: user.region.name, name_ar: user.region.name_ar ?? null }
      : null,
    joinedAt: user.createdAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
};

/**
 * @desc    Create a new user
 * @route   POST /api/users
 * @access  Admin
 */
const createUser = async (req, res, next) => {
  try {
    const {
      email,
      fullName,
      password,
      role,
      status,
      avatar,
      managerTitle,
      managerPermissions,
    } = req.body;

    const trimmedFullName = (fullName || '').trim();

    if (!email || !trimmedFullName || !password) {
      return error(res, 'Email, full name, and password are required', 400);
    }

    const resolvedRole = (role && String(role).toUpperCase()) || 'CUSTOMER';

    if (resolvedRole === 'ADMIN') {
      return error(res, 'Administrator accounts cannot be created through this API', 403);
    }

    if (!['CUSTOMER', 'MANAGER'].includes(resolvedRole)) {
      return error(res, 'Invalid role. Allowed values: CUSTOMER, MANAGER', 400);
    }

    let managerData = {};
    if (resolvedRole === 'MANAGER') {
      const title = managerTitle != null ? String(managerTitle).trim() : '';
      if (!title) {
        return error(res, 'managerTitle is required when creating a manager', 400);
      }
      const norm = normalizeManagerPermissions(managerPermissions);
      if (!norm.ok) {
        return error(res, norm.message, 400);
      }
      managerData = { managerTitle: title, managerPermissions: norm.value };
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email,
        fullName: trimmedFullName,
        password: hashedPassword,
        role: resolvedRole,
        status: status?.toUpperCase() || 'ACTIVE',
        avatar: avatar || null,
        ...managerData,
      },
    });

    return success(res, transformUser(user), 'User created successfully', 201);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Get all users with pagination, search, and filters
 * @route   GET /api/users
 * @access  Admin
 */
const getAllUsers = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      role,
      status,
      region,
      sortBy = 'createdAt',
      order = 'desc',
    } = req.query;

    // Clamp pagination: default page to 1 when NaN/<1, default limit to 10 when
    // NaN, and cap limit at 100 to avoid unbounded scans. Mirrors product.service.
    const parsedPage = parseInt(page);
    const parsedLimit = parseInt(limit);
    const safePage = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage;
    const safeLimit = Math.min(100, Math.max(1, Number.isNaN(parsedLimit) ? 10 : parsedLimit));

    const skip = (safePage - 1) * safeLimit;
    const take = safeLimit;

    // Build where clause
    const where = {};

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { fullName: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (role) {
      where.role = role.toUpperCase();
    }

    if (status) {
      where.status = status.toUpperCase();
    }

    // Region filter accepts a region code (e.g. UAE) or a region id.
    if (region) {
      const regionService = require('../services/region.service');
      const matched = await regionService.getRegionByCode(region);
      where.regionId = matched ? matched.id : NO_MATCH_REGION_ID;
    }

    // Build orderBy
    const validSortFields = ['fullName', 'email', 'createdAt', 'role', 'status'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const sortOrder = order === 'asc' ? 'asc' : 'desc';

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take,
        orderBy: { [sortField]: sortOrder },
        include: { region: { select: { id: true, code: true, name: true, name_ar: true } } },
        }),
      prisma.user.count({ where }),
    ]);

    const pagination = {
      page: safePage,
      limit: take,
      total,
      totalPages: Math.ceil(total / take),
      hasNext: skip + take < total,
      hasPrev: safePage > 1,
    };
    return success(res, users.map(transformUser), 'Users fetched successfully', 200, { pagination });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Get user by ID
 * @route   GET /api/users/:id
 * @access  Admin
 */
const getUserById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id },
      include: { region: { select: { id: true, code: true, name: true, name_ar: true } } },
    });

    if (!user) {
      return error(res, 'User not found', 404);
    }

    return success(res, transformUser(user), 'User fetched successfully', 200);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Update user
 * @route   PUT /api/users/:id
 * @access  Admin
 */
const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      email,
      fullName,
      password,
      role,
      status,
      avatar,
      managerTitle,
      managerPermissions,
    } = req.body;

    const existingUser = await prisma.user.findUnique({
      where: { id },
    });

    if (!existingUser) {
      return error(res, 'User not found', 404);
    }

    const nextRole = role ? String(role).toUpperCase() : existingUser.role;

    if (role && !['CUSTOMER', 'ADMIN', 'MANAGER'].includes(nextRole)) {
      return error(res, 'Invalid role', 400);
    }

    const updateData = {};

    if (email) updateData.email = email;
    if (fullName !== undefined) {
      const trimmed = String(fullName).trim();
      if (!trimmed) {
        return error(res, 'fullName cannot be empty', 400);
      }
      updateData.fullName = trimmed;
    }
    if (status) updateData.status = status.toUpperCase();
    if (avatar !== undefined) updateData.avatar = avatar;

    // Admin may reassign a user's region by regionId or region code. Empty/null clears it.
    if (req.body.regionId !== undefined || req.body.region !== undefined) {
      const regionService = require('../services/region.service');
      const ref = req.body.regionId ?? req.body.region;
      if (!ref) {
        updateData.regionId = null;
      } else {
        const byId = await regionService.getRegionById(String(ref));
        const matched = byId || (await regionService.getRegionByCode(String(ref)));
        if (!matched) return error(res, `Unknown region: ${ref}`, 400);
        updateData.regionId = matched.id;
      }
    }

    if (password) {
      updateData.password = await bcrypt.hash(password, 12);
    }

    if (nextRole === 'MANAGER') {
      const title =
        managerTitle !== undefined
          ? String(managerTitle).trim()
          : (existingUser.managerTitle || '');
      let perms = existingUser.managerPermissions || [];
      if (managerPermissions !== undefined) {
        const norm = normalizeManagerPermissions(managerPermissions);
        if (!norm.ok) {
          return error(res, norm.message, 400);
        }
        perms = norm.value;
      }
      if (!title) {
        return error(res, 'managerTitle is required for managers', 400);
      }
      if (!perms || perms.length === 0) {
        return error(res, 'At least one permission is required for managers', 400);
      }
      updateData.managerTitle = title;
      updateData.managerPermissions = perms;
    } else {
      updateData.managerTitle = null;
      updateData.managerPermissions = [];
    }

    if (role) {
      updateData.role = nextRole;
    }

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
    });

    // Privilege-relevant fields (role/status/managerPermissions) may have changed —
    // drop the cached auth entry so the change takes effect without the 30s TTL.
    invalidateCachedUser(id);

    return success(res, transformUser(user), 'User updated successfully', 200);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Delete user
 * @route   DELETE /api/users/:id
 * @access  Admin
 */
const deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      return error(res, 'User not found', 404);
    }

    if (user.role === 'ADMIN') {
      return error(res, 'Admin users cannot be deleted', 403);
    }

    await prisma.user.delete({
      where: { id },
    });

    return success(res, null, 'User deleted successfully', 200);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Toggle user status (Active/Inactive)
 * @route   PATCH /api/users/:id/status
 * @access  Admin
 */
const toggleUserStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      return error(res, 'User not found', 404);
    }

    const newStatus = status
      ? status.toUpperCase()
      : user.status === 'ACTIVE'
        ? 'INACTIVE'
        : 'ACTIVE';

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { status: newStatus },
    });

    // Status changed — drop the cached auth entry so it takes effect immediately.
    invalidateCachedUser(id);

    return success(res, transformUser(updatedUser), `User ${newStatus.toLowerCase()} successfully`, 200);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Change user role
 * @route   PATCH /api/users/:id/role
 * @access  Admin
 */
const changeUserRole = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role, managerTitle, managerPermissions } = req.body;

    if (!role) {
      return error(res, 'Role is required', 400);
    }

    const upper = String(role).toUpperCase();
    const validRoles = ['CUSTOMER', 'ADMIN', 'MANAGER'];
    if (!validRoles.includes(upper)) {
      return error(res, `Invalid role. Must be one of: ${validRoles.join(', ')}`, 400);
    }

    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      return error(res, 'User not found', 404);
    }

    let data = { role: upper };

    if (upper === 'MANAGER') {
      const title = managerTitle != null ? String(managerTitle).trim() : '';
      if (!title) {
        return error(res, 'managerTitle is required when assigning the manager role', 400);
      }
      const norm = normalizeManagerPermissions(managerPermissions);
      if (!norm.ok) {
        return error(res, norm.message, 400);
      }
      data.managerTitle = title;
      data.managerPermissions = norm.value;
    } else {
      data.managerTitle = null;
      data.managerPermissions = [];
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data,
    });

    // Role/managerPermissions changed — drop the cached auth entry so it takes
    // effect immediately rather than after the 30s TTL.
    invalidateCachedUser(id);

    return success(res, transformUser(updatedUser), `User role changed to ${upper}`, 200);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Get user statistics
 * @route   GET /api/users/stats
 * @access  Admin
 */
const getUserStats = async (req, res, next) => {
  try {
    const [totalUsers, customers, admins, managers, activeUsers, inactiveUsers] =
      await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { role: 'CUSTOMER' } }),
        prisma.user.count({ where: { role: 'ADMIN' } }),
        prisma.user.count({ where: { role: 'MANAGER' } }),
        prisma.user.count({ where: { status: 'ACTIVE' } }),
        prisma.user.count({ where: { status: 'INACTIVE' } }),
      ]);

    return success(res, {
      total: totalUsers,
      customers,
      admins,
      managers,
      active: activeUsers,
      inactive: inactiveUsers,
    }, 'Stats fetched successfully', 200);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    List valid manager permission keys for admin UI
 * @route   GET /api/users/manager-permissions
 * @access  Admin
 */
const getManagerPermissionCatalog = async (req, res, next) => {
  try {
    return success(
      res,
      { permissions: [...MANAGER_PERMISSION_CATALOG] },
      'Manager permission catalog fetched successfully',
      200
    );
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
  toggleUserStatus,
  changeUserRole,
  getUserStats,
  getManagerPermissionCatalog,
};
