const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();
const productController = require('../controllers/product.controller');
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
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
 *     description: |
 *       Create a new product.
 *       **Category:** To put the product in a specific category, add **`categoryId`** (UUID). Open **Categories → GET /categories**, copy the `id` of the desired category, and include it in this body. You can also leave it out and set **`categoryId`** later with **PUT /products/{id}**.
 *       **Images:** optional `images` array (up to 10 public HTTPS URLs in display order; first = primary thumbnail).
 *       Upload files with **POST /upload/image** (e.g. `?path=products`), then paste the returned `url` values into `images`.
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ProductCreate'
 *           examples:
 *             withImages:
 *               summary: With gallery (recommended)
 *               value:
 *                 title: Summer Dress
 *                 subtitle: Light cotton
 *                 categoryId: 550e8400-e29b-41d4-a716-446655440000
 *                 descriptions:
 *                   - description: Comfortable summer dress
 *                 price: 49.99
 *                 discountedPrice: 39.99
 *                 quantity: 10
 *                 images:
 *                   - https://cdn.example.com/products/dress-front.jpg
 *                   - https://cdn.example.com/products/dress-back.jpg
 *             inCategory:
 *               summary: In a specific category (no images)
 *               description: Use an id from GET /categories
 *               value:
 *                 title: Linen Shirt
 *                 subtitle: Casual fit
 *                 categoryId: 550e8400-e29b-41d4-a716-446655440000
 *                 descriptions:
 *                   - description: Breathable linen
 *                 price: 59.99
 *                 quantity: 8
 *             minimal:
 *               summary: Text and pricing only
 *               value:
 *                 title: Summer Dress
 *                 subtitle: Light cotton
 *                 descriptions:
 *                   - description: Comfortable summer dress
 *                 price: 49.99
 *                 discountedPrice: 39.99
 *                 quantity: 10
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
  body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  body('discountedPrice').optional().isFloat({ min: 0 }),
  body('quantity').optional().isInt({ min: 0 }).withMessage('Quantity must be a non-negative integer'),
  body('categoryId').optional().isUUID().withMessage('categoryId must be a valid UUID when provided'),
  body('descriptions').optional().isArray().withMessage('descriptions must be an array'),
  body('descriptions.*.title').optional().trim(),
  body('descriptions.*.description').optional().trim(),
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
  body('descriptions').optional().custom((arr) => {
    if (!Array.isArray(arr)) return true;
    return arr.every((d) => d && typeof d === 'object' && (d.description != null && String(d.description).trim() !== ''));
  }).withMessage('Each description item must have a non-empty description field'),
  body('productOptions').optional().isArray().withMessage('productOptions must be an array'),
  body('productOptions.*.title').optional().trim().notEmpty().withMessage('Each productOption must have a non-empty title'),
  body('productOptions.*.options').optional().isArray().withMessage('productOptions.*.options must be an array of strings'),
  body('productOptions.*.options.*').optional().isString().trim(),
];

const updateValidation = [
  param('id').isUUID().withMessage('Valid product ID required'),
  body('title').optional().trim().notEmpty(),
  body('subtitle').optional().trim(),
  body('price').optional().isFloat({ min: 0 }),
  body('discountedPrice').optional().isFloat({ min: 0 }),
  body('quantity').optional().isInt({ min: 0 }).withMessage('Quantity must be a non-negative integer'),
  body('categoryId').optional().isUUID(),
  body('descriptions').optional().isArray().withMessage('descriptions must be an array'),
  body('descriptions.*.title').optional().trim(),
  body('descriptions.*.description').optional().trim(),
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
  body('descriptions').optional().custom((arr) => {
    if (!Array.isArray(arr)) return true;
    return arr.every((d) => d && typeof d === 'object' && (d.description != null && String(d.description).trim() !== ''));
  }).withMessage('Each description item must have a non-empty description field'),
  body('productOptions').optional().isArray().withMessage('productOptions must be an array'),
  body('productOptions.*.title').optional().trim().notEmpty().withMessage('Each productOption must have a non-empty title'),
  body('productOptions.*.options').optional().isArray().withMessage('productOptions.*.options must be an array of strings'),
  body('productOptions.*.options.*').optional().isString().trim(),
];

const idParam = [param('id').isUUID().withMessage('Valid product ID required')];
const categoryIdParam = [param('categoryId').isUUID().withMessage('Valid category ID required')];
const pagination = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
];

router.post(
  '/',
  verifyAdminOrManager,
  requireManagerPermission('PRODUCTS'),
  createValidation,
  handleValidationErrors,
  productController.createProduct
);

/**
 * @swagger
 * /products/{id}:
 *   put:
 *     summary: Update a product (admin)
 *     description: |
 *       Admin can update **any** product field supported at create time: title, subtitle, price, discountedPrice, **quantity** (stock), **categoryId**, descriptions, images, productOptions.
 *       **categoryId:** Use the target category’s `id` from **GET /categories** to assign or move the product; omit this field if you are not changing category.
 *       Send only fields you want to change. **images** / **descriptions** / **productOptions** replace the whole list when sent. New photos: **POST /upload/image** then pass URLs in **images**.
 *       Requires admin JWT.
 *     tags: [Products]
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
 *             $ref: '#/components/schemas/ProductUpdate'
 *           examples:
 *             fullUpdate:
 *               summary: Update several fields (incl. stock)
 *               value:
 *                 title: Summer Dress — sale
 *                 subtitle: Light organic cotton
 *                 price: 44.99
 *                 discountedPrice: 34.99
 *                 quantity: 25
 *                 categoryId: 550e8400-e29b-41d4-a716-446655440000
 *                 descriptions:
 *                   - title: Care
 *                     description: Machine wash cold
 *                   - description: Relaxed fit
 *                 images:
 *                   - https://cdn.example.com/products/dress-front-v2.jpg
 *                   - https://cdn.example.com/products/dress-detail.jpg
 *                 productOptions:
 *                   - title: Size
 *                     options: ["S", "M", "L", "XL"]
 *                   - title: Color
 *                     options: ["Ivory", "Sage"]
 *             stockOnly:
 *               summary: Restock / adjust quantity only
 *               value:
 *                 quantity: 100
 *             priceAndStock:
 *               summary: Price and inventory
 *               value:
 *                 price: 49.99
 *                 discountedPrice: 39.99
 *                 quantity: 12
 *             moveToCategory:
 *               summary: Assign or move to a category
 *               description: Paste category id from GET /categories
 *               value:
 *                 categoryId: 550e8400-e29b-41d4-a716-446655440000
 *     responses:
 *       200:
 *         description: Product updated
 *       404:
 *         description: Product or category not found
 */
router.put(
  '/:id',
  verifyAdminOrManager,
  requireManagerPermission('PRODUCTS'),
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
  verifyAdminOrManager,
  requireManagerPermission('PRODUCTS'),
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
