const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();
const productController = require('../controllers/product.controller');
const { verifyAdmin } = require('../middleware/auth');
const { handleValidationErrors } = require('../middleware/validate');
const { publicLimiter } = require('../middleware/rateLimit');

/**
 * @swagger
 * tags:
 *   name: Products
 *   description: Products by category. Admin CRUD; public list and detail. Pagination supported.
 */

/**
 * @swagger
 * /products:
 *   post:
 *     summary: Create a product (admin)
 *     description: Create a new product. Category is optional; admin can assign or change it later via update. Requires admin JWT.
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ProductCreate'
 *           example:
 *             title: Summer Dress
 *             subtitle: Light cotton
 *             description: Comfortable summer dress
 *             price: 49.99
 *             discountedPrice: 39.99
 *     responses:
 *       201:
 *         description: Product created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       404:
 *         description: Category not found
 */
const createValidation = [
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('subtitle').optional().trim(),
  body('description').optional().trim(),
  body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  body('discountedPrice').optional().isFloat({ min: 0 }),
  body('categoryId').optional().isUUID().withMessage('categoryId must be a valid UUID when provided'),
  body('images')
    .optional()
    .isArray()
    .withMessage('images must be an array of image URLs'),
  body('images')
    .optional()
    .custom((val) => !Array.isArray(val) || val.length <= 10)
    .withMessage('Maximum 10 images per product'),
  body('images.*')
    .optional()
    .isString()
    .trim()
    .notEmpty()
    .withMessage('Each image must be a non-empty URL string'),
];

const updateValidation = [
  param('id').isUUID().withMessage('Valid product ID required'),
  body('title').optional().trim().notEmpty(),
  body('subtitle').optional().trim(),
  body('description').optional().trim(),
  body('price').optional().isFloat({ min: 0 }),
  body('discountedPrice').optional().isFloat({ min: 0 }),
  body('categoryId').optional().isUUID(),
  body('images')
    .optional()
    .isArray()
    .withMessage('images must be an array of image URLs'),
  body('images')
    .optional()
    .custom((val) => !Array.isArray(val) || val.length <= 10)
    .withMessage('Maximum 10 images per product'),
  body('images.*')
    .optional()
    .isString()
    .trim()
    .notEmpty()
    .withMessage('Each image must be a non-empty URL string'),
];

const idParam = [param('id').isUUID().withMessage('Valid product ID required')];
const categoryIdParam = [param('categoryId').isUUID().withMessage('Valid category ID required')];
const pagination = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
];

router.post(
  '/',
  verifyAdmin,
  createValidation,
  handleValidationErrors,
  productController.createProduct
);

/**
 * @swagger
 * /products/{id}:
 *   put:
 *     summary: Update a product (admin)
 *     description: Update product fields or move to another category. Requires admin JWT.
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title: { type: string }
 *               subtitle: { type: string }
 *               description: { type: string }
 *               image: { type: string }
 *               price: { type: number }
 *               discountedPrice: { type: number }
 *               categoryId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Product updated
 *       404:
 *         description: Product or category not found
 */
router.put(
  '/:id',
  verifyAdmin,
  updateValidation,
  handleValidationErrors,
  productController.updateProduct
);

/**
 * @swagger
 * /products/{id}:
 *   delete:
 *     summary: Delete a product (admin)
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Product deleted
 *       404:
 *         description: Product not found
 */
router.delete(
  '/:id',
  verifyAdmin,
  idParam,
  handleValidationErrors,
  productController.deleteProduct
);

/**
 * @swagger
 * /products:
 *   get:
 *     summary: List all products (paginated)
 *     description: Returns paginated products. Use query params page and limit.
 *     tags: [Products]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *         description: Items per page (max 100)
 *     responses:
 *       200:
 *         description: Paginated products
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiSuccess'
 *             example:
 *               success: true
 *               message: Products fetched successfully
 *               data: []
 *               meta:
 *                 pagination: { page: 1, limit: 10, total: 0, totalPages: 0 }
 */
router.get('/', publicLimiter, pagination, handleValidationErrors, productController.getAllProducts);

/**
 * @swagger
 * /products/category/{categoryId}:
 *   get:
 *     summary: List products by category (paginated)
 *     description: Returns products in the given category. Public, rate-limited.
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: categoryId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *     responses:
 *       200:
 *         description: Paginated products in category
 */
router.get(
  '/category/:categoryId',
  publicLimiter,
  categoryIdParam,
  pagination,
  handleValidationErrors,
  productController.getProductsByCategory
);

/**
 * @swagger
 * /products/{id}:
 *   get:
 *     summary: Get single product details
 *     description: Returns one product with category info. Public, rate-limited.
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Product details
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 id: 550e8400-e29b-41d4-a716-446655440000
 *                 title: Summer Dress
 *                 price: 49.99
 *                 discountedPrice: 39.99
 *                 category: { id: ..., title: Women }
 *       404:
 *         description: Product not found
 */
router.get(
  '/:id',
  publicLimiter,
  idParam,
  handleValidationErrors,
  productController.getProductById
);

module.exports = router;
