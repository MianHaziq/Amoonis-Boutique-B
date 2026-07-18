const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();
const regionController = require('../controllers/region.controller');
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
const { attachStaffIfPresent } = require('../middleware/optionalStaff');
const { handleValidationErrors } = require('../middleware/validate');
const { publicLimiter } = require('../middleware/rateLimit');

/**
 * @swagger
 * tags:
 *   name: Regions
 *   description: Storefront regions (multi-region support). Public list (active only); admin/manager CRUD.
 */

const createValidation = [
  body('code').isString().trim().notEmpty().withMessage('code is required (e.g. UAE, SA)'),
  body('name').isString().trim().notEmpty().withMessage('name is required'),
  body('name_ar').optional().isString().trim(),
  body('currency').optional().isString().trim().isLength({ min: 3, max: 3 })
    .withMessage('currency must be a 3-letter ISO code (e.g. AED, SAR)'),
  body('legalEntity').optional({ nullable: true }).isString().trim().isLength({ max: 200 })
    .withMessage('legalEntity must be a string up to 200 characters'),
  body('shippingFlatRate').optional({ nullable: true }).isFloat({ min: 0 })
    .withMessage('shippingFlatRate must be a non-negative number'),
  body('iso2').optional({ nullable: true }).isString().trim().isLength({ min: 2, max: 2 })
    .withMessage('iso2 must be a 2-letter country code (e.g. AE, SA)'),
  body('isDefault').optional().isBoolean(),
  body('isActive').optional().isBoolean(),
  body('sortOrder').optional().isInt(),
];

const updateValidation = [
  param('id').isUUID().withMessage('Valid region ID required'),
  body('code').optional().isString().trim().notEmpty(),
  body('name').optional().isString().trim().notEmpty(),
  body('name_ar').optional().isString().trim(),
  body('currency').optional().isString().trim().isLength({ min: 3, max: 3 })
    .withMessage('currency must be a 3-letter ISO code (e.g. AED, SAR)'),
  body('legalEntity').optional({ nullable: true }).isString().trim().isLength({ max: 200 })
    .withMessage('legalEntity must be a string up to 200 characters'),
  body('shippingFlatRate').optional({ nullable: true }).isFloat({ min: 0 })
    .withMessage('shippingFlatRate must be a non-negative number'),
  body('iso2').optional({ nullable: true }).isString().trim().isLength({ min: 2, max: 2 })
    .withMessage('iso2 must be a 2-letter country code (e.g. AE, SA)'),
  body('isDefault').optional().isBoolean(),
  body('isActive').optional().isBoolean(),
  body('sortOrder').optional().isInt(),
];

const idParam = [param('id').isUUID().withMessage('Valid region ID required')];

/**
 * @swagger
 * /regions:
 *   get:
 *     summary: List regions
 *     description: |
 *       Public request returns **ACTIVE** regions only (use this to populate a region picker —
 *       the `code` values are what clients send in the **X-Region** header). An admin/manager
 *       token returns all regions, including inactive ones.
 *     tags: [Regions]
 *     responses:
 *       200:
 *         description: Regions list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data: { type: array, items: { $ref: '#/components/schemas/Region' } }
 *                 meta: { type: object, properties: { total: { type: integer } } }
 */
router.get('/', publicLimiter, attachStaffIfPresent, regionController.listRegions);

/**
 * @swagger
 * /regions:
 *   post:
 *     summary: Create a region (admin/manager)
 *     description: Add a new storefront region at runtime — no migration needed. Requires the REGIONS manager permission (admins bypass).
 *     tags: [Regions]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/RegionCreate' }
 *           example: { code: KW, name: Kuwait, name_ar: الكويت, isActive: true, sortOrder: 2 }
 *     responses:
 *       201:
 *         description: Region created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data: { $ref: '#/components/schemas/Region' }
 *       409: { description: A region with this code already exists }
 */
router.post(
  '/',
  verifyAdminOrManager,
  requireManagerPermission('REGIONS'),
  createValidation,
  handleValidationErrors,
  regionController.createRegion
);

/**
 * @swagger
 * /regions/{id}:
 *   put:
 *     summary: Update a region (admin/manager)
 *     description: Update code, name, or flags. Setting isDefault to true unsets the previous default region.
 *     tags: [Regions]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/RegionCreate' }
 *           example: { name: Kuwait, isActive: false }
 *     responses:
 *       200:
 *         description: Region updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data: { $ref: '#/components/schemas/Region' }
 *       404: { description: Region not found }
 *       409: { description: Code already in use, or hiding this region would leave zero active regions }
 */
router.put(
  '/:id',
  verifyAdminOrManager,
  requireManagerPermission('REGIONS'),
  updateValidation,
  handleValidationErrors,
  regionController.updateRegion
);

/**
 * @swagger
 * /regions/{id}:
 *   delete:
 *     summary: Delete a region (admin/manager)
 *     description: Blocked (409) if the region is the default or is still referenced by products, users, or orders — reassign those first.
 *     tags: [Regions]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Region deleted }
 *       404: { description: Region not found }
 *       409: { description: Region is default or in use }
 */
router.delete(
  '/:id',
  verifyAdminOrManager,
  requireManagerPermission('REGIONS'),
  idParam,
  handleValidationErrors,
  regionController.deleteRegion
);

module.exports = router;
