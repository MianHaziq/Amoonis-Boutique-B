const nodemailer = require('nodemailer');
const prisma = require('../config/db');

// Helper: Send email (non-blocking — caller should catch errors)
const sendEmail = async (to, subject, html) => {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.FROM_EMAIL,
    to,
    subject,
    html,
  });
};

// Subject label mapping
const subjectLabels = {
  general: 'General Inquiry',
  support: 'Technical Support',
  sales: 'Course Enrollment',
  other: 'Other',
};

// ============================================
// PUBLIC ENDPOINT
// ============================================

/**
 * @desc    Submit contact form (save to DB + optional email)
 * @route   POST /api/contact
 * @access  Public
 */
const submitContact = async (req, res, next) => {
  try {
    const { firstName, lastName, email, phone, subject, message } = req.body;

    if (!firstName || !email || !message) {
      return res.status(400).json({
        success: false,
        message: 'First name, email, and message are required',
      });
    }

    // Save to database first (this is the source of truth)
    const contactMessage = await prisma.contactMessage.create({
      data: {
        firstName,
        lastName: lastName || null,
        email,
        phone: phone || null,
        subject: subject || 'general',
        message,
      },
    });

    // Try to send email notifications (non-blocking)
    try {
      const subjectLabel = subjectLabels[subject] || 'General Inquiry';
      const contactEmail = process.env.CONTACT_EMAIL || 'inquiries@lknightproductions.com';

      // Send notification to business
      await sendEmail(
        contactEmail,
        `New Contact: ${subjectLabel} from ${firstName} ${lastName || ''}`,
        `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #1a1a2e; padding: 24px; border-radius: 8px 8px 0 0;">
              <h2 style="color: white; margin: 0;">New Contact Form Submission</h2>
            </div>
            <div style="padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; width: 120px;"><strong>Name:</strong></td>
                  <td style="padding: 8px 0; color: #111827;">${firstName} ${lastName || ''}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280;"><strong>Email:</strong></td>
                  <td style="padding: 8px 0; color: #111827;"><a href="mailto:${email}">${email}</a></td>
                </tr>
                ${phone ? `
                <tr>
                  <td style="padding: 8px 0; color: #6b7280;"><strong>Phone:</strong></td>
                  <td style="padding: 8px 0; color: #111827;"><a href="tel:${phone}">${phone}</a></td>
                </tr>
                ` : ''}
                <tr>
                  <td style="padding: 8px 0; color: #6b7280;"><strong>Subject:</strong></td>
                  <td style="padding: 8px 0; color: #111827;">${subjectLabel}</td>
                </tr>
              </table>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;" />
              <p style="color: #6b7280; margin-bottom: 4px;"><strong>Message:</strong></p>
              <p style="color: #111827; white-space: pre-wrap; line-height: 1.6;">${message}</p>
            </div>
          </div>
        `
      );

      // Send confirmation to user
      await sendEmail(
        email,
        'Thank you for contacting us',
        `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #1a1a2e; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
              <h2 style="color: white; margin: 0;">Amoonis Boutique</h2>
            </div>
            <div style="padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
              <p style="color: #111827; font-size: 16px;">Hi ${firstName},</p>
              <p style="color: #4b5563; line-height: 1.6;">
                Thank you for reaching out. We have received your message and will get back to you within 24-48 hours.
              </p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
              <p style="color: #9ca3af; font-size: 12px; text-align: center;">
                Amoonis Boutique
              </p>
            </div>
          </div>
        `
      );
    } catch (emailError) {
      console.warn('[CONTACT] Email notification failed (message saved to DB):', emailError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Message sent successfully. We will get back to you soon!',
    });
  } catch (error) {
    next(error);
  }
};

// ============================================
// ADMIN ENDPOINTS
// ============================================

/**
 * @desc    Get all contact messages with pagination and filters
 * @route   GET /api/contact/admin/messages
 * @access  Admin
 */
const getAllMessages = async (req, res, next) => {
  try {
    const { page = 1, limit = 10, search, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    // Build where clause
    const where = {};
    if (status) {
      where.status = status.toUpperCase();
    }
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { message: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [messages, total] = await Promise.all([
      prisma.contactMessage.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.contactMessage.count({ where }),
    ]);

    const totalPages = Math.ceil(total / take);

    res.status(200).json({
      success: true,
      data: messages,
      pagination: {
        page: parseInt(page),
        limit: take,
        total,
        totalPages,
        hasNext: parseInt(page) < totalPages,
        hasPrev: parseInt(page) > 1,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get contact message stats (counts by status)
 * @route   GET /api/contact/admin/stats
 * @access  Admin
 */
const getMessageStats = async (req, res, next) => {
  try {
    const [total, newCount, readCount, repliedCount, archivedCount] = await Promise.all([
      prisma.contactMessage.count(),
      prisma.contactMessage.count({ where: { status: 'NEW' } }),
      prisma.contactMessage.count({ where: { status: 'READ' } }),
      prisma.contactMessage.count({ where: { status: 'REPLIED' } }),
      prisma.contactMessage.count({ where: { status: 'ARCHIVED' } }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        total,
        new: newCount,
        read: readCount,
        replied: repliedCount,
        archived: archivedCount,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get single contact message (auto-marks NEW as READ)
 * @route   GET /api/contact/admin/:id
 * @access  Admin
 */
const getMessageById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const message = await prisma.contactMessage.findUnique({ where: { id } });
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    // Auto-mark NEW messages as READ when viewed
    if (message.status === 'NEW') {
      await prisma.contactMessage.update({
        where: { id },
        data: { status: 'READ' },
      });
      message.status = 'READ';
    }

    res.status(200).json({
      success: true,
      data: message,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update message status
 * @route   PATCH /api/contact/admin/:id/status
 * @access  Admin
 */
const updateMessageStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['NEW', 'READ', 'REPLIED', 'ARCHIVED'];
    if (!status || !validStatuses.includes(status.toUpperCase())) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      });
    }

    const message = await prisma.contactMessage.findUnique({ where: { id } });
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    const updated = await prisma.contactMessage.update({
      where: { id },
      data: { status: status.toUpperCase() },
    });

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Add/update admin note on a message
 * @route   PATCH /api/contact/admin/:id/note
 * @access  Admin
 */
const addAdminNote = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    const message = await prisma.contactMessage.findUnique({ where: { id } });
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    const updated = await prisma.contactMessage.update({
      where: { id },
      data: { adminNote: note || null },
    });

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete a contact message
 * @route   DELETE /api/contact/admin/:id
 * @access  Admin
 */
const deleteMessage = async (req, res, next) => {
  try {
    const { id } = req.params;

    const message = await prisma.contactMessage.findUnique({ where: { id } });
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    await prisma.contactMessage.delete({ where: { id } });

    res.status(200).json({
      success: true,
      message: 'Message deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  submitContact,
  getAllMessages,
  getMessageStats,
  getMessageById,
  updateMessageStatus,
  addAdminNote,
  deleteMessage,
};
