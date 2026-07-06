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
 * @param {('MOBILE'|'WEB'|null)} [opts.platform] - storefront platform filter (BannerImage only)
 * @param {('MOBILE'|'WEB'|null)} [opts.adminPlatform] - explicit platform filter requested by staff (BannerImage only)
 * @returns {object} Prisma where fragment
 *
 * NOTE: `platform`/`adminPlatform` apply ONLY to BannerImage (the only model with
 * a `platform` column). They are omitted by every other caller, so they never leak
 * into Product / Category / Section where clauses.
 */
function buildVisibilityWhere({ isStaff, regionId, adminRegionId = null, adminStatus = null, platform = null, adminPlatform = null }) {
  const where = {};

  if (!isStaff) {
    where.status = 'PUBLISHED';
    if (regionId) where.regions = { some: { regionId } };
    if (platform) where.platform = platform;
    return where;
  }

  // Staff: unfiltered unless they explicitly asked to narrow the view.
  if (adminStatus === 'DRAFT' || adminStatus === 'PUBLISHED') where.status = adminStatus;
  if (adminRegionId) where.regions = { some: { regionId: adminRegionId } };
  if (adminPlatform) where.platform = adminPlatform;
  return where;
}

module.exports = { buildVisibilityWhere };
