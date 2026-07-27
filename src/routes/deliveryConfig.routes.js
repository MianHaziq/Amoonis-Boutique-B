const express = require('express');
const { query } = require('express-validator');
const router = express.Router();
const deliveryConfigController = require('../controllers/deliveryConfig.controller');
const { handleValidationErrors } = require('../middleware/validate');
const { publicLimiter } = require('../middleware/rateLimit');

/**
 * @swagger
 * tags:
 *   name: DeliveryConfig
 *   description: Resolved per-region/per-zone delivery configuration for the storefront.
 */

const getValidation = [
  query('region').optional().isString().trim(),
  query('zoneId').optional().isString().trim(),
  query('subtotal').optional().isFloat({ min: 0 }),
];

/**
 * @swagger
 * /delivery-config:
 *   get:
 *     summary: Resolve delivery configuration for a region (and optional zone)
 *     description: |
 *       Returns the effective delivery settings after applying the zone→region→default
 *       inheritance: delivery fee, free-delivery threshold + effective fee for `subtotal`,
 *       delivery days, same-day availability (computed in the region timezone), cutoff,
 *       standard lead days, COD availability, min/max order, active time slots, blackout
 *       dates, and the earliest schedulable date.
 *     tags: [DeliveryConfig]
 *     parameters:
 *       - in: query
 *         name: region
 *         schema: { type: string }
 *         description: Region code (e.g. UAE) or id. Falls back to the default region.
 *       - in: query
 *         name: zoneId
 *         schema: { type: string, format: uuid }
 *         description: Selected delivery zone (from GET /delivery-zones).
 *       - in: query
 *         name: subtotal
 *         schema: { type: number }
 *         description: Net order subtotal, so effectiveFee / free-delivery can be computed.
 *     responses:
 *       200: { description: Resolved delivery configuration }
 *       404: { description: Region not found }
 */
router.get('/', publicLimiter, getValidation, handleValidationErrors, deliveryConfigController.getDeliveryConfig);

module.exports = router;
