const express = require('express');
const router = express.Router();
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
const {
  getSettings,
  getPublicSettings,
  updateSettings,
} = require('../controllers/settings.controller');

/**
 * @swagger
 * tags:
 *   name: Settings
 *   description: Site settings. Public endpoint for navbar; admin can get/update full settings.
 */

/**
 * @swagger
 * /settings/public:
 *   get:
 *     summary: Get public settings
 *     description: Returns settings needed for the frontend (e.g. hidden pages for navbar, whether guest reviews are allowed). No auth required.
 *     tags: [Settings]
 *     responses:
 *       200:
 *         description: Public settings
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data: { hiddenPages: [], maintenanceMode: false, allowGuestReviews: true }
 */
router.get('/public', getPublicSettings);

/**
 * @swagger
 * /settings:
 *   get:
 *     summary: Get all settings (admin)
 *     description: Returns full site settings. Requires admin JWT.
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Full settings object
 */
router.get('/', verifyAdminOrManager, requireManagerPermission('SETTINGS'), getSettings);

/**
 * @swagger
 * /settings:
 *   put:
 *     summary: Update settings (admin)
 *     description: Update site settings (e.g. hidden pages). Requires admin JWT.
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hiddenPages: { type: array, items: { type: string }, example: [] }
 *               allowGuestReviews:
 *                 type: boolean
 *                 description: When false, only signed-in customers can submit product reviews.
 *                 example: true
 *               defaultDeliveryLeadDays:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 30
 *                 description: |
 *                   Global fallback "ships within N day(s)" prep/booking lead time (whole
 *                   days), used when a product has no Category.deliveryLeadDays or
 *                   Product.deliveryLeadDays override. Distinct from Region.standardDeliveryDays
 *                   (courier transit time).
 *                 example: 1
 *     responses:
 *       200:
 *         description: Settings updated
 */
router.put('/', verifyAdminOrManager, requireManagerPermission('SETTINGS'), updateSettings);

module.exports = router;
