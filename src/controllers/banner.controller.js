const bannerService = require('../services/banner.service');
const { success, error } = require('../utils/response');
const { visibilityFromReq } = require('../utils/visibilityFromReq');

function parsePlatform(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim().toUpperCase();
  return v === 'WEB' || v === 'MOBILE' ? v : null;
}

/**
 * GET /banners – List banner images in display order. Storefront gets PUBLISHED banners
 * for its region; staff (admin/manager token) get all banners across all regions.
 *
 * Platform targeting: the mobile app sends no `platform` query param, so storefront
 * reads default to MOBILE — web-only banners (hero videos) never reach it. The website
 * sends `?platform=WEB` to get its banners. Staff see all platforms unless they pass one.
 */
async function getBanners(req, res, next) {
  try {
    const visibility = await visibilityFromReq(req);
    const platform = parsePlatform(req.query?.platform);
    if (visibility.isStaff) {
      if (platform) visibility.adminPlatform = platform;
    } else {
      visibility.platform = platform || 'MOBILE';
    }
    const items = await bannerService.getBanners(visibility);
    return success(res, items, 'Banners fetched successfully', 200, { total: items.length });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /banners – Add one or more banner images (admin). New images appended at end.
 * Optional `status` (default DRAFT) and `regionIds` (default region) apply to all added.
 */
async function addBanners(req, res, next) {
  try {
    const { url, urls, status, regionIds, platform } = req.body;
    const toAdd = url != null ? [url] : Array.isArray(urls) ? urls : [];
    if (toAdd.length === 0) {
      return error(res, 'Provide either url (string) or urls (array of strings)', 400);
    }
    const invalid = toAdd.filter((u) => !u || typeof u !== 'string' || !u.trim());
    if (invalid.length > 0) {
      return error(res, 'Each URL must be a non-empty string', 400);
    }
    const { count, items } = await bannerService.addBanners(toAdd, { status, regionIds, platform });
    return success(res, items, count === 1 ? 'Banner added successfully' : `${count} banners added successfully`, 201, { count });
  } catch (err) {
    if (err.code === 'REGION_NOT_FOUND') return error(res, err.message, 400);
    next(err);
  }
}

/**
 * PUT /banners/:id – Update a banner's url / status / regions (admin).
 */
async function updateBanner(req, res, next) {
  try {
    const { id } = req.params;
    const banner = await bannerService.updateBanner(id, req.body);
    if (!banner) return error(res, 'Banner not found', 404);
    return success(res, banner, 'Banner updated successfully', 200);
  } catch (err) {
    if (err.code === 'REGION_NOT_FOUND') return error(res, err.message, 400);
    if (err.code === 'P2025') return error(res, 'Banner not found', 404);
    next(err);
  }
}

/**
 * PATCH /banners/order – Reorder banners by ID array (admin). Order of array = display order.
 */
async function updateOrder(req, res, next) {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      return error(res, 'order must be a non-empty array of banner IDs', 400);
    }
    const items = await bannerService.updateOrder(order);
    return success(res, items, 'Banner order updated successfully', 200, { total: items.length });
  } catch (err) {
    if (err.code === 'P2025') {
      return error(res, 'One or more banner IDs not found', 404);
    }
    next(err);
  }
}

/**
 * DELETE /banners/:id – Remove a banner (admin).
 */
async function deleteBanner(req, res, next) {
  try {
    const { id } = req.params;
    await bannerService.deleteBanner(id);
    const items = await bannerService.getBanners();
    return success(res, items, 'Banner deleted successfully', 200, { total: items.length });
  } catch (err) {
    if (err.code === 'P2025') {
      return error(res, 'Banner not found', 404);
    }
    next(err);
  }
}

module.exports = {
  getBanners,
  addBanners,
  updateBanner,
  updateOrder,
  deleteBanner,
};
