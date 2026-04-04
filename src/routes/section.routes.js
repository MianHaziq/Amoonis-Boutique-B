const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();
const sectionController = require('../controllers/section.controller');
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
const { handleValidationErrors } = require('../middleware/validate');

/**
 * @swagger
 * tags:
 *   name: Sections
 *   description: Admin-created sections for user panel (e.g. Ramadan Deals). Each section has title (required), optional image, and ordered products + categories. Product/category shape matches existing product and category APIs.
 */

/**
 * @swagger
 * /sections:
 *   get:
 *     summary: List sections (public)
 *     description: Returns all sections in display order for the user panel. Each section includes products and categories in the same shape as product list and category list (id, image, title, price, etc. for products; id, title, image, totalProducts for categories).
 *     tags: [Sections]
 *     responses:
 *       200:
 *         description: Sections with products and categories
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SectionWithItems'
 *                 meta: { type: object, properties: { total: { type: integer } } }
 */
router.get('/', sectionController.getSections);

/**
 * @swagger
 * /sections/{id}:
 *   get:
 *     summary: Get one section (public)
 *     tags: [Sections]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Section with products and categories
 *       404:
 *         description: Section not found
 */
router.get(
  '/:id',
  [param('id').isUUID().withMessage('Valid section ID required')],
  handleValidationErrors,
  sectionController.getSectionById
);

/**
 * @swagger
 * /sections:
 *   post:
 *     summary: Create section (admin)
 *     description: Create a new section. Title required; image optional. Optionally add products and/or categories by ID; array order = display order.
 *     tags: [Sections]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title:
 *                 type: string
 *                 example: "Ramadan Deals"
 *               image:
 *                 type: string
 *                 nullable: true
 *                 description: Optional section image URL
 *               productIds:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *                 description: Product IDs in display order
 *               categoryIds:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *                 description: Category IDs in display order
 *               sortOrder:
 *                 type: integer
 *                 description: Section order on panel (optional)
 *           example:
 *             title: "Ramadan Deals"
 *             image: "https://example.com/ramadan.jpg"
 *             productIds: ["uuid-1", "uuid-2"]
 *             categoryIds: ["uuid-cat-1"]
 *     responses:
 *       201:
 *         description: Section created
 *       400:
 *         description: Validation failed (e.g. title empty)
 *       401/403:
 *         description: Admin required
 *       404:
 *         description: Product or category ID not found
 */
const createValidation = [
  body('title').trim().notEmpty().withMessage('Section title is required'),
  body('image').optional().trim(),
  body('productIds').optional().isArray().withMessage('productIds must be an array'),
  body('productIds.*').optional().isUUID().withMessage('Each productId must be a valid UUID'),
  body('categoryIds').optional().isArray().withMessage('categoryIds must be an array'),
  body('categoryIds.*').optional().isUUID().withMessage('Each categoryId must be a valid UUID'),
  body('sortOrder').optional().isInt({ min: 0 }).withMessage('sortOrder must be a non-negative integer'),
];
router.post('/', verifyAdminOrManager, requireManagerPermission('SECTIONS'), createValidation, handleValidationErrors, sectionController.createSection);

/**
 * @swagger
 * /sections/{id}:
 *   put:
 *     summary: Update section (admin)
 *     description: Update title, image, sortOrder, and/or replace products/categories. Send productIds or categoryIds to set new list (order = array order).
 *     tags: [Sections]
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
 *               image: { type: string, nullable: true }
 *               sortOrder: { type: integer }
 *               productIds: { type: array, items: { type: string, format: uuid } }
 *               categoryIds: { type: array, items: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Section updated
 *       404:
 *         description: Section or linked product/category not found
 */
const updateValidation = [
  param('id').isUUID().withMessage('Valid section ID required'),
  body('title').optional().trim().notEmpty().withMessage('Section title cannot be empty'),
  body('image').optional().trim(),
  body('sortOrder').optional().isInt({ min: 0 }).withMessage('sortOrder must be a non-negative integer'),
  body('productIds').optional().isArray().withMessage('productIds must be an array'),
  body('productIds.*').optional().isUUID().withMessage('Each productId must be a valid UUID'),
  body('categoryIds').optional().isArray().withMessage('categoryIds must be an array'),
  body('categoryIds.*').optional().isUUID().withMessage('Each categoryId must be a valid UUID'),
];
router.put('/:id', verifyAdminOrManager, requireManagerPermission('SECTIONS'), updateValidation, handleValidationErrors, sectionController.updateSection);

/**
 * @swagger
 * /sections/{id}:
 *   delete:
 *     summary: Delete section (admin)
 *     tags: [Sections]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Section deleted
 *       404:
 *         description: Section not found
 */
router.delete(
  '/:id',
  verifyAdminOrManager,
  requireManagerPermission('SECTIONS'),
  [param('id').isUUID().withMessage('Valid section ID required')],
  handleValidationErrors,
  sectionController.deleteSection
);

module.exports = router;
