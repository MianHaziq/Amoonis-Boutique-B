const prisma = require('../config/db');
const bcrypt = require('bcryptjs');
const { success, error } = require('../utils/response');
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

/**
 * Helper to generate avatar initials from name
 */
const getAvatarInitials = (firstName, lastName) => {
  const first = firstName?.charAt(0)?.toUpperCase() || '';
  const last = lastName?.charAt(0)?.toUpperCase() || '';
  return `${first}${last}`;
};

/**
 * Helper to transform user data for frontend
 */
const transformUser = (user) => ({
  id: user.id,
  name: `${user.firstName} ${user.lastName}`,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  avatar: user.avatar || getAvatarInitials(user.firstName, user.lastName),
  role: capitalize(user.role) || 'Customer',
  managerTitle: user.role === 'MANAGER' ? user.managerTitle || null : null,
  managerPermissions: user.role === 'MANAGER' ? user.managerPermissions || [] : [],
  status: capitalize(user.status) || 'Active',
  isEmailVerified: user.isEmailVerified,
  joinedAt: user.createdAt,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

/**
 * @desc    Create a new user
 * @route   POST /api/users
 * @access  Admin
 */
const createUser = async (req, res, next) => {
  try {
    const {
      email,
      firstName,
      lastName,
      password,
      role,
      status,
      avatar,
      managerTitle,
      managerPermissions,
    } = req.body;

    if (!email || !firstName || !lastName || !password) {
      return error(res, 'Email, first name, last name, and password are required', 400);
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
        firstName,
        lastName,
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
      sortBy = 'createdAt',
      order = 'desc',
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    // Build where clause
    const where = {};

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (role) {
      where.role = role.toUpperCase();
    }

    if (status) {
      where.status = status.toUpperCase();
    }

    // Build orderBy
    const validSortFields = ['firstName', 'lastName', 'email', 'createdAt', 'role', 'status'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const sortOrder = order === 'asc' ? 'asc' : 'desc';

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take,
        orderBy: { [sortField]: sortOrder },
        }),
      prisma.user.count({ where }),
    ]);

    const pagination = {
      page: parseInt(page),
      limit: take,
      total,
      totalPages: Math.ceil(total / take),
      hasNext: skip + take < total,
      hasPrev: parseInt(page) > 1,
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
      firstName,
      lastName,
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
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (status) updateData.status = status.toUpperCase();
    if (avatar !== undefined) updateData.avatar = avatar;

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
