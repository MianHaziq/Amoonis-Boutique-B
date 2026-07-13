const { success, error } = require('../utils/response');
const vatService = require('../services/vat.service');

// ============================================
// GET /api/vat  (admin) — every region + its VAT config, for the region picker/overview
// ============================================
const listVatConfigs = async (req, res, next) => {
  try {
    const configs = await vatService.listConfigs();
    return success(res, configs, 'VAT configs fetched successfully', 200, { total: configs.length });
  } catch (err) {
    next(err);
  }
};

// ============================================
// GET /api/vat/public — safe view for the storefront, resolved to the CURRENT region
// (req.regionId is set by the `resolveRegion` middleware from X-Region / ?region=)
// ============================================
const getPublicVatConfig = async (req, res, next) => {
  try {
    const config = await vatService.getPublicConfig(req.regionId);
    return success(res, config, 'Public VAT config fetched successfully');
  } catch (err) {
    next(err);
  }
};

// ============================================
// GET /api/vat/:regionId  (admin) — full config for ONE region, incl. scoped product/category ids
// ============================================
const getVatConfig = async (req, res, next) => {
  try {
    const config = await vatService.getConfig(req.params.regionId);
    return success(res, config, 'VAT config fetched successfully');
  } catch (err) {
    if (err.code === 'VAT_REGION_NOT_FOUND') return error(res, err.message, 404);
    next(err);
  }
};

// ============================================
// PUT /api/vat/:regionId  (admin) — update rate / inclusive / scope for ONE region
// ============================================
const updateVatConfig = async (req, res, next) => {
  try {
    const { enabled, ratePercent, inclusive, appliesTo, productIds, categoryIds } = req.body;
    const config = await vatService.updateConfig(req.params.regionId, {
      enabled,
      ratePercent,
      inclusive,
      appliesTo,
      productIds,
      categoryIds,
    });
    return success(res, config, 'VAT config updated successfully');
  } catch (err) {
    if (err.code === 'VAT_REGION_NOT_FOUND') return error(res, err.message, 404);
    // Service throws tagged validation errors with a `status` — surface them as 400s.
    if (err && err.status === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
};

module.exports = {
  listVatConfigs,
  getPublicVatConfig,
  getVatConfig,
  updateVatConfig,
};
