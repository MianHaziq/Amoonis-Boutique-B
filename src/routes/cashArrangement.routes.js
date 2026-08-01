const express = require('express');
const router = express.Router();
const { param, body } = require('express-validator');
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
const { optionalAuth } = require('../middleware/auth');
const { resolveRegion } = require('../middleware/region');
const { publicLimiter, authLimiter } = require('../middleware/rateLimit');
const { handleValidationErrors } = require('../middleware/validate');
const {
  listConfigs,
  getPublicCashArrangementConfig,
  getCashArrangementConfig,
  updateCashArrangementConfig,
  resolveCashArrangement,
} = require('../controllers/cashArrangement.controller');

const regionIdParam = [param('regionId').isUUID().withMessage('Valid region ID required')];

const resolveValidation = [
  body('zoneId').optional({ nullable: true }).isUUID(),
  body('cartLines').optional().isArray(),
  body('cartLines.*.productId').optional().isUUID(),
];

/**
 * @swagger
 * tags:
 *   name: Cash Arrangement
 *   description: |
 *     "Add cash arrangement" — an optional checkout add-on where the customer requests a cash
 *     amount be delivered alongside the order, for an admin-configured service fee. Enablement
 *     (on/off, ALL_PRODUCTS/SPECIFIC_PRODUCTS/SPECIFIC_CATEGORIES scope, quick-pick cash
 *     amounts, banknote denomination presets) is ONE config per Region, mirroring VAT's shape.
 *     The region-wide FLAT fee (step size + margin %) is configured here too; finer
 *     product/category/zone overrides live on Product/Category and their per-region/per-zone
 *     rows (+ the delivery-zone PUT), resolved via utils/cashArrangementMath.js's precedence chain.
 */

/**
 * @swagger
 * /cash-arrangement/public:
 *   get:
 *     summary: Get public cash-arrangement enablement for the current region
 *     description: Enablement only (enabled, appliesTo, quickPickAmounts, denominations) — no cart/fee awareness. No auth.
 *     tags: [Cash Arrangement]
 *     parameters:
 *       - in: header
 *         name: X-Region
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Public cash arrangement config for the resolved region
 */
router.get('/public', publicLimiter, resolveRegion, getPublicCashArrangementConfig);

/**
 * @swagger
 * /cash-arrangement/resolve:
 *   post:
 *     summary: Resolve cash-arrangement eligibility + fee schedule for a cart
 *     description: |
 *       Body `{ zoneId?, cartLines?: [{productId}] }`. When `cartLines` is omitted and the
 *       caller is signed in, falls back to their stored cart (mirrors `POST /promo-codes/validate`).
 *       Returns `{eligible, feeStepAmount, feeMarginPercent, quickPickAmounts, denominations}` —
 *       what checkout uses to show (or hide) the "Add cash arrangement" section and preview the
 *       fee live as the customer picks/types an amount. The backend re-resolves authoritatively
 *       at order-creation time regardless of this preview.
 *     tags: [Cash Arrangement]
 *     parameters:
 *       - in: header
 *         name: X-Region
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Resolved eligibility + fee schedule
 *       400:
 *         description: No cart lines to preview against (guest with no body cartLines)
 */
router.post(
  '/resolve',
  authLimiter,
  optionalAuth,
  resolveRegion,
  resolveValidation,
  handleValidationErrors,
  resolveCashArrangement
);

/**
 * @swagger
 * /cash-arrangement:
 *   get:
 *     summary: List every region's cash-arrangement config (admin)
 *     tags: [Cash Arrangement]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All regions with their cash arrangement config
 */
router.get('/', verifyAdminOrManager, requireManagerPermission('CASH_ARRANGEMENT'), listConfigs);

/**
 * @swagger
 * /cash-arrangement/{regionId}:
 *   get:
 *     summary: Get full cash-arrangement config for one region (admin)
 *     tags: [Cash Arrangement]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: regionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Full config including scoped product/category ids
 *       404:
 *         description: Region not found
 */
router.get(
  '/:regionId',
  verifyAdminOrManager,
  requireManagerPermission('CASH_ARRANGEMENT'),
  regionIdParam,
  handleValidationErrors,
  getCashArrangementConfig
);

/**
 * @swagger
 * /cash-arrangement/{regionId}:
 *   put:
 *     summary: Update cash-arrangement enablement config for one region (admin)
 *     description: Updates enabled/appliesTo/scope/quick-pick amounts/denominations AND the region-wide flat fee (feeStepAmount/feeMarginPercent). Finer product/category/zone fee overrides are edited via product/category admin endpoints and the delivery-zone PUT.
 *     tags: [Cash Arrangement]
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
 *               appliesTo: { type: string, enum: [ALL_PRODUCTS, SPECIFIC_PRODUCTS, SPECIFIC_CATEGORIES] }
 *               productIds: { type: array, items: { type: string } }
 *               categoryIds: { type: array, items: { type: string } }
 *               quickPickAmounts: { type: array, items: { type: number } }
 *               denominations: { type: array, items: { type: number } }
 *               feeStepAmount: { type: number, nullable: true }
 *               feeMarginPercent: { type: number, nullable: true }
 *     responses:
 *       200:
 *         description: Config updated
 *       400:
 *         description: Invalid input / empty scope list
 *       404:
 *         description: Region not found
 */
router.put(
  '/:regionId',
  verifyAdminOrManager,
  requireManagerPermission('CASH_ARRANGEMENT'),
  regionIdParam,
  handleValidationErrors,
  updateCashArrangementConfig
);

module.exports = router;
