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
 *     summary: Place order (checkout)
 *     description: |
 *       Creates an order from the current user's cart, then clears the cart. Requires user JWT.
 *
 *       **Address** — provide either `addressId` (a saved address UUID) **or** an inline `shippingAddress` object. Inline form requires only `streetAddress`; `city` / `country` etc. are optional.
 *
 *       **Recipient name & phone** — **do not send them**. The server reads `fullName` and `phone` from the user profile (collected at signup / Google / Apple) and stamps them onto the order's `shippingAddress` snapshot automatically.
 *
 *       **Payment** — `paymentMethod` is optional and defaults to `COD` (Cash on Delivery), which places the order instantly as `PENDING`.
 *
 *       Pass `MYFATOORAH` to pay online (Apple Pay / cards). The order is **not placed yet**: it's created as `status: AWAITING_PAYMENT` / `paymentStatus: UNPAID`, the cart is **kept**, and it's hidden from order history until paid. Next, call **POST /orders/{id}/pay** to get the payment URL. Once payment succeeds the order becomes `CONFIRMED` / `PAID` and the cart is cleared.
 *
 *       **Promo code** — optional. Pass the code string to apply a discount. Returns `400` with a descriptive message if invalid.
 *
 *       **Region** — send the **X-Region** header to stamp the order with the region it was placed in (used for regional analytics). Falls back to the user's own region, then the default region.
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/XRegionHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               addressId:
 *                 type: string
 *                 format: uuid
 *                 description: ID of a saved address. Mutually exclusive with shippingAddress.
 *               shippingAddress:
 *                 type: object
 *                 description: |
 *                   Inline address used when `addressId` is not provided. **`streetAddress` is the only required field.** Recipient `fullName` / `phone` are server-filled from the user profile and should be omitted.
 *                 required: [streetAddress]
 *                 properties:
 *                   streetAddress: { type: string, example: "Villa 14, Al Wasl Road" }
 *                   apartment: { type: string, nullable: true, example: null }
 *                   city: { type: string, nullable: true, example: "Dubai" }
 *                   state: { type: string, nullable: true, example: "Dubai" }
 *                   postalCode: { type: string, nullable: true, example: null }
 *                   country: { type: string, nullable: true, example: "United Arab Emirates" }
 *                   fullName: { type: string, nullable: true, description: "Optional / ignored — sourced from user profile" }
 *                   phone: { type: string, nullable: true, description: "Optional / ignored — sourced from user profile" }
 *               paymentMethod:
 *                 type: string
 *                 enum: [COD, MYFATOORAH]
 *                 default: COD
 *                 description: "COD = Cash on Delivery. MYFATOORAH = pay online (Apple Pay / cards) — then call POST /orders/{id}/pay."
 *               promoCode:
 *                 type: string
 *                 nullable: true
 *                 example: "SAVE10"
 *                 description: Optional promo code to apply a discount.
 *           examples:
 *             saved_address:
 *               summary: Using a saved address
 *               value:
 *                 addressId: "550e8400-e29b-41d4-a716-446655440000"
 *                 paymentMethod: COD
 *                 promoCode: "SAVE10"
 *             inline_address_minimal:
 *               summary: Inline address (minimal — only streetAddress)
 *               value:
 *                 shippingAddress:
 *                   streetAddress: "Villa 14, Al Wasl Road"
 *                 paymentMethod: COD
 *             inline_address_full:
 *               summary: Inline address with city / country
 *               value:
 *                 shippingAddress:
 *                   streetAddress: "Villa 14, Al Wasl Road"
 *                   apartment: "Apt 401"
 *                   city: "Dubai"
 *                   country: "United Arab Emirates"
 *                 paymentMethod: COD
 *             online_payment_myfatoorah:
 *               summary: Online payment (Apple Pay / cards) — then call POST /orders/{id}/pay
 *               value:
 *                 shippingAddress:
 *                   streetAddress: "Villa 14, Al Wasl Road"
 *                   city: "Dubai"
 *                 paymentMethod: MYFATOORAH
 *     responses:
 *       201:
 *         description: Order placed successfully
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *             example:
 *               success: true
 *               message: Order placed successfully
 *               data:
 *                 id: 550e8400-e29b-41d4-a716-446655440000
 *                 totalAmount: 89.97
 *                 discountAmount: 10.00
 *                 appliedPromoCode: "SAVE10"
 *                 paymentMethod: COD
 *                 status: PENDING
 *                 shippingAddress:
 *                   fullName: "Ahmed Al Mansouri"
 *                   phone: "+971501234567"
 *                   streetAddress: "Villa 14, Al Wasl Road"
 *                   city: "Dubai"
 *                   country: "United Arab Emirates"
 *                 items: []
 *       400:
 *         description: Cart empty, address missing/invalid, or promo code error
 */
