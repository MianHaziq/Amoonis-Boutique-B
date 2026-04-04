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
 *     description: "Set order status (admin JWT). Allowed values - PENDING, CONFIRMED, PROCESSING, SHIPPED, DELIVERED, CANCELLED."
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
