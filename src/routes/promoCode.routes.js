const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const promoCodeController = require('../controllers/promoCode.controller');
const { verifyToken } = require('../middleware/auth');
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
const { handleValidationErrors } = require('../middleware/validate');
const { publicLimiter, authLimiter } = require('../middleware/rateLimit');

/**
 * @swagger
 * tags:
 *   name: Promo codes
 *   description: |
 *     Admin-managed discount / promo codes.
 *
 *     ### Admin (requires ADMIN or MANAGER with `PROMO_CODES` permission)
 *     Full CRUD, list with search and status filter (`active`, `scheduled`, `expired`, `inactive`).
 *
 *     ### Scope
 *     - `ALL_PRODUCTS` — discount applies to every item in the cart.
 *     - `SPECIFIC_PRODUCTS` — only the products listed in `productIds`.
 *     - `SPECIFIC_CATEGORIES` — any product whose `categoryId` is in `categoryIds`.
 *
 *     ### Discount types
 *     - `PERCENTAGE` — `discountValue` is 0–100; cap it with optional `maxDiscountAmount`.
 *     - `FIXED` — `discountValue` is a flat amount in the store currency.
 *
 *     ### Rules
 *     - `minOrderAmount` / `maxOrderAmount` — cart subtotal bounds.
 *     - `startsAt` / `expiresAt` — availability window (ISO datetime, UTC).
 *     - `usageLimit` — total uses across all customers.
 *     - `usageLimitPerUser` — per-customer cap.
 *
 *     ### User
 *     - `GET /promo-codes/available` — codes currently usable (hides internal counters).
 *     - `POST /promo-codes/validate` — checks the code against the user's cart (or a body payload) and returns the computed discount. Does NOT record redemption; that happens at checkout.
 */

// ---------- validators ----------

const idParam = [param('id').isUUID().withMessage('Valid promo code ID required')];

const createValidation = [
  body('code').isString().trim().notEmpty().withMessage('code is required')
    .isLength({ min: 2, max: 40 }).withMessage('code must be 2–40 characters'),
  body('name').isString().trim().notEmpty().withMessage('name is required'),
  body('description').optional({ nullable: true }).isString(),
  body('discountType').isString().isIn(['PERCENTAGE', 'FIXED'])
    .withMessage('discountType must be PERCENTAGE or FIXED'),
  body('discountValue').isFloat({ gt: 0 }).withMessage('discountValue must be > 0'),
  body('maxDiscountAmount').optional({ nullable: true }).isFloat({ gt: 0 }),
  body('appliesTo').optional().isIn(['ALL_PRODUCTS', 'SPECIFIC_PRODUCTS', 'SPECIFIC_CATEGORIES']),
  body('productIds').optional().isArray(),
  body('productIds.*').optional().isUUID(),
  body('categoryIds').optional().isArray(),
  body('categoryIds.*').optional().isUUID(),
  body('minOrderAmount').optional({ nullable: true }).isFloat({ min: 0 }),
  body('maxOrderAmount').optional({ nullable: true }).isFloat({ min: 0 }),
  body('startsAt').optional({ nullable: true }).isISO8601(),
  body('expiresAt').optional({ nullable: true }).isISO8601(),
  body('usageLimit').optional({ nullable: true }).isInt({ min: 1 }),
  body('usageLimitPerUser').optional({ nullable: true }).isInt({ min: 1 }),
  body('isActive').optional().isBoolean(),
];

const updateValidation = [
  ...idParam,
  body('code').optional().isString().trim().notEmpty()
    .isLength({ min: 2, max: 40 }).withMessage('code must be 2–40 characters'),
  body('name').optional().isString().trim().notEmpty(),
  body('description').optional({ nullable: true }).isString(),
  body('discountType').optional().isIn(['PERCENTAGE', 'FIXED']),
  body('discountValue').optional().isFloat({ gt: 0 }),
  body('maxDiscountAmount').optional({ nullable: true }).isFloat({ gt: 0 }),
  body('appliesTo').optional().isIn(['ALL_PRODUCTS', 'SPECIFIC_PRODUCTS', 'SPECIFIC_CATEGORIES']),
  body('productIds').optional().isArray(),
  body('productIds.*').optional().isUUID(),
  body('categoryIds').optional().isArray(),
  body('categoryIds.*').optional().isUUID(),
  body('minOrderAmount').optional({ nullable: true }).isFloat({ min: 0 }),
  body('maxOrderAmount').optional({ nullable: true }).isFloat({ min: 0 }),
  body('startsAt').optional({ nullable: true }).isISO8601(),
  body('expiresAt').optional({ nullable: true }).isISO8601(),
  body('usageLimit').optional({ nullable: true }).isInt({ min: 1 }),
  body('usageLimitPerUser').optional({ nullable: true }).isInt({ min: 1 }),
  body('isActive').optional().isBoolean(),
];

