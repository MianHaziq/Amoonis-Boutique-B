const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();
const categoryController = require('../controllers/category.controller');
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
const { handleValidationErrors, requireEitherBilingual } = require('../middleware/validate');
const { publicLimiter } = require('../middleware/rateLimit');
const { attachStaffIfPresent } = require('../middleware/optionalStaff');
const { resolveRegion } = require('../middleware/region');

// Shared region/draft validators for create + update.
const regionStatusValidation = [
  body('status').optional().isIn(['DRAFT', 'PUBLISHED']).withMessage('status must be DRAFT or PUBLISHED'),
  body('regionIds').optional().isArray().withMessage('regionIds must be an array of region IDs'),
  body('regionIds.*').optional().isUUID().withMessage('Each regionId must be a valid UUID'),
  // Overrides Settings.defaultDeliveryLeadDays for every product in this category that
  // doesn't set its own Product.deliveryLeadDays. null clears it (falls through to the
  // global default) — distinct from Region.standardDeliveryDays (courier transit time).
  body('deliveryLeadDays')
    .optional({ values: 'null' })
    .isInt({ min: 0, max: 30 }).withMessage('deliveryLeadDays must be a whole number between 0 and 30'),
];

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
 *           examples:
 *             withArabic:
 *               summary: With Arabic fields
 *               value:
 *                 title: Women
 *                 title_ar: نساء
 *                 description: Women collection
 *                 description_ar: مجموعة نسائية
 *                 image: null
 *             minimal:
 *               summary: English only
 *               value:
 *                 title: Women
 *                 description: Women collection
 *                 image: null
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
  // Bilingual title: either English (`title`) or Arabic (`title_ar`) is acceptable.
  // The backend auto-translates the missing side; see docs/translation-setup.md.
  body('title').optional().trim(),
  body('title_ar').optional().trim(),
  requireEitherBilingual('title', 'title_ar', 'Title'),
  body('description').optional().trim(),
  body('description_ar').optional().trim(),
  body('image').optional().trim(),
  ...regionStatusValidation,
];

const updateValidation = [
  param('id').isUUID().withMessage('Valid category ID required'),
  body('title').optional().trim().notEmpty(),
  body('title_ar').optional().trim(),
  body('description').optional().trim(),
  body('description_ar').optional().trim(),
  body('image').optional().trim(),
  ...regionStatusValidation,
];

const idParam = [param('id').isUUID().withMessage('Valid category ID required')];

router.post(
  '/',
  verifyAdminOrManager,
  requireManagerPermission('CATEGORIES'),
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
  verifyAdminOrManager,
  requireManagerPermission('CATEGORIES'),
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
  verifyAdminOrManager,
  requireManagerPermission('CATEGORIES'),
  idParam,
  handleValidationErrors,
  categoryController.deleteCategory
);

/**
 * @swagger
 * /categories:
 *   get:
 *     summary: List all categories
 *     description: |
 *       Returns categories with product count. Storefront sends **X-Region** and gets only
 *       PUBLISHED categories in that region; staff get all and may use the **region** / **status** filters.
 *     tags: [Categories]
 *     parameters:
 *       - $ref: '#/components/parameters/XRegionHeader'
 *       - $ref: '#/components/parameters/RegionFilterQuery'
 *       - $ref: '#/components/parameters/StatusFilterQuery'
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
router.get('/', publicLimiter, attachStaffIfPresent, resolveRegion, categoryController.getAllCategories);

/**
 * @swagger
 * /categories/{id}:
 *   get:
 *     summary: Get a category with its products
 *     description: Returns single category including all products in it. Public, rate-limited. Storefront (X-Region) gets 404 for a draft or out-of-region category; staff see it regardless.
 *     tags: [Categories]
 *     parameters:
 *       - $ref: '#/components/parameters/XRegionHeader'
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
  attachStaffIfPresent,
  resolveRegion,
  idParam,
  handleValidationErrors,
  categoryController.getCategoryById
);

module.exports = router;
