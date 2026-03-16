const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();
const categoryController = require('../controllers/category.controller');
const { verifyAdmin } = require('../middleware/auth');
const { handleValidationErrors } = require('../middleware/validate');
const { publicLimiter } = require('../middleware/rateLimit');

/**
 * @swagger
 * tags:
 *   name: Categories
 *   description: Product categories. Admin can create/update/delete; everyone can list and get one with products.
 */

/**
 * @swagger
 * /categories:
 *   post:
 *     summary: Create a category (admin)
 *     description: Create a new product category. Requires admin JWT.
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CategoryCreate'
 *           example:
 *             title: Women
 *             description: Women collection
 *             image: null
 *     responses:
 *       201:
 *         description: Category created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiSuccess'
 *             example:
 *               success: true
 *               message: Category created successfully
 *               data:
 *                 id: 550e8400-e29b-41d4-a716-446655440000
 *                 title: Women
 *                 description: Women collection
 *                 image: null
 *                 totalProducts: 0
 *       400:
 *         description: Validation failed
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: Unauthorized
 */
const createValidation = [
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('description').optional().trim(),
  body('image').optional().trim(),
];

const updateValidation = [
  param('id').isUUID().withMessage('Valid category ID required'),
  body('title').optional().trim().notEmpty(),
  body('description').optional().trim(),
  body('image').optional().trim(),
];

const idParam = [param('id').isUUID().withMessage('Valid category ID required')];

router.post(
  '/',
  verifyAdmin,
  createValidation,
  handleValidationErrors,
  categoryController.createCategory
);

/**
 * @swagger
 * /categories/{id}:
 *   put:
 *     summary: Update a category (admin)
 *     description: Update category title, description, or image. Requires admin JWT.
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         example: 550e8400-e29b-41d4-a716-446655440000
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title: { type: string, example: Men }
 *               description: { type: string }
 *               image: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: Category updated
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       404:
 *         description: Category not found
 */
router.put(
  '/:id',
  verifyAdmin,
  updateValidation,
  handleValidationErrors,
  categoryController.updateCategory
);

/**
 * @swagger
 * /categories/{id}:
 *   delete:
 *     summary: Delete a category (admin)
 *     description: Fails if the category has products. Requires admin JWT.
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Category deleted
 *       400:
 *         description: Category has products
 *       404:
 *         description: Category not found
 */
router.delete(
  '/:id',
  verifyAdmin,
  idParam,
  handleValidationErrors,
  categoryController.deleteCategory
);

/**
 * @swagger
 * /categories:
 *   get:
 *     summary: List all categories
 *     description: Returns all categories with product count. Public, rate-limited.
 *     tags: [Categories]
 *     responses:
 *       200:
 *         description: List of categories
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiSuccess'
 *             example:
 *               success: true
 *               message: Categories fetched successfully
 *               data:
 *                 - id: 550e8400-e29b-41d4-a716-446655440000
 *                   title: Women
 *                   description: Women collection
 *                   totalProducts: 5
 *               meta: { total: 1 }
 */
router.get('/', publicLimiter, categoryController.getAllCategories);

/**
 * @swagger
 * /categories/{id}:
 *   get:
 *     summary: Get a category with its products
 *     description: Returns single category including all products in it. Public, rate-limited.
 *     tags: [Categories]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Category with products
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *             example:
 *               success: true
 *               data:
 *                 id: 550e8400-e29b-41d4-a716-446655440000
 *                 title: Women
 *                 totalProducts: 2
 *                 products: []
 *       404:
 *         description: Category not found
 */
router.get(
  '/:id',
  publicLimiter,
  idParam,
  handleValidationErrors,
  categoryController.getCategoryById
);

module.exports = router;