const listValidation = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('search').optional().isString(),
  query('status').optional().isIn(['active', 'expired', 'scheduled', 'inactive']),
];

const validateCodeValidation = [
  body('code').isString().trim().notEmpty().withMessage('code is required'),
  body('items').optional().isArray(),
  body('items.*.productId').optional().isUUID(),
  body('items.*.quantity').optional().isInt({ min: 1 }),
  body('items.*.price').optional().isFloat({ min: 0 }),
];

// ---------- user-facing (must come before /:id to not be shadowed) ----------

/**
 * @swagger
 * /promo-codes/available:
 *   get:
 *     summary: List promo codes currently available to the signed-in user
 *     description: |
 *       Returns active promo codes within their availability window that the user has not yet
 *       exhausted (per-user limit). Internal counters (`usageCount`, `usageLimit`, etc.) are
 *       omitted. Requires a user JWT.
 *     tags: [Promo codes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 20 }
 *     responses:
 *       200:
 *         description: Available promo codes
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       401: { description: Unauthorized }
 */
router.get(
  '/available',
  authLimiter,
  verifyToken,
  promoCodeController.listAvailablePromoCodes,
);

/**
 * @swagger
 * /promo-codes/validate:
 *   post:
 *     summary: Validate a promo code and preview the discount
 *     description: |
 *       Validates the code against the user's cart (default) or a payload of `items`, and returns
 *       the calculated discount. **Does not** record redemption — that happens at order checkout.
 *
 *       **Body**
 *       - `code` (required) — the promo code the user typed.
 *       - `items` (optional) — preview against an ad-hoc list of `{ productId, quantity, price? }`.
 *         If omitted, the user's saved cart is used. If `price` or `categoryId` are missing they
 *         are hydrated from the product record server-side.
 *     tags: [Promo codes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/PromoCodeValidateInput' }
 *           examples:
 *             useCart:
 *               summary: Validate against the user's cart
 *               value: { code: RAMADAN10 }
 *             adhoc:
 *               summary: Validate against a custom item list
 *               value:
 *                 code: FREESHIP
 *                 items:
 *                   - productId: 550e8400-e29b-41d4-a716-446655440000
 *                     quantity: 2
 *     responses:
 *       200:
 *         description: Promo code valid — returns discount breakdown
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *             example:
 *               success: true
 *               message: Promo code is valid
 *               data:
 *                 promoCode:
 *                   id: 550e8400-e29b-41d4-a716-446655440000
 *                   code: RAMADAN10
 *                   name: Ramadan 10%
 *                   discountType: PERCENTAGE
 *                   discountValue: 10
 *                   appliesTo: ALL_PRODUCTS
 *                 cartSubtotal: 600
 *                 eligibleSubtotal: 600
 *                 discountAmount: 60
 *                 total: 540
 *                 eligibleProductIds: [550e8400-e29b-41d4-a716-446655440000]
 *       400:
 *         description: Invalid / expired / ineligible — see `message`
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401: { description: Unauthorized }
 *       404: { description: Promo code not found }
 */
router.post(
  '/validate',
  authLimiter,
  verifyToken,
  validateCodeValidation,
  handleValidationErrors,
  promoCodeController.validatePromoCode,
);

// ---------- admin ----------

