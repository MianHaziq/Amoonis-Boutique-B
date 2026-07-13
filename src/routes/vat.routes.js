const express = require('express');
const router = express.Router();
const { param } = require('express-validator');
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
const { resolveRegion } = require('../middleware/region');
const { handleValidationErrors } = require('../middleware/validate');
const {
  listVatConfigs,
  getPublicVatConfig,
  getVatConfig,
  updateVatConfig,
} = require('../controllers/vat.controller');

const regionIdParam = [param('regionId').isUUID().withMessage('Valid region ID required')];

/**
 * @swagger
 * tags:
 *   name: VAT
 *   description: |
 *     Per-region VAT / tax configuration — one config per Region (e.g. UAE 5%, KSA 15%).
 *     Public endpoint exposes the rate + inclusive flag for the storefront's CURRENT region
 *     (resolved from `X-Region`). Admin (or a manager with the SETTINGS permission) can list
 *     every region's config, and read/update the full config for one region.
 */

/**
 * @swagger
 * /vat/public:
 *   get:
 *     summary: Get public VAT config for the current region
 *     description: |
 *       Returns enabled, ratePercent, inclusive, and appliesTo for the region resolved from the
 *       `X-Region` header (fallback `?region=`, then the store's default region). No auth.
 *     tags: [VAT]
 *     parameters:
 *       - in: header
 *         name: X-Region
 *         schema: { type: string }
 *         example: UAE
 *     responses:
 *       200:
 *         description: Public VAT config for the resolved region
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data: { enabled: true, ratePercent: 5, inclusive: true, appliesTo: ALL_PRODUCTS }
 */
router.get('/public', resolveRegion, getPublicVatConfig);

/**
 * @swagger
 * /vat:
 *   get:
 *     summary: List every region's VAT config (admin)
 *     description: One entry per region — regions without an explicit config come back with a disabled default.
 *     tags: [VAT]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All regions with their VAT config
 */
router.get('/', verifyAdminOrManager, requireManagerPermission('SETTINGS'), listVatConfigs);

/**
 * @swagger
 * /vat/{regionId}:
 *   get:
 *     summary: Get full VAT config for one region (admin)
 *     tags: [VAT]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: regionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Full VAT config including scoped product/category ids
 *       404:
 *         description: Region not found
 */
router.get(
  '/:regionId',
  verifyAdminOrManager,
  requireManagerPermission('SETTINGS'),
  regionIdParam,
  handleValidationErrors,
  getVatConfig
);

/**
 * @swagger
 * /vat/{regionId}:
 *   put:
 *     summary: Update VAT config for one region (admin)
 *     tags: [VAT]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: regionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled: { type: boolean }
 *               ratePercent: { type: number, example: 5 }
 *               inclusive: { type: boolean, description: "true = prices already include VAT" }
 *               appliesTo: { type: string, enum: [ALL_PRODUCTS, SPECIFIC_PRODUCTS, SPECIFIC_CATEGORIES] }
 *               productIds: { type: array, items: { type: string } }
 *               categoryIds: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: VAT config updated
 *       400:
 *         description: Invalid rate / scope
 *       404:
 *         description: Region not found
 */
router.put(
  '/:regionId',
  verifyAdminOrManager,
  requireManagerPermission('SETTINGS'),
  regionIdParam,
  handleValidationErrors,
  updateVatConfig
);

module.exports = router;
