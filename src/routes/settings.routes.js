const express = require('express');
const router = express.Router();
const { verifyAdmin } = require('../middleware/auth');
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
 *     description: Returns settings needed for the frontend (e.g. hidden pages for navbar). No auth required.
 *     tags: [Settings]
 *     responses:
 *       200:
 *         description: Public settings
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data: { hiddenPages: [] }
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
router.get('/', verifyAdmin, getSettings);

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
 *     responses:
 *       200:
 *         description: Settings updated
 */
router.put('/', verifyAdmin, updateSettings);

module.exports = router;
