const express = require('express');
const { param, query } = require('express-validator');
const router = express.Router();
const notificationController = require('../controllers/notification.controller');
const { verifyToken } = require('../middleware/auth');
const { handleValidationErrors } = require('../middleware/validate');

/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: In-app notification inbox (persisted copies of every push). Requires user JWT.
 */

/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: List my notifications (newest first)
 *     description: Paginated inbox. `unreadOnly=true` filters to unread. `unreadCount` is returned in meta for the app badge.
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, minimum: 1, maximum: 50 }
 *       - in: query
 *         name: unreadOnly
 *         schema: { type: boolean }
 *     responses:
 *       200: { description: Notifications page }
 */
router.get(
  '/',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 50 }),
  ],
  handleValidationErrors,
  verifyToken,
  notificationController.list
);

/**
 * @swagger
 * /notifications/unread-count:
 *   get:
 *     summary: My unread notification count
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Unread count }
 */
router.get('/unread-count', verifyToken, notificationController.unreadCount);

/**
 * @swagger
 * /notifications/read-all:
 *   post:
 *     summary: Mark all my notifications read
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Count updated }
 */
router.post('/read-all', verifyToken, notificationController.markAllRead);

/**
 * @swagger
 * /notifications/{id}/read:
 *   patch:
 *     summary: Mark one notification read
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Marked read }
 *       404: { description: Not found or already read }
 */
router.patch(
  '/:id/read',
  [param('id').isUUID().withMessage('Valid notification ID required')],
  handleValidationErrors,
  verifyToken,
  notificationController.markRead
);

module.exports = router;
