const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();
const deliveryZoneController = require('../controllers/deliveryZone.controller');
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
const { attachStaffIfPresent } = require('../middleware/optionalStaff');
const { handleValidationErrors } = require('../middleware/validate');
const { publicLimiter } = require('../middleware/rateLimit');

/**
 * @swagger
 * tags:
 *   name: DeliveryZones
 *   description: Admin-managed delivery sub-areas within a region (e.g. UAE's emirates). Public list (active, scoped to ?region=); admin/manager CRUD.
 */

const listValidation = [query('region').optional().isString().trim()];

const createValidation = [
  body('regionId').isUUID().withMessage('Valid regionId is required'),
  body('name').isString().trim().notEmpty().withMessage('name is required'),
  body('name_ar').optional().isString().trim(),
  body('isActive').optional().isBoolean(),
  body('sortOrder').optional().isInt(),
];

const updateValidation = [
  param('id').isUUID().withMessage('Valid zone ID required'),
  body('regionId').optional().isUUID(),
  body('name').optional().isString().trim().notEmpty(),
  body('name_ar').optional().isString().trim(),
  body('isActive').optional().isBoolean(),
  body('sortOrder').optional().isInt(),
];

const idParam = [param('id').isUUID().withMessage('Valid zone ID required')];

/**
 * @swagger
 * /delivery-zones:
 *   get:
 *     summary: List delivery zones
 *     description: |
 *       Public request with `?region=UAE` returns **ACTIVE** zones for that region only
 *       (use this to populate the checkout's Emirate-style dropdown). Omitting `?region=`
 *       returns nothing for public callers. A staff (admin/manager) token returns all
 *       zones, including inactive ones, across all regions if `?region=` is omitted.
 *     tags: [DeliveryZones]
 *     parameters:
 *       - in: query
 *         name: region
 *         schema: { type: string }
 *         description: Region code (e.g. UAE, SA)
 *     responses:
 *       200:
 *         description: Delivery zones list
 */
router.get('/', publicLimiter, attachStaffIfPresent, listValidation, handleValidationErrors, deliveryZoneController.listZones);

/**
 * @swagger
 * /delivery-zones:
 *   post:
 *     summary: Create a delivery zone (admin/manager)
 *     tags: [DeliveryZones]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Zone created }
 *       409: { description: A zone with this name already exists in this region }
 */
router.post(
  '/',
  verifyAdminOrManager,
  requireManagerPermission('DELIVERY_ZONES'),
  createValidation,
  handleValidationErrors,
  deliveryZoneController.createZone
);

/**
 * @swagger
 * /delivery-zones/{id}:
 *   put:
 *     summary: Update a delivery zone (admin/manager)
 *     tags: [DeliveryZones]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Zone updated }
 *       404: { description: Zone not found }
 *       409: { description: Name already in use within the region }
 */
router.put(
  '/:id',
  verifyAdminOrManager,
  requireManagerPermission('DELIVERY_ZONES'),
  updateValidation,
  handleValidationErrors,
  deliveryZoneController.updateZone
);

/**
 * @swagger
 * /delivery-zones/{id}:
 *   delete:
 *     summary: Delete a delivery zone (admin/manager)
 *     description: Frictionless — saved addresses referencing it fall back gracefully.
 *     tags: [DeliveryZones]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Zone deleted }
 *       404: { description: Zone not found }
 */
router.delete(
  '/:id',
  verifyAdminOrManager,
  requireManagerPermission('DELIVERY_ZONES'),
  idParam,
  handleValidationErrors,
  deliveryZoneController.deleteZone
);

module.exports = router;
