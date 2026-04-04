const analyticsService = require('../services/analytics.service');
const { success, error } = require('../utils/response');

function listPresets(req, res, next) {
  try {
    return success(res, { presets: analyticsService.listPresetDefinitions() }, 'Preset list');
  } catch (err) {
    next(err);
  }
}

async function getRevenue(req, res, next) {
  try {
    const { preset, from, to } = req.query;
    const hasCustom = Boolean(from || to);
    if (hasCustom && (!from || !to)) {
      return error(res, 'Custom range requires both from and to (ISO 8601 dates)', 400);
    }
    if (!hasCustom && !preset) {
      return error(res, 'Query parameter preset is required unless from and to are both provided', 400);
    }

    let result;
    try {
      result = await analyticsService.getRevenueAnalytics({
        preset: hasCustom ? null : preset,
        from: from || null,
        to: to || null,
      });
    } catch (e) {
      if (e.message === 'INVALID_PRESET') return error(res, 'Invalid preset', 400);
      if (e.message === 'INVALID_TRUNC') return error(res, 'Invalid time bucket', 500);
      throw e;
    }

    if (result.error) return error(res, result.error, 400);
    return success(res, result, 'Revenue analytics');
  } catch (err) {
    next(err);
  }
}

async function getKpi(req, res, next) {
  try {
    const { preset, from, to } = req.query;
    const hasCustom = Boolean(from || to);
    if (hasCustom && (!from || !to)) {
      return error(res, 'Custom range requires both from and to (ISO 8601 dates)', 400);
    }
    if (!hasCustom && !preset) {
      return error(res, 'Query parameter preset is required unless from and to are both provided', 400);
    }

    let result;
    try {
      result = await analyticsService.getKpiAnalytics({
        preset: hasCustom ? null : preset,
        from: from || null,
        to: to || null,
      });
    } catch (e) {
      if (e.message === 'INVALID_PRESET') return error(res, 'Invalid preset', 400);
      throw e;
    }

    if (result.error) return error(res, result.error, 400);
    return success(res, result, 'KPI analytics');
  } catch (err) {
    next(err);
  }
}

async function getCategorySales(req, res, next) {
  try {
    const { preset, from, to } = req.query;
    const hasCustom = Boolean(from || to);
    if (hasCustom && (!from || !to)) {
      return error(res, 'Custom range requires both from and to (ISO 8601 dates)', 400);
    }
    if (!hasCustom && !preset) {
      return error(res, 'Query parameter preset is required unless from and to are both provided', 400);
    }

    let result;
    try {
      result = await analyticsService.getCategorySalesAnalytics({
        preset: hasCustom ? null : preset,
        from: from || null,
        to: to || null,
      });
    } catch (e) {
      if (e.message === 'INVALID_PRESET') return error(res, 'Invalid preset', 400);
      throw e;
    }

    if (result.error) return error(res, result.error, 400);
    return success(res, result, 'Category sales analytics');
  } catch (err) {
    next(err);
  }
}

async function getDailySales(req, res, next) {
  try {
    const { preset, from, to } = req.query;
    const hasCustom = Boolean(from || to);
    if (hasCustom && (!from || !to)) {
      return error(res, 'Custom range requires both from and to (ISO 8601 dates)', 400);
    }
    if (!hasCustom && !preset) {
      return error(res, 'Query parameter preset is required unless from and to are both provided', 400);
    }

    let result;
    try {
      result = await analyticsService.getDailySalesAnalytics({
        preset: hasCustom ? null : preset,
        from: from || null,
        to: to || null,
      });
    } catch (e) {
      if (e.message === 'INVALID_PRESET') return error(res, 'Invalid preset', 400);
      throw e;
    }

    if (result.error) return error(res, result.error, 400);
    return success(res, result, 'Daily sales analytics');
  } catch (err) {
    next(err);
  }
}

module.exports = { listPresets, getRevenue, getKpi, getCategorySales, getDailySales };
