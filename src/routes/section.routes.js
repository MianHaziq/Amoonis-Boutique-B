const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();
const sectionController = require('../controllers/section.controller');
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
const { handleValidationErrors, requireEitherBilingual } = require('../middleware/validate');
const { attachStaffIfPresent } = require('../middleware/optionalStaff');
const { resolveRegion } = require('../middleware/region');

// Shared region/draft validators for create + update.
const regionStatusValidation = [
  body('status').optional().isIn(['DRAFT', 'PUBLISHED']).withMessage('status must be DRAFT or PUBLISHED'),
  body('regionIds').optional().isArray().withMessage('regionIds must be an array of region IDs'),
  body('regionIds.*').optional().isUUID().withMessage('Each regionId must be a valid UUID'),
];

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
 *     description: |
 *       Returns sections in display order for the user panel. Each section includes products and
 *       categories in the same shape as the product/category list APIs. Storefront sends **X-Region**
 *       and gets only PUBLISHED sections for that region — and the nested products/categories are
 *       themselves region+published filtered (a UAE-only product won't appear for an SA user). Staff
 *       (admin/manager token) get all sections and unfiltered nested content.
 *     tags: [Sections]
 *     parameters:
 *       - $ref: '#/components/parameters/XRegionHeader'
 *       - $ref: '#/components/parameters/RegionFilterQuery'
 *       - $ref: '#/components/parameters/StatusFilterQuery'
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
router.get('/', attachStaffIfPresent, resolveRegion, sectionController.getSections);

/**
 * @swagger
 * /sections/{id}:
 *   get:
 *     summary: Get one section (public)
 *     tags: [Sections]
 *     parameters:
 *       - $ref: '#/components/parameters/XRegionHeader'
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
  attachStaffIfPresent,
  resolveRegion,
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
 *           examples:
 *             withArabic:
 *               summary: With Arabic title
 *               value:
 *                 title: "Ramadan Deals"
 *                 title_ar: "عروض رمضان"
 *                 image: "https://example.com/ramadan.jpg"
 *                 productIds: ["uuid-1", "uuid-2"]
 *                 categoryIds: ["uuid-cat-1"]
 *             minimal:
 *               summary: English only
 *               value:
 *                 title: "Ramadan Deals"
 *                 image: "https://example.com/ramadan.jpg"
 *                 productIds: ["uuid-1", "uuid-2"]
 *                 categoryIds: ["uuid-cat-1"]
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
  // Bilingual title — either English or Arabic acceptable, backend auto-translates the rest.
  body('title').optional().trim(),
  body('title_ar').optional().trim(),
  requireEitherBilingual('title', 'title_ar', 'Section title'),
  body('image').optional().trim(),
  body('productIds').optional().isArray().withMessage('productIds must be an array'),
  body('productIds.*').optional().isUUID().withMessage('Each productId must be a valid UUID'),
  body('categoryIds').optional().isArray().withMessage('categoryIds must be an array'),
  body('categoryIds.*').optional().isUUID().withMessage('Each categoryId must be a valid UUID'),
  body('sortOrder').optional().isInt({ min: 0 }).withMessage('sortOrder must be a non-negative integer'),
  ...regionStatusValidation,
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
/**
 * @swagger
 * /sections/order:
 *   patch:
 *     summary: Reorder sections (admin)
 *     description: Set section display order by sending [{ id, sortOrder }]. Requires admin JWT.
 *     tags: [Sections]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Section order updated }
 *       404: { description: One or more sections not found }
 */
const reorderValidation = [
  body('items').isArray({ min: 1 }).withMessage('items must be a non-empty array'),
  body('items.*.id').isUUID().withMessage('Each item.id must be a valid UUID'),
  body('items.*.sortOrder').isInt({ min: 0 }).withMessage('Each item.sortOrder must be a non-negative integer'),
];
router.patch('/order', verifyAdminOrManager, requireManagerPermission('SECTIONS'), reorderValidation, handleValidationErrors, sectionController.reorderSections);

const updateValidation = [
  param('id').isUUID().withMessage('Valid section ID required'),
  body('title').optional().trim().notEmpty().withMessage('Section title cannot be empty'),
  body('title_ar').optional().trim(),
  body('image').optional().trim(),
  body('sortOrder').optional().isInt({ min: 0 }).withMessage('sortOrder must be a non-negative integer'),
  body('productIds').optional().isArray().withMessage('productIds must be an array'),
  body('productIds.*').optional().isUUID().withMessage('Each productId must be a valid UUID'),
  body('categoryIds').optional().isArray().withMessage('categoryIds must be an array'),
  body('categoryIds.*').optional().isUUID().withMessage('Each categoryId must be a valid UUID'),
  ...regionStatusValidation,
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
