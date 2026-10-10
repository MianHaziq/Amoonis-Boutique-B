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
 * @param {string|null} [opts.adminRegionId] - explicit single-region filter requested by staff
 * @param {string[]|null} [opts.adminRegionIds] - region-scope filter (a region-scoped MANAGER's
 *   allowed regions, optionally intersected with an explicit ?region). When a non-null array is
 *   given it wins over adminRegionId: an empty array matches NOTHING (scoped-out), a populated
 *   array matches content associated with any of the ids. See utils/regionScope.js.
 * @param {('DRAFT'|'PUBLISHED'|null)} [opts.adminStatus] - explicit status filter requested by staff
 * @param {('MOBILE'|'WEB'|null)} [opts.platform] - storefront platform filter (BannerImage only)
 * @param {('MOBILE'|'WEB'|null)} [opts.adminPlatform] - explicit platform filter requested by staff (BannerImage only)
 * @returns {object} Prisma where fragment
 *
 * NOTE: `platform`/`adminPlatform` apply ONLY to BannerImage (the only model with
 * a `platform` column). They are omitted by every other caller, so they never leak
 * into Product / Category / Section where clauses.
 */
// Sentinel region id that can never match a real join row — used so an empty
// region-scope (a scoped manager with a foreign-region filter) narrows to zero
// rows rather than silently widening to all regions.
const NO_MATCH_REGION_ID = '00000000-0000-0000-0000-000000000000';

function buildVisibilityWhere({ isStaff, regionId, adminRegionId = null, adminRegionIds = null, adminStatus = null, platform = null, adminPlatform = null }) {
  const where = {};

  if (!isStaff) {
    where.status = 'PUBLISHED';
    if (regionId) where.regions = { some: { regionId } };
    if (platform) where.platform = platform;
    return where;
  }

  // Staff: unfiltered unless they explicitly asked to narrow the view, OR they are a
  // region-scoped manager (adminRegionIds is a non-null array).
  if (adminStatus === 'DRAFT' || adminStatus === 'PUBLISHED') where.status = adminStatus;
  if (Array.isArray(adminRegionIds)) {
    // Overlap match: content associated with ANY allowed region. Empty array (foreign
    // filter / scoped-out) => a sentinel that matches nothing.
    where.regions = adminRegionIds.length
      ? { some: { regionId: { in: adminRegionIds } } }
      : { some: { regionId: NO_MATCH_REGION_ID } };
  } else if (adminRegionId) {
    where.regions = { some: { regionId: adminRegionId } };
  }
  if (adminPlatform) where.platform = adminPlatform;
  return where;
}

/**
 * ZONE-level visibility fragment, applied ONLY to models that actually have a zone
 * join table — Product (`ProductZone`) and Category (`CategoryZone`). It is kept out
 * of buildVisibilityWhere() on purpose: Section and BannerImage are region-aware but
 * have NO zone relation, and emitting `zoneLeadDays` in their where clause would make
 * Prisma throw on an unknown field.
 *
 * Semantics are the INVERSE of region visibility. A region is visible by row PRESENCE
 * (`regions: { some: { regionId } }`), but the zone tables predate this feature and
 * exist to carry lead-time / fee overrides, where an ABSENT row means "inherit". With
 * zero rows in them today, presence-based visibility would hide the entire catalog in
 * every zone. So hiding is an explicit opt-out flag and we match with `none`: content
 * without a row for this zone stays visible, and only an explicit `hidden: true` row
 * drops it.
 *
 * Returns {} for staff, and {} when the visitor has no zone selected yet — an
 * un-located browser still sees the full catalog. That is deliberate: catalog hiding
 * is best-effort, and checkout re-resolves the real delivery zone and refuses the
 * order, which is the authoritative gate.
 *
 * @param {object} opts
 * @param {boolean} opts.isStaff
 * @param {string|null} [opts.zoneId] - resolved storefront delivery zone id
 * @returns {object} Prisma where fragment ({} when not applicable)
 */
function buildZoneVisibilityWhere({ isStaff, zoneId = null } = {}) {
  if (isStaff || !zoneId) return {};
  return { zoneLeadDays: { none: { zoneId, hidden: true } } };
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
function buildCategoryVisibilityWhere({ isStaff, zoneId = null }, rescueIds = null) {
  if (isStaff) return {};
  const hidden = { category: { status: 'DRAFT', draftScope: 'ENTIRE_STORE' } };
  // A category hidden in this zone takes its products with it, mirroring how an
  // ENTIRE_STORE draft category cascades. Expressed on the product's `category`
  // relation so it merges into the same NOT/OR shape as the draft rule.
  // `hidden` removes the category outright; `comingSoon` presents the CATEGORY as a
  // teaser and takes its products out of every listing with it (the category card still
  // renders, badged and non-clickable). Both therefore drop the products here, which is
  // what makes the rule hold for payloads that embed products — a Section's nested
  // products never carry the folded category flag, so a frontend-only filter would miss
  // them. A product's OWN teaser is deliberately NOT covered: that one stays listed.
  const zoneHiddenCategory = zoneId
    ? {
        category: {
          zoneLeadDays: { some: { zoneId, OR: [{ hidden: true }, { comingSoon: true }] } },
        },
      }
    : null;

  const clauses = [{ NOT: hidden }];
  if (zoneHiddenCategory) clauses.push({ NOT: zoneHiddenCategory });

  if (Array.isArray(rescueIds) && rescueIds.length > 0) {
    // A section-featured product is rescued from the DRAFT-category rule only.
    // A zone hide is a hard delivery-availability statement, so it is never
    // rescued — it stays hidden even when a published Section features it.
    const rescued = { OR: [{ NOT: hidden }, { id: { in: rescueIds } }] };
    return zoneHiddenCategory ? { AND: [rescued, { NOT: zoneHiddenCategory }] } : rescued;
  }
  return clauses.length === 1 ? clauses[0] : { AND: clauses };
}

/**
 * Prisma `_count.select` fragment for counting a category's products the way the
 * STOREFRONT actually renders them. The raw relation count (`{ products: true }`)
 * tallies EVERY product — DRAFT and other-region rows included — so a category card
 * reads e.g. "11" while the shop grid (PUBLISHED + in-region only) shows 4. For
 * non-staff we therefore filter the count with the SAME visibility predicate the
 * product listing uses (buildVisibilityWhere), so the sidebar / section count matches
 * the grid and the "load more" total. Staff keep the true, unfiltered total so the
 * admin list still shows every product in the category.
 *
 * @param {object} visibility - same shape buildVisibilityWhere consumes
 * @returns {object} Prisma `_count.select` fragment
 */
function buildProductCountSelect(visibility = {}) {
  if (visibility.isStaff) return { products: true };
  // Zone-hidden products must drop out of the count too, otherwise a category card
  // reads a higher number than the grid beneath it actually renders.
  return {
    products: {
      where: {
        ...buildVisibilityWhere(visibility),
        ...buildZoneVisibilityWhere(visibility),
      },
    },
  };
}

module.exports = {
  buildVisibilityWhere,
  buildZoneVisibilityWhere,
  buildCategoryVisibilityWhere,
  buildProductCountSelect,
};
