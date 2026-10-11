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
const prisma = require('../config/db');
const regionService = require('../services/region.service');
const { resolveListRegionFilter } = require('./regionScope');

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

    // An explicit ?region= narrows the admin view to one region (unknown code -> a
    // sentinel that matches nothing). This requested region is then intersected with
    // the caller's own access scope: an ADMIN / all-region manager gets exactly what
    // they asked for, while a region-scoped MANAGER is pinned to their regions (and a
    // request for a region outside their scope yields zero rows). See regionScope.js.
    const explicitCode = req.query?.region ? String(req.query.region).trim() : null;
    let requestedRegionId = null;
    if (explicitCode) {
      const region = await regionService.getRegionByCode(explicitCode);
      requestedRegionId = region ? region.id : NO_MATCH_REGION_ID;
    }
    const { regionIds } = resolveListRegionFilter(req, requestedRegionId);
    // null => unrestricted with no explicit filter (leave the view unscoped). An array
    // (including []) => pin the visibility to those regions via buildVisibilityWhere.
    if (regionIds !== null) opts.adminRegionIds = regionIds;
  } else {
    // Storefront currency: which price a product shows (see product.service's
    // applyRegionCurrency) is driven by the requesting region's currency, resolved
    // once here so every list/detail endpoint gets it for free via `visibility`.
    const region = await regionService.getRegionById(regionId);
    opts.currency = region?.currency || 'AED';
    // Optional selected delivery zone (?zoneId=) — lets the storefront resolve a
    // zone-accurate delivery-days estimate (zone override / zone standard) on browse.
    // Validated in product.service against the region; a stale/foreign id just falls back
    // to region-level resolution. Never used to filter visibility, only for the estimate.
    // Selected delivery zone. Two sources, in priority order:
    //   1. ?zoneId=<uuid>  — explicit, used by the product page for its estimate.
    //   2. X-Zone: <name>  — the storefront cookie holds the zone NAME (not an id),
    //      so the header carries the name and we resolve it within THIS region. This
    //      mirrors X-Region and means every catalog read is zone-aware without each
    //      call site having to thread a zone through.
    // Drives the delivery-days estimate AND zone visibility (buildZoneVisibilityWhere).
    // An unknown/foreign value resolves to null, which simply disables zone filtering
    // rather than hiding anything — checkout re-validates the real zone regardless.
    let zoneId = req.query?.zoneId ? String(req.query.zoneId).trim() : null;
    if (!zoneId && regionId) {
      // Zone NAME from either the X-Zone header (browser requests, set by the http
      // interceptor) or ?zone= (server-rendered requests, which carry no cookies to
      // the API — mirrors how `region` travels as both a header and a query param).
      const rawZone = req.query?.zone
        ? String(req.query.zone).trim()
        : req.headers?.['x-zone']
          ? String(req.headers['x-zone']).trim()
          : '';
      if (rawZone) {
        const zone = await prisma.deliveryZone.findFirst({
          where: { regionId, isActive: true, name: { equals: rawZone, mode: 'insensitive' } },
          select: { id: true },
        });
        zoneId = zone?.id || null;
      }
    }
    if (zoneId) opts.zoneId = zoneId;
  }

  return opts;
}

module.exports = { visibilityFromReq };
