const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const {
  submitContact,
  getAllMessages,
  getMessageStats,
  getMessageById,
  updateMessageStatus,
  addAdminNote,
  deleteMessage,
} = require('../controllers/contact.controller');
const { verifyAdmin } = require('../middleware/auth');
const { handleValidationErrors } = require('../middleware/validate');

/**
 * @swagger
 * tags:
 *   - name: Contact
 *     description: Public contact form
 *   - name: Contact Admin
 *     description: Admin contact message management
 */

// ============================================
// PUBLIC ROUTE
// ============================================

/**
 * @swagger
 * /contact:
 *   post:
 *     summary: Submit contact form
 *     tags: [Contact]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - firstName
 *               - email
 *               - message
 *             properties:
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               phone:
 *                 type: string
 *               subject:
 *                 type: string
 *                 enum: [general, support, sales, other]
 *               message:
 *                 type: string
 *     responses:
 *       200:
 *         description: Message sent successfully
 *       400:
 *         description: Missing required fields
 */
const contactValidation = [
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('email').trim().isEmail().withMessage('Valid email is required'),
  body('message').trim().notEmpty().withMessage('Message is required'),
];
router.post('/', contactValidation, handleValidationErrors, submitContact);

// ============================================
// ADMIN ROUTES
// ============================================

/**
 * @swagger
 * /contact/admin/stats:
 *   get:
 *     summary: Get contact message statistics
 *     tags: [Contact Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Message stats by status
 */
router.get('/admin/stats', verifyAdmin, getMessageStats);

/**
 * @swagger
 * /contact/admin/messages:
 *   get:
 *     summary: Get all contact messages with pagination
 *     tags: [Contact Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [NEW, READ, REPLIED, ARCHIVED]
 *     responses:
 *       200:
 *         description: List of contact messages with pagination
 */
router.get('/admin/messages', verifyAdmin, getAllMessages);

/**
 * @swagger
 * /contact/admin/{id}:
 *   get:
 *     summary: Get single contact message (auto-marks as READ)
 *     tags: [Contact Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Message details
 *       404:
 *         description: Message not found
 */
router.get('/admin/:id', verifyAdmin, getMessageById);

/**
 * @swagger
 * /contact/admin/{id}/status:
 *   patch:
 *     summary: Update message status
 *     tags: [Contact Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [NEW, READ, REPLIED, ARCHIVED]
 *     responses:
 *       200:
 *         description: Status updated
 */
router.patch('/admin/:id/status', verifyAdmin, updateMessageStatus);

/**
 * @swagger
 * /contact/admin/{id}/note:
 *   patch:
 *     summary: Add/update admin note on message
 *     tags: [Contact Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               note:
 *                 type: string
 *     responses:
 *       200:
 *         description: Note updated
 */
router.patch('/admin/:id/note', verifyAdmin, addAdminNote);

/**
 * @swagger
 * /contact/admin/{id}:
 *   delete:
 *     summary: Delete a contact message
 *     tags: [Contact Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Message deleted
 *       404:
 *         description: Message not found
 */
router.delete('/admin/:id', verifyAdmin, deleteMessage);

module.exports = router;
