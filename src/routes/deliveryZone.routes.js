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

// Per-zone delivery overrides — shared by create and update (all optional; null/[] =
// inherit region). Authoritative parsing is in deliveryZone.service.js.
const zoneConfigValidation = [
  body('shippingFlatRate').optional({ nullable: true }).isFloat({ min: 0 }),
  body('freeDeliveryThreshold').optional({ nullable: true }).isFloat({ min: 0 }),
  body('sameDayEnabled').optional({ nullable: true }).isBoolean(),
  body('sameDayCutoff').optional({ nullable: true }).matches(/^([01]?\d|2[0-3]):[0-5]\d$/)
    .withMessage('sameDayCutoff must be a 24h time "HH:mm"'),
  body('standardLeadDays').optional({ nullable: true }).isInt({ min: 0, max: 90 }),
  body('deliveryDays').optional({ nullable: true }).isArray(),
  body('deliveryDays.*').optional().isInt({ min: 0, max: 6 }),
  body('codEnabled').optional({ nullable: true }).isBoolean(),
  body('minOrderAmount').optional({ nullable: true }).isFloat({ min: 0 }),
  body('maxOrderAmount').optional({ nullable: true }).isFloat({ min: 0 }),
];

const createValidation = [
  body('regionId').isUUID().withMessage('Valid regionId is required'),
  body('name').isString().trim().notEmpty().withMessage('name is required'),
  body('name_ar').optional({ nullable: true }).isString().trim(),
  body('isActive').optional().isBoolean(),
  body('sortOrder').optional().isInt(),
  ...zoneConfigValidation,
];

const bulkCreateValidation = [
  body('regionId').isUUID().withMessage('Valid regionId is required'),
  body('zones').isArray({ min: 1 }).withMessage('zones must be a non-empty array'),
  body('zones.*.name').isString().trim().notEmpty().withMessage('Each zone needs a name'),
  body('zones.*.name_ar').optional({ nullable: true }).isString().trim(),
  body('zones.*.isActive').optional().isBoolean(),
];

const updateValidation = [
  param('id').isUUID().withMessage('Valid zone ID required'),
  body('regionId').optional().isUUID(),
  body('name').optional().isString().trim().notEmpty(),
  body('name_ar').optional({ nullable: true }).isString().trim(),
  body('isActive').optional().isBoolean(),
  body('sortOrder').optional().isInt(),
  ...zoneConfigValidation,
];

const idParam = [param('id').isUUID().withMessage('Valid zone ID required')];

const reorderValidation = [
  body('items').isArray({ min: 1 }).withMessage('items must be a non-empty array'),
  body('items.*.id').isUUID().withMessage('Each item.id must be a valid zone ID'),
  body('items.*.sortOrder').isInt({ min: 0 }).withMessage('Each item.sortOrder must be a non-negative integer'),
];

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
 * /delivery-zones/bulk:
 *   post:
 *     summary: Create multiple delivery zones for one region (admin/manager)
 *     description: "Body { regionId, zones: [{ name, name_ar?, isActive? }] }. sortOrder is auto-assigned (appended). Duplicate names (existing or repeated) are skipped, not failed."
 *     tags: [DeliveryZones]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Zones created (with any skipped duplicate names) }
 *       400: { description: Validation error }
 */
router.post(
  '/bulk',
  verifyAdminOrManager,
  requireManagerPermission('DELIVERY_ZONES'),
  bulkCreateValidation,
  handleValidationErrors,
  deliveryZoneController.createZonesBulk
);

/**
 * @swagger
 * /delivery-zones/order:
 *   patch:
 *     summary: Reorder delivery zones (admin/manager)
 *     description: "Set zone display order by sending [{ id, sortOrder }]. sortOrder is scoped per-region, so reorder within a single region at a time."
 *     tags: [DeliveryZones]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Zone order updated }
 *       404: { description: One or more zones not found }
 */
router.patch(
  '/order',
  verifyAdminOrManager,
  requireManagerPermission('DELIVERY_ZONES'),
  reorderValidation,
  handleValidationErrors,
  deliveryZoneController.reorderZones
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
