const analyticsService = require('../services/analytics.service');
const { getAnalyticsForExport } = require('../services/export/analyticsExport.service');
const { renderAnalyticsExcel } = require('../services/export/analyticsExcel.service');
const { renderAnalyticsPdf } = require('../services/export/analyticsPdf.service');
const { renderAnalyticsCsv } = require('../services/export/analyticsCsv.service');
const { analyticsFilename } = require('../services/export/filename.util');
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
    const { preset, from, to, region } = req.query;
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
        region: region || null,
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
    const { preset, from, to, region } = req.query;
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
        region: region || null,
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
    const { preset, from, to, region } = req.query;
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
        region: region || null,
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
    const { preset, from, to, region } = req.query;
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
        region: region || null,
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

// GET /admin/analytics/export — admin/manager only (ANALYTICS permission).
// Streams an Excel or PDF report of the dashboard's analytics directly as the
// response body, for the currently-selected preset/from-to/region.
async function exportAnalytics(req, res, next) {
  try {
    const { preset, from, to, region, format } = req.query;
    const hasCustom = Boolean(from || to);
    if (hasCustom && (!from || !to)) {
      return error(res, 'Custom range requires both from and to (ISO 8601 dates)', 400);
    }
    if (!hasCustom && !preset) {
      return error(res, 'Query parameter preset is required unless from and to are both provided', 400);
    }

    let result;
    try {
      result = await getAnalyticsForExport({
        preset: hasCustom ? null : preset,
        from: from || null,
        to: to || null,
        region: region || null,
      });
    } catch (e) {
      if (e.message === 'INVALID_PRESET') return error(res, 'Invalid preset', 400);
      throw e;
    }
    if (result.error) return error(res, result.error, 400);

    const filename = analyticsFilename(format, { preset: hasCustom ? null : preset, from, to });
    if (format === 'xlsx') {
      await renderAnalyticsExcel(res, result, filename);
    } else if (format === 'csv') {
      renderAnalyticsCsv(res, result, filename);
    } else {
      await renderAnalyticsPdf(res, result, filename);
    }
  } catch (err) {
    next(err);
  }
}

module.exports = { listPresets, getRevenue, getKpi, getCategorySales, getDailySales, exportAnalytics };