/**
 * @swagger
 * /promo-codes:
 *   post:
 *     summary: Create a promo code (admin)
 *     description: |
 *       Create a new discount / promo code. Requires ADMIN or MANAGER with `PROMO_CODES`.
 *
 *       When `appliesTo` is `SPECIFIC_PRODUCTS`, pass `productIds` (UUIDs from `GET /products`).
 *       When `appliesTo` is `SPECIFIC_CATEGORIES`, pass `categoryIds` (UUIDs from `GET /categories`).
 *     tags: [Promo codes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/PromoCodeCreate' }
 *           examples:
 *             percentageAllProducts:
 *               summary: 10% off everything, Ramadan window
 *               value:
 *                 code: RAMADAN10
 *                 name: Ramadan 10% off
 *                 description: Store-wide Ramadan promotion
 *                 discountType: PERCENTAGE
 *                 discountValue: 10
 *                 maxDiscountAmount: 50
 *                 appliesTo: ALL_PRODUCTS
 *                 minOrderAmount: 100
 *                 startsAt: 2026-03-10T00:00:00Z
 *                 expiresAt: 2026-04-10T00:00:00Z
 *                 usageLimit: 500
 *                 usageLimitPerUser: 1
 *                 isActive: true
 *             fixedOver500:
 *               summary: 50 AED off orders above 500
 *               value:
 *                 code: SAVE50
 *                 name: 50 AED off above 500
 *                 discountType: FIXED
 *                 discountValue: 50
 *                 appliesTo: ALL_PRODUCTS
 *                 minOrderAmount: 500
 *             specificCategory:
 *               summary: 15% off a specific category
 *               value:
 *                 code: DRESSES15
 *                 name: 15% off dresses
 *                 discountType: PERCENTAGE
 *                 discountValue: 15
 *                 appliesTo: SPECIFIC_CATEGORIES
 *                 categoryIds: ["550e8400-e29b-41d4-a716-446655440000"]
 *     responses:
 *       201:
 *         description: Promo code created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400: { description: Validation failed }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden (missing PROMO_CODES permission) }
 *       409: { description: A promo code with this code already exists }
 */
router.post(
  '/',
  verifyAdminOrManager,
  requireManagerPermission('PROMO_CODES'),
  createValidation,
  handleValidationErrors,
  promoCodeController.createPromoCode,
);

/**
 * @swagger
 * /promo-codes:
 *   get:
 *     summary: List promo codes (admin)
 *     description: Paginated list with optional search and status filter.
 *     tags: [Promo codes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 10 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Case-insensitive match on `code` or `name`
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, expired, scheduled, inactive] }
 *         description: |
 *           - `active`: isActive true and within startsAt/expiresAt window
 *           - `expired`: expiresAt in the past
 *           - `scheduled`: startsAt in the future
 *           - `inactive`: isActive false
 *     responses:
 *       200:
 *         description: Promo codes
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get(
  '/',
  verifyAdminOrManager,
  requireManagerPermission('PROMO_CODES'),
  listValidation,
  handleValidationErrors,
  promoCodeController.listPromoCodes,
);

/**
 * @swagger
 * /promo-codes/{id}:
 *   get:
 *     summary: Get a promo code by ID (admin)
 *     tags: [Promo codes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Promo code
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       404: { description: Not found }
 */
router.get(
  '/:id',
  verifyAdminOrManager,
  requireManagerPermission('PROMO_CODES'),
  idParam,
  handleValidationErrors,
  promoCodeController.getPromoCodeById,
);

/**
 * @swagger
 * /promo-codes/{id}:
 *   put:
 *     summary: Update a promo code (admin)
 *     description: |
 *       Partial update — send only fields to change. Sending `productIds` or `categoryIds`
 *       replaces that entire list for the respective scope. Changing `appliesTo` clears the
 *       other scope's links.
 *     tags: [Promo codes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/PromoCodeUpdate' }
 *     responses:
 *       200:
 *         description: Promo code updated
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400: { description: Validation failed }
 *       404: { description: Not found }
 *       409: { description: Code already in use }
 */
router.put(
  '/:id',
  verifyAdminOrManager,
  requireManagerPermission('PROMO_CODES'),
  updateValidation,
  handleValidationErrors,
  promoCodeController.updatePromoCode,
);

/**
 * @swagger
 * /promo-codes/{id}:
 *   delete:
 *     summary: Delete a promo code (admin)
 *     description: Permanently removes the promo code. Linked product / category rows and usage history cascade.
 *     tags: [Promo codes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Deleted
 *       404: { description: Not found }
 */
router.delete(
  '/:id',
  verifyAdminOrManager,
  requireManagerPermission('PROMO_CODES'),
  idParam,
  handleValidationErrors,
  promoCodeController.deletePromoCode,
);

module.exports = router;
