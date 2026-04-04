const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();
const cartController = require('../controllers/cart.controller');
const { verifyToken } = require('../middleware/auth');
const { handleValidationErrors } = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimit');

/**
 * @swagger
 * tags:
 *   name: Cart
 *   description: User cart. All endpoints require user JWT. Add items, update quantity/message, get cart, remove item, clear cart.
 */

router.use(verifyToken);
router.use(authLimiter);

const addValidation = [
  body('productId').isUUID().withMessage('Valid productId is required'),
  body('quantity').optional().isInt({ min: 1 }),
  body('message').optional().trim(),
];

const updateQtyValidation = [
  body('productId').isUUID().withMessage('Valid productId is required'),
  body('quantity').isInt({ min: 0 }).withMessage('Quantity must be 0 or more'),
];

const updateItemMessageValidation = [
  body('productId').isUUID().withMessage('Valid productId is required'),
  body('message').optional().trim(),
];

/**
 * @swagger
 * /cart:
 *   post:
 *     summary: Add item to cart
 *     description: Add a product to the current user's cart. Quantity defaults to 1. Optional per-item message (e.g. gift wrap).
 *     tags: [Cart]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CartAddBody'
 *           example:
 *             productId: 550e8400-e29b-41d4-a716-446655440000
 *             quantity: 2
 *             message: Gift wrap please
 *     responses:
 *       200:
 *         description: Item added; returns updated cart
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *             example:
 *               success: true
 *               message: Item added to cart
 *               data: { id: "...", items: [], totalAmount: 79.98, orderMessage: null }
 *       404:
 *         description: Product not found
 */
router.post('/', addValidation, handleValidationErrors, cartController.addToCart);

/**
 * @swagger
 * /cart/quantity:
 *   patch:
 *     summary: Update item quantity
 *     description: Set quantity for a product in the cart. Use quantity 0 to remove the item.
 *     tags: [Cart]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [productId, quantity]
 *             properties:
 *               productId: { type: string, format: uuid, example: 550e8400-e29b-41d4-a716-446655440000 }
 *               quantity: { type: integer, minimum: 0, example: 3 }
 *     responses:
 *       200:
 *         description: Quantity updated; returns updated cart
 *       404:
 *         description: Product not in cart or not found
 */
router.patch('/quantity', updateQtyValidation, handleValidationErrors, cartController.updateQuantity);

/**
 * @swagger
 * /cart/item/message:
 *   patch:
 *     summary: Update per-item message
 *     description: Update or clear the message for a specific product in the cart (e.g. gift note, engraving, "name john doe"). Use the same productId as in the cart. Send empty string or omit message to clear.
 *     tags: [Cart]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [productId]
 *             properties:
 *               productId:
 *                 type: string
 *                 format: uuid
 *                 description: ID of the product in the cart to update
 *                 example: "b0299163-001d-46d0-9492-2e5b3a4e96de"
 *               message:
 *                 type: string
 *                 description: New message for this line item. Omit or send empty string to clear.
 *                 example: "name John Doe"
 *           example:
 *             productId: "b0299163-001d-46d0-9492-2e5b3a4e96de"
 *             message: "name John Doe"
 *     responses:
 *       200:
 *         description: Item message updated; returns updated cart
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Item message updated" }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     items: { type: array }
 *                     totalAmount: { type: number }
 *                     orderMessage: { type: string, nullable: true }
 *       404:
 *         description: Product not in cart
 */
router.patch('/item/message', updateItemMessageValidation, handleValidationErrors, cartController.updateItemMessage);

/**
 * @swagger
 * /cart/message:
 *   patch:
 *     summary: Set order message
 *     description: Set or clear the optional message for the whole order (e.g. delivery instructions).
 *     tags: [Cart]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               orderMessage: { type: string, example: Leave at door }
 *     responses:
 *       200:
 *         description: Message updated; returns updated cart
 */
router.patch('/message', [
  body('orderMessage').optional().trim(),
], handleValidationErrors, cartController.updateOrderMessage);

/**
 * @swagger
 * /cart:
 *   get:
 *     summary: Get current cart
 *     description: Returns the authenticated user's cart with items, line totals, and total amount.
 *     tags: [Cart]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cart with items
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiSuccess'
 *             example:
 *               success: true
 *               data:
 *                 id: 550e8400-e29b-41d4-a716-446655440000
 *                 items: []
 *                 totalAmount: 0
 *                 orderMessage: null
 */
router.get('/', cartController.getCart);

/**
 * @swagger
 * /cart/item/{productId}:
 *   delete:
 *     summary: Remove item from cart
 *     description: Remove one product from the cart by product ID.
 *     tags: [Cart]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: productId
 *         required: true
 *         schema: { type: string, format: uuid }
 *         example: 550e8400-e29b-41d4-a716-446655440000
 *     responses:
 *       200:
 *         description: Item removed; returns updated cart
 *       404:
 *         description: Product not in cart
 */
router.delete('/item/:productId', [
  param('productId').isUUID().withMessage('Valid productId required'),
], handleValidationErrors, cartController.removeFromCart);

/**
 * @swagger
 * /cart:
 *   delete:
 *     summary: Clear cart
 *     description: Remove all items from the user's cart.
 *     tags: [Cart]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cart cleared
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: Cart cleared
 *               data: { id: "...", items: [], totalAmount: 0, orderMessage: null }
 */
router.delete('/', cartController.clearCart);

module.exports = router;
