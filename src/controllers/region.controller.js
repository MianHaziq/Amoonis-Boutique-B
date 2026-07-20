const regionService = require('../services/region.service');
const { success, error } = require('../utils/response');

/**
 * GET /regions – Public list of ACTIVE regions (for the app's region picker).
 * Staff (admin/manager) get all regions including inactive ones.
 */
async function listRegions(req, res, next) {
  try {
    const items = await regionService.listRegions({ includeInactive: !!req.isStaff });
    return success(res, items, 'Regions fetched successfully', 200, { total: items.length });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /regions – Create a region (admin).
 */
async function createRegion(req, res, next) {
  try {
    const region = await regionService.createRegion(req.body);
    return success(res, region, 'Region created successfully', 201);
  } catch (err) {
    if (err.code === 'VALIDATION') return error(res, err.message, 400);
    if (err.code === 'P2002') return error(res, 'A region with this code already exists', 409);
    next(err);
  }
}

/**
 * PUT /regions/:id – Update a region (admin).
 */
async function updateRegion(req, res, next) {
  try {
    const region = await regionService.updateRegion(req.params.id, req.body);
    if (!region) return error(res, 'Region not found', 404);
    return success(res, region, 'Region updated successfully', 200);
  } catch (err) {
    if (err.code === 'VALIDATION') return error(res, err.message, 400);
    if (err.code === 'LAST_ACTIVE_REGION') return error(res, err.message, 409);
    if (err.code === 'P2002') return error(res, 'A region with this code already exists', 409);
    if (err.code === 'P2025') return error(res, 'Region not found', 404);
    next(err);
  }
}

/**
 * DELETE /regions/:id – Delete a region (admin). Blocked if default or in use.
 */
async function deleteRegion(req, res, next) {
  try {
    const region = await regionService.deleteRegion(req.params.id);
    if (!region) return error(res, 'Region not found', 404);
    return success(res, null, 'Region deleted successfully', 200);
  } catch (err) {
    if (err.code === 'REGION_IS_DEFAULT') return error(res, err.message, 409);
    if (err.code === 'REGION_IN_USE') return error(res, err.message, 409);
    if (err.code === 'P2025') return error(res, 'Region not found', 404);
    next(err);
  }
}

/**
 * POST /regions/:id/bulk-assign – Link ALL existing products and/or
 * categories to this region in one shot (admin). Idempotent.
 */
async function bulkAssign(req, res, next) {
  try {
    const { products, categories } = req.body;
    const result = await regionService.bulkAssignRegion(req.params.id, {
      products: !!products,
      categories: !!categories,
    });
    if (!result) return error(res, 'Region not found', 404);
    return success(res, result, 'Region catalog visibility updated', 200);
  } catch (err) {
    next(err);
  }
}

module.exports = { listRegions, createRegion, updateRegion, deleteRegion, bulkAssign };
