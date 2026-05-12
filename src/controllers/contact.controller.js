const prisma = require('../config/db');
const { success, error } = require('../utils/response');

// ============================================
// USER CONTACT (authenticated issue/inquiry)
// ============================================

/**
 * @desc    Authenticated user submits a contact / issue
 * @route   POST /api/contact/issue
 * @access  Private (any logged-in user)
 */
const createUserContact = async (req, res, next) => {
  try {
    const { subject, message } = req.body;

    if (!subject || !message) {
      return error(res, 'Subject and message are required', 400);
    }

    // Phone number is required on the user profile before they can submit.
    // App should call PATCH /user/profile/phone first if phone is missing.
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { phone: true },
    });
    if (!user) {
      return error(res, 'User not found', 404);
    }
    if (!user.phone || !user.phone.trim()) {
      return error(res, 'Please add a phone number to your profile before submitting a contact.', 400);
    }

    const contact = await prisma.userContact.create({
      data: {
        userId: req.userId,
        subject: subject.trim(),
        message: message.trim(),
      },
    });

    return success(res, contact, 'Contact submitted successfully', 201);
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Admin lists all user-submitted contacts with user details
 * @route   GET /api/contact/admin/issues
 * @access  Admin / Manager with CONTACT permission
 */
const getAllUserContacts = async (req, res, next) => {
  try {
    const { page = 1, limit = 10, search, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};
    if (status) {
      where.status = status.toUpperCase();
    }
    if (search) {
      where.OR = [
        { subject: { contains: search, mode: 'insensitive' } },
        { message: { contains: search, mode: 'insensitive' } },
        { user: { fullName: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [contacts, total] = await Promise.all([
      prisma.userContact.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phone: true,
              avatar: true,
              role: true,
            },
          },
        },
      }),
      prisma.userContact.count({ where }),
    ]);

    const totalPages = Math.ceil(total / take);
    const pagination = {
      page: parseInt(page),
      limit: take,
      total,
      totalPages,
      hasNext: parseInt(page) < totalPages,
      hasPrev: parseInt(page) > 1,
    };

    return success(res, contacts, 'Contacts fetched successfully', 200, { pagination });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createUserContact,
  getAllUserContacts,
};
