/**
 * Single source of truth for how region + draft visibility translates into a Prisma
 * `where` clause on region-aware content (Product, Category, Section, BannerImage).
 *
 * The shape is identical across those models: each has a `regions` relation whose join
 * rows carry `regionId`, and a `status` enum (DRAFT | PUBLISHED).
 *
 * Rules:
 *   - Storefront (non-staff): only PUBLISHED rows visible in the request's region.
 *   - Staff (admin/manager):  see everything by default. Optional admin filters
 *     (`adminRegionId`, `adminStatus`) narrow the view for management screens.
 */

/**
 * @param {object} opts
 * @param {boolean} opts.isStaff       - true when an admin/manager token was presented
 * @param {string|null} opts.regionId  - resolved storefront region id (for non-staff)
 * @param {string|null} [opts.adminRegionId] - explicit region filter requested by staff
 * @param {('DRAFT'|'PUBLISHED'|null)} [opts.adminStatus] - explicit status filter requested by staff
 * @returns {object} Prisma where fragment
 */
function buildVisibilityWhere({ isStaff, regionId, adminRegionId = null, adminStatus = null }) {
  const where = {};

  if (!isStaff) {
    where.status = 'PUBLISHED';
    if (regionId) where.regions = { some: { regionId } };
    return where;
  }

  // Staff: unfiltered unless they explicitly asked to narrow the view.
  if (adminStatus === 'DRAFT' || adminStatus === 'PUBLISHED') where.status = adminStatus;
  if (adminRegionId) where.regions = { some: { regionId: adminRegionId } };
  return where;
}

module.exports = { buildVisibilityWhere };
