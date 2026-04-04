const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();
const orderController = require('../controllers/order.controller');
const { verifyToken } = require('../middleware/auth');
const {
  verifyAdminOrManager,
  requireManagerPermission,
  attachOrderStaffAccess,
} = require('../middleware/managerAuth');
const { handleValidationErrors } = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimit');

/**
 * @swagger
 * tags:
 *   name: Orders
 *   description: Checkout and order management. User JWT for checkout and viewing own order; admin JWT for list and status update.
 */

const idParam = [param('id').isUUID().withMessage('Valid order ID required')];
const statusBody = [
  body('status')
    .isIn(['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'])
    .withMessage('Invalid status'),
];

/**
 * @swagger
 * /orders/checkout:
 *   post:
 *     summary: Create order from cart (checkout)
 *     description: Creates an order from the current user's cart, then clears the cart. Requires user JWT. Fails if cart is empty.
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Order created successfully
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *             example:
 *               success: true
 *               message: Order created successfully
 *               data:
 *                 id: 550e8400-e29b-41d4-a716-446655440000
 *                 userId: "..."
 *                 totalAmount: 99.97
 *                 status: PENDING
 *                 items: []
 *       400:
 *         description: Cart is empty
 */
router.post(
  '/checkout',
  verifyToken,
  authLimiter,
  handleValidationErrors,
  orderController.createOrder
);

/**
 * @swagger
 * /orders/history:
 *   get:
 *     summary: My order history (customer)
 *     description: Paginated list of the authenticated user's orders (newest first). Optional status filter. Use **GET /orders/{id}** for full line items.
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, CONFIRMED, PROCESSING, SHIPPED, DELIVERED, CANCELLED]
 *     responses:
 *       200:
 *         description: Paginated order summaries with item counts
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 */
router.get(
  '/history',
  verifyToken,
  authLimiter,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED']),
  ],
  handleValidationErrors,
  orderController.getMyOrderHistory
);

/**
 * @swagger
 * /orders/admin/history:
 *   get:
 *     summary: Order history / audit log (admin)
 *     description: |
 *       Paginated orders across all customers with user details. Set **includeItems=true** to load full line items (product snapshots) for support and auditing.
 *       Optional filters: **userId**, **status**, **dateFrom**, **dateTo** (ISO 8601).
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10, maximum: 100 }
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, CONFIRMED, PROCESSING, SHIPPED, DELIVERED, CANCELLED]
 *       - in: query
 *         name: userId
 *         schema: { type: string, format: uuid }
 *         description: Filter by customer user ID
 *       - in: query
 *         name: dateFrom
 *         schema: { type: string, format: date-time }
 *         description: Orders placed on or after this instant (ISO 8601)
 *       - in: query
 *         name: dateTo
 *         schema: { type: string, format: date-time }
 *         description: Orders placed on or before this instant (ISO 8601)
 *       - in: query
 *         name: includeItems
 *         schema: { type: boolean, default: false }
 *         description: When true, each order includes full **items** with product display payload (heavier response)
 *     responses:
 *       200:
 *         description: Paginated orders with optional line items
 */
router.get(
  '/admin/history',
  verifyAdminOrManager,
  requireManagerPermission('ORDERS'),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED']),
    query('userId').optional().isUUID(),
    query('dateFrom').optional().isISO8601(),
    query('dateTo').optional().isISO8601(),
    query('includeItems')
      .optional()
      .isIn(['true', 'false', '1', '0'])
      .withMessage('includeItems must be true or false'),
  ],
  handleValidationErrors,
  orderController.getAdminOrderHistory
);

/**
 * @swagger
 * /orders:
 *   get:
 *     summary: List all orders (admin)
 *     description: Paginated list of orders. Optional filter by status. Requires admin JWT.
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *         description: Items per page (max 100)
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, CONFIRMED, PROCESSING, SHIPPED, DELIVERED, CANCELLED]
 *         description: Filter by order status
 *     responses:
 *       200:
 *         description: Paginated orders
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: Orders fetched successfully
 *               data: []
 *               meta: { pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } }
 */
router.get(
  '/',
  verifyAdminOrManager,
  requireManagerPermission('ORDERS'),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED']),
  ],
  handleValidationErrors,
  orderController.getAllOrdersAdmin
);

/**
 * @swagger
 * /orders/{id}/status:
 *   get:
 *     summary: Get order status (lightweight)
 *     description: |
 *       Returns **id**, **status**, timestamps, **totalAmount**, and a small **progress** object for UI (typical fulfillment flow).
 *       Customers may only read their own orders; admin and managers with **ORDERS** may read any.
 *       Intended for post-checkout polling without loading full line items.
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Status snapshot
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - { $ref: '#/components/schemas/ApiSuccess' }
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/OrderStatusSnapshot' }
 *       404:
 *         description: Order not found
 */
router.get(
  '/:id/status',
  verifyToken,
  attachOrderStaffAccess,
  authLimiter,
  idParam,
  handleValidationErrors,
  orderController.getOrderStatusOnly
);

/**
 * @swagger
 * /orders/{id}:
 *   get:
 *     summary: Get order by ID
 *     description: Returns one order. User can only get their own; admin can get any. Requires JWT.
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         example: 550e8400-e29b-41d4-a716-446655440000
 *     responses:
 *       200:
 *         description: Order details with items
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *             example:
 *               success: true
 *               data:
 *                 id: 550e8400-e29b-41d4-a716-446655440000
 *                 totalAmount: 99.97
 *                 status: PENDING
 *                 items: []
 *       403:
 *         description: Not allowed to view this order
 *       404:
 *         description: Order not found
 */
router.get(
  '/:id',
  verifyToken,
  attachOrderStaffAccess,
  authLimiter,
  idParam,
  handleValidationErrors,
  orderController.getOrderById
);

/**
 * @swagger
 * /orders/{id}/status:
 *   patch:
 *     summary: Update order status (admin)
 *     description: |
 *       Set order status (admin/manager with ORDERS). Values: PENDING, CONFIRMED, PROCESSING, SHIPPED, DELIVERED, CANCELLED.
 *       **PENDING → CONFIRMED** subtracts **Product.quantity** from each line (transactional). **409** if any line exceeds available stock.
 *       **CANCELLED** always restores stock when **inventoryDeducted** was true (e.g. after confirm). Revert to **PENDING** from a shipped/confirmed track also restores. Response includes **inventoryDeducted**.
 *     tags: [Orders]
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
 *           schema:
 *             $ref: '#/components/schemas/OrderStatusUpdate'
 *           example:
 *             status: CONFIRMED
 *     responses:
 *       200:
 *         description: Status updated
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       404:
 *         description: Order not found
 *       409:
 *         description: Insufficient stock when confirming (see **errors** array per product line)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       400:
 *         description: Order references a deleted product
 */
router.patch(
  '/:id/status',
  verifyAdminOrManager,
  requireManagerPermission('ORDERS'),
  idParam,
  statusBody,
  handleValidationErrors,
  orderController.updateOrderStatus
);

module.exports = router;
