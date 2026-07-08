/**
 * Builds the visibility options object (consumed by buildVisibilityWhere) from a
 * request, centralizing the storefront-vs-staff rules:
 *
 *   - Non-staff: scoped to req.regionId (resolved by the region middleware) + PUBLISHED.
 *   - Staff: unfiltered, but honor OPTIONAL admin filters for management screens:
 *       ?status=DRAFT|PUBLISHED   narrow by publish state
 *       ?region=<code>            narrow to one region (exact; unknown code -> no rows)
 *
 * Admin region filtering uses the explicit `?region=` query param only (not the
 * X-Region header), so an admin whose client always sends X-Region still sees all
 * regions by default in the panel.
 */
const regionService = require('../services/region.service');

// Sentinel id that can never match a real region row — used so an unknown admin
// region filter returns an empty set instead of silently ignoring the filter.
const NO_MATCH_REGION_ID = '00000000-0000-0000-0000-000000000000';

async function visibilityFromReq(req) {
  const isStaff = !!req.isStaff;
  let regionId = req.regionId || null;

  // CAT-7: for storefront (non-staff) reads, never fall through to an UNSCOPED query.
  // If the region middleware didn't resolve a region (route without the middleware, or a
  // missing/unknown header that wasn't defaulted upstream), scope to the default region
  // so other regions' products can't leak. When NO regions are configured, defaultRegion
  // is null and behavior is unchanged (region clause omitted — the only way a region-less
  // store shows anything).
  if (!isStaff && !regionId) {
    const def = await regionService.getDefaultRegion();
    regionId = def?.id || null;
  }

  const opts = { isStaff, regionId };

  if (isStaff) {
    const status = req.query?.status ? String(req.query.status).trim().toUpperCase() : null;
    if (status === 'DRAFT' || status === 'PUBLISHED') opts.adminStatus = status;

    const explicitCode = req.query?.region ? String(req.query.region).trim() : null;
    if (explicitCode) {
      const region = await regionService.getRegionByCode(explicitCode);
      opts.adminRegionId = region ? region.id : NO_MATCH_REGION_ID;
    }
  } else {
    // Storefront currency: which price a product shows (see product.service's
    // applyRegionCurrency) is driven by the requesting region's currency, resolved
    // once here so every list/detail endpoint gets it for free via `visibility`.
    const region = await regionService.getRegionById(regionId);
    opts.currency = region?.currency || 'AED';
  }

  return opts;
}

module.exports = { visibilityFromReq };
