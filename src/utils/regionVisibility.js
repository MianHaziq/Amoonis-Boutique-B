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

/**
 * Extra Product `where` fragment that hides products whose CATEGORY is drafted for
 * the ENTIRE store (Category.status = DRAFT + draftScope = ENTIRE_STORE). A HOME_ONLY
 * draft category keeps its products listable in the Shop, so it is NOT excluded here.
 * Staff see everything. Products with no category, or a PUBLISHED/HOME_ONLY-draft
 * category, are unaffected (Prisma's NOT on a to-one relation keeps null-category rows).
 *
 * Returns {} for staff and merges cleanly alongside buildVisibilityWhere() — it only
 * adds a top-level `NOT` (or a top-level `OR` when a rescue list is given), never
 * touching the product's own `status`/`regions` keys.
 *
 * `rescueIds`: product ids that a published Section is currently surfacing. These are
 * RESCUED back into view even when their category is ENTIRE_STORE-draft — a featured
 * product shouldn't vanish from the shop just because its category is hidden. When
 * given, the filter becomes "(category not entire-store-draft) OR (id in rescue list)".
 *
 * @param {object} opts
 * @param {boolean} opts.isStaff
 * @param {string[]|null} [rescueIds]
 * @returns {object} Prisma where fragment
 */
function buildCategoryVisibilityWhere({ isStaff }, rescueIds = null) {
  if (isStaff) return {};
  const hidden = { category: { status: 'DRAFT', draftScope: 'ENTIRE_STORE' } };
  if (Array.isArray(rescueIds) && rescueIds.length > 0) {
    return { OR: [{ NOT: hidden }, { id: { in: rescueIds } }] };
  }
  return { NOT: hidden };
}

module.exports = { buildVisibilityWhere, buildCategoryVisibilityWhere };
