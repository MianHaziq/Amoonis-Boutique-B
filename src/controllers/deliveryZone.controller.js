const deliveryZoneService = require('../services/deliveryZone.service');
const regionService = require('../services/region.service');
const { success, error } = require('../utils/response');

/**
 * GET /delivery-zones – Public list of ACTIVE zones for a region (?region=UAE).
 * Staff (admin/manager) get all zones (including inactive), across all regions
 * if ?region= is omitted.
 */
async function listZones(req, res, next) {
  try {
    let regionId;
    if (req.query.region) {
      const region = await regionService.getRegionByCode(req.query.region);
      if (!region) return success(res, [], 'Delivery zones fetched successfully', 200, { total: 0 });
      regionId = region.id;
    }
    const items = await deliveryZoneService.listZones({ regionId, includeInactive: !!req.isStaff });
    return success(res, items, 'Delivery zones fetched successfully', 200, { total: items.length });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /delivery-zones – Create a zone (admin/manager).
 */
async function createZone(req, res, next) {
  try {
    const zone = await deliveryZoneService.createZone(req.body);
    return success(res, zone, 'Delivery zone created successfully', 201);
  } catch (err) {
    if (err.code === 'VALIDATION') return error(res, err.message, 400);
    if (err.code === 'P2002') return error(res, 'A zone with this name already exists in this region', 409);
    if (err.code === 'P2003') return error(res, 'Unknown regionId', 400);
    next(err);
  }
}

/**
 * PUT /delivery-zones/:id – Update a zone (admin/manager).
 */
async function updateZone(req, res, next) {
  try {
    const zone = await deliveryZoneService.updateZone(req.params.id, req.body);
    if (!zone) return error(res, 'Delivery zone not found', 404);
    return success(res, zone, 'Delivery zone updated successfully', 200);
  } catch (err) {
    if (err.code === 'VALIDATION') return error(res, err.message, 400);
    if (err.code === 'P2002') return error(res, 'A zone with this name already exists in this region', 409);
    if (err.code === 'P2003') return error(res, 'Unknown regionId', 400);
    if (err.code === 'P2025') return error(res, 'Delivery zone not found', 404);
    next(err);
  }
}

/**
 * DELETE /delivery-zones/:id – Delete a zone (admin/manager). Frictionless —
 * saved addresses referencing it fall back gracefully (onDelete: SetNull).
 */
async function deleteZone(req, res, next) {
  try {
    const zone = await deliveryZoneService.deleteZone(req.params.id);
    if (!zone) return error(res, 'Delivery zone not found', 404);
    return success(res, null, 'Delivery zone deleted successfully', 200);
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'Delivery zone not found', 404);
    next(err);
  }
}

/**
 * PATCH /delivery-zones/order – Reorder zones (admin/manager).
 * Body: { items: [{ id, sortOrder }] }. sortOrder is per-region, so the client
 * reorders within a single region at a time.
 */
async function reorderZones(req, res, next) {
  try {
    const result = await deliveryZoneService.reorderZones(req.body.items);
    return success(res, null, 'Delivery zone order updated successfully', 200, result);
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'One or more delivery zones not found', 404);
    next(err);
  }
}

module.exports = { listZones, createZone, updateZone, deleteZone, reorderZones };