const checkoutBody = [
  body('addressId').optional().isUUID().withMessage('addressId must be a valid UUID'),
  body('paymentMethod')
    .optional()
    .isIn(['COD', 'MYFATOORAH'])
    .withMessage('paymentMethod must be COD or MYFATOORAH'),
  body('promoCode').optional().trim().isLength({ max: 50 }).withMessage('promoCode too long'),
  body('shippingAddress').optional().isObject().withMessage('shippingAddress must be an object'),
  body('shippingAddress.fullName').optional().trim(),
  body('shippingAddress.phone').optional().trim(),
  body('shippingAddress.streetAddress').optional().trim(),
  body('shippingAddress.apartment').optional().trim(),
  body('shippingAddress.city').optional().trim(),
  body('shippingAddress.state').optional().trim(),
  body('shippingAddress.postalCode').optional().trim(),
  body('shippingAddress.country').optional().trim(),
];

router.post(
  '/checkout',
  verifyToken,
  authLimiter,
  checkoutBody,
  handleValidationErrors,
  orderController.createOrder
);

/**
 * @swagger
 * /orders/buy-now:
 *   post:
 *     summary: Buy a single product directly (Buy Now — does NOT use the cart)
 *     description: |
 *       Places an order for ONE product without touching the user's cart. Use this for the
 *       "Buy with Apple Pay" / "Buy Now" button on a product page. Same options as checkout
 *       (paymentMethod, address, promoCode). For `MYFATOORAH` the order is `AWAITING_PAYMENT`
 *       — then call `POST /orders/{id}/payment-session` + `POST /orders/{id}/pay-session` (native
 *       Apple Pay) or `POST /orders/{id}/pay` (hosted page). The cart is left exactly as it was.
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/XRegionHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [productId]
 *             properties:
 *               productId: { type: string, format: uuid }
 *               quantity: { type: integer, minimum: 1, default: 1 }
 *               paymentMethod: { type: string, enum: [COD, MYFATOORAH] }
 *               addressId: { type: string, format: uuid }
 *               shippingAddress: { type: object }
 *               promoCode: { type: string }
 *               message: { type: string }
 *     responses:
 *       201: { description: Order placed (or AWAITING_PAYMENT for online) }
 *       400: { description: Validation / availability error }
 */
const buyNowBody = [
  body('productId').isUUID().withMessage('Valid productId is required'),
  body('quantity').optional().isInt({ min: 1 }).withMessage('quantity must be a positive integer'),
  body('paymentMethod').optional().isIn(['COD', 'MYFATOORAH']).withMessage('paymentMethod must be COD or MYFATOORAH'),
  body('addressId').optional().isUUID().withMessage('addressId must be a valid UUID'),
  body('shippingAddress').optional().isObject().withMessage('shippingAddress must be an object'),
  body('promoCode').optional().trim().isLength({ max: 50 }).withMessage('promoCode too long'),
  body('message').optional().trim(),
];
router.post(
  '/buy-now',
  verifyToken,
  authLimiter,
  buyNowBody,
  handleValidationErrors,
  orderController.buyNow
);

/**
 * @swagger
 * /orders/{id}/pay:
 *   post:
 *     summary: Start online payment (MyFatoorah — Apple Pay / cards)
 *     description: |
 *       Creates a MyFatoorah payment for a PENDING order whose `paymentMethod` is `MYFATOORAH`
 *       and returns a hosted **paymentUrl**. Open it in a webview/browser; Apple Pay appears on
 *       iPhones, card entry elsewhere. The order is only marked paid after MyFatoorah's redirect
 *       hits the callback and the server re-verifies the payment. Requires user JWT.
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
 *         description: Payment created — open paymentUrl
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: Payment created
 *               data: { paymentUrl: "https://apitest.myfatoorah.com/...", invoiceId: "1234567" }
 *       400:
 *         description: Order not payable (wrong method/state, zero total, or already paid)
 *       404:
 *         description: Order not found
 *       502:
 *         description: Payment gateway error
 *       503:
 *         description: Online payment not enabled (MyFatoorah not configured)
 */
