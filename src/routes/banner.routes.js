const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();
const bannerController = require('../controllers/banner.controller');
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
const { handleValidationErrors } = require('../middleware/validate');

/**
 * @swagger
 * tags:
 *   name: Banners
 *   description: Landing page banner images. Public list; admin add, reorder (drag order), delete. Images stored by URL in DB (Bunny CDN can be used later).
 */

/**
 * @swagger
 * /banners:
 *   get:
 *     summary: List banner images (public)
 *     description: Returns all banner images in display order (first = top of landing page). No auth required. Used by the user landing page.
 *     tags: [Banners]
 *     responses:
 *       200:
 *         description: Banners in display order
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Banners fetched successfully }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, format: uuid }
 *                       url: { type: string, description: Image URL }
 *                       sortOrder: { type: integer, description: Display order (0 = first) }
 *                       createdAt: { type: string, format: date-time }
 *                       updatedAt: { type: string, format: date-time }
 *                 meta:
 *                   type: object
 *                   properties:
 *                     total: { type: integer }
 *             example:
 *               success: true
 *               message: Banners fetched successfully
 *               data:
 *                 - id: "550e8400-e29b-41d4-a716-446655440001"
 *                   url: "https://example.com/banner1.jpg"
 *                   sortOrder: 0
 *                   createdAt: "2025-03-22T10:00:00.000Z"
 *                   updatedAt: "2025-03-22T10:00:00.000Z"
 *               meta:
 *                 total: 1
 */
router.get('/', bannerController.getBanners);

/**
 * @swagger
 * /banners:
 *   post:
 *     summary: Add banner image(s) (admin)
 *     description: Add one or more banner images. Provide a single **url** or an array **urls**. New images are appended at the end (highest sortOrder). Requires admin JWT.
 *     tags: [Banners]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - type: object
 *                 required: [url]
 *                 properties:
 *                   url:
 *                     type: string
 *                     format: uri
 *                     description: Single image URL (e.g. from upload or Bunny later)
 *                     example: "https://example.com/banner.jpg"
 *               - type: object
 *                 required: [urls]
 *                 properties:
 *                   urls:
 *                     type: array
 *                     items: { type: string, format: uri }
 *                     description: Multiple image URLs in order (first = first in list)
 *                     example: ["https://example.com/1.jpg", "https://example.com/2.jpg"]
 *           examples:
 *             single:
 *               summary: Single banner
 *               value: { url: "https://cdn.example.com/banner1.jpg" }
 *             multiple:
 *               summary: Multiple banners
 *               value: { urls: ["https://cdn.example.com/1.jpg", "https://cdn.example.com/2.jpg"] }
 *     responses:
 *       201:
 *         description: Banner(s) added successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data: { type: array, items: { $ref: '#/components/schemas/BannerImage' } }
 *                 meta: { type: object, properties: { count: { type: integer } } }
 *       400:
 *         description: Validation failed (missing url/urls or invalid format)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin required
 */
const addValidation = [
  body('url').optional().trim().isURL().withMessage('url must be a valid URL'),
  body('urls')
    .optional()
    .isArray()
    .withMessage('urls must be an array')
    .custom((arr) => !arr.some((u) => typeof u !== 'string' || !u.trim()))
    .withMessage('Each url in urls must be a non-empty string'),
  body().custom((val, { req }) => {
    if (req.body.url === undefined && req.body.urls === undefined) {
      throw new Error('Provide either url or urls');
    }
    if (req.body.url !== undefined && req.body.urls !== undefined) {
      throw new Error('Provide only one of url or urls');
    }
    if (req.body.urls !== undefined && req.body.urls.length === 0) {
      throw new Error('urls must not be empty');
    }
    return true;
  }),
];
router.post('/', verifyAdminOrManager, requireManagerPermission('BANNERS'), addValidation, handleValidationErrors, bannerController.addBanners);

/**
 * @swagger
 * /banners/order:
 *   patch:
 *     summary: Reorder banners (admin)
 *     description: Set the display order by sending an array of banner IDs. First ID in the array is shown first, last ID is shown last. Use after drag-and-drop in admin UI. Requires admin JWT.
 *     tags: [Banners]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [order]
 *             properties:
 *               order:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *                 description: Banner IDs in desired display order (index 0 = first)
 *                 example: ["id-first", "id-second", "id-third"]
 *           example:
 *             order: ["550e8400-e29b-41d4-a716-446655440002", "550e8400-e29b-41d4-a716-446655440001"]
 *     responses:
 *       200:
 *         description: Order updated; returns full ordered list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Banner order updated successfully }
 *                 data: { type: array, items: { $ref: '#/components/schemas/BannerImage' } }
 *                 meta: { type: object, properties: { total: { type: integer } } }
 *       400:
 *         description: order missing or not a non-empty array
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: One or more banner IDs not found
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin required
 */
const orderValidation = [
  body('order')
    .isArray({ min: 1 })
    .withMessage('order must be a non-empty array of banner IDs'),
  body('order.*').isUUID().withMessage('Each order item must be a valid UUID'),
];
router.patch('/order', verifyAdminOrManager, requireManagerPermission('BANNERS'), orderValidation, handleValidationErrors, bannerController.updateOrder);

/**
 * @swagger
 * /banners/{id}:
 *   delete:
 *     summary: Delete a banner (admin)
 *     description: Remove one banner image by ID. Returns updated list of banners. Requires admin JWT.
 *     tags: [Banners]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Banner image ID
 *     responses:
 *       200:
 *         description: Banner deleted; returns remaining banners in order
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Banner deleted successfully }
 *                 data: { type: array, items: { $ref: '#/components/schemas/BannerImage' } }
 *                 meta: { type: object, properties: { total: { type: integer } } }
 *       404:
 *         description: Banner not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin required
 */
router.delete(
  '/:id',
  verifyAdminOrManager,
  requireManagerPermission('BANNERS'),
  [param('id').isUUID().withMessage('Valid banner ID required')],
  handleValidationErrors,
  bannerController.deleteBanner
);

module.exports = router;