router.post(
  '/:id/pay',
  verifyToken,
  authLimiter,
  idParam,
  handleValidationErrors,
  orderController.initiatePayment
);

/**
 * @swagger
 * /orders/{id}/payment-session:
 *   post:
 *     summary: Create a MyFatoorah session for native Apple Pay (step 1)
 *     description: |
 *       Native Apple Pay flow for the mobile app. Returns a one-time `sessionId` the
 *       MyFatoorah SDK uses to show the **native Apple Pay sheet**. The secret API key
 *       stays on the server. Order must be `AWAITING_PAYMENT` / unpaid / MYFATOORAH.
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ sessionId, countryCode }" }
 */
router.post(
  '/:id/payment-session',
  verifyToken,
  authLimiter,
  idParam,
  handleValidationErrors,
  orderController.createPaymentSession
);

/**
 * @swagger
 * /orders/{id}/pay-session:
 *   post:
 *     summary: Execute a native Apple Pay payment and place the order (step 2)
 *     description: |
 *       The app sends back the `sessionId` (now carrying the Apple Pay token). The server
 *       executes the charge, re-verifies it with MyFatoorah, and on success marks the order
 *       PAID/CONFIRMED (deducting stock). Idempotent. `isPaid: true` = order placed.
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId]
 *             properties:
 *               sessionId: { type: string }
 *     responses:
 *       200: { description: "Paid — order placed. data: { isPaid: true, orderId, status, paymentStatus: PAID }" }
 *       402: { description: "Payment not completed (declined). Show failure / allow retry." }
 *       409: { description: "A payment is already in progress for this order (double-tap guard)." }
 *       400: { description: "Missing sessionId or order not payable." }
 *       404: { description: "Order not found." }
 */
router.post(
  '/:id/pay-session',
  verifyToken,
  authLimiter,
  idParam,
  [body('sessionId').isString().trim().notEmpty().withMessage('sessionId is required')],
  handleValidationErrors,
  orderController.executeApplePay
);

/**
 * @swagger
 * /orders/payment/callback:
 *   get:
 *     summary: MyFatoorah payment callback (success/return URL)
 *     description: |
 *       MyFatoorah redirects the customer's browser here after payment, appending `paymentId`.
 *       The server calls GetPaymentStatus to confirm the payment, marks the order PAID and
 *       CONFIRMED on success, and returns a small result page. **Public** (no JWT) — MyFatoorah
 *       calls it. Never trust this redirect alone; the server re-verifies before confirming.
 *     tags: [Orders]
 *     parameters:
 *       - in: query
 *         name: paymentId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: HTML result page
 */
router.get('/payment/callback', orderController.paymentCallback);

/**
 * @swagger
 * /orders/payment/error:
 *   get:
 *     summary: MyFatoorah payment error/cancel URL
 *     description: Landing page for failed or cancelled payments. **Public** (no JWT).
 *     tags: [Orders]
 *     responses:
 *       200:
 *         description: HTML result page
 */
router.get('/payment/error', orderController.paymentError);

/**
 * @swagger
 * /orders/payment/webhook:
 *   post:
 *     summary: MyFatoorah webhook (server-to-server payment notification)
 *     description: |
 *       Reliable async confirmation from MyFatoorah, used when the customer's browser never
 *       returns (app closed, connection lost). Every event is re-verified via GetPaymentStatus,
 *       so a forged request cannot mark an order paid. Configure this URL in the MyFatoorah
 *       dashboard. **Public** (no JWT); optional HMAC signature via `MYFATOORAH_WEBHOOK_SECRET`.
 *     tags: [Orders]
 *     responses:
 *       200:
 *         description: Event received (always 200 for handled/ignored events)
 *       401:
 *         description: Signature verification failed (only when a webhook secret is set)
 */
router.post('/payment/webhook', orderController.paymentWebhook);

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
