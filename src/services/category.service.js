const prisma = require('../config/db');
const { autoTranslate, fillBilingualGapsFromTwin } = require('../utils/bilingual');
const regionService = require('./region.service');
const productService = require('./product.service');
const { buildVisibilityWhere, buildZoneVisibilityWhere, buildProductCountSelect } = require('../utils/regionVisibility');
const { parseDeliveryLeadDays } = require('../utils/deliveryLeadDays');
const { parseCashArrangementFeeSchedule } = require('../utils/cashArrangementMath');
const { normalizeGiftCardMode } = require('../utils/giftCardMode');

const decimalToNumber = (v) => (v == null ? null : Number(v));

const CATEGORY_BILINGUAL = [
  { src: 'title', dst: 'title_ar' },
  { src: 'description', dst: 'description_ar' },
];
// Pairs whose EN column is NOT NULL in the schema — must be filled before Prisma.create.
const CATEGORY_REQUIRED_PAIRS = [{ src: 'title', dst: 'title_ar' }];

const REGION_INCLUDE = {
  regions: { include: { region: { select: { id: true, code: true, name: true, name_ar: true } } } },
  zoneLeadDays: {
    select: {
      zoneId: true,
      deliveryLeadDays: true,
      cashArrangementFeeStepAmount: true,
      cashArrangementFeeMarginPercent: true,
      // Zone visibility — without this the admin form reopens with every
      // "hide in zone" box unchecked even though the hide is live.
      hidden: true,
      comingSoon: true,
    },
  },
};

// Storefront (non-staff) include: just the requesting region's own coming-soon row
// (no nested `region` tag, so mapCategory takes the storefront overlay branch). Empty
// object when there's no region context (mapCategory then keeps the global flag).
function categoryRegionComingSoonInclude(regionId, zoneId = null) {
  return {
    ...(regionId
      ? { regions: { where: { regionId }, select: { comingSoon: true, onSale: true } } }
      : {}),
    // This zone's teaser row. Folded into `comingSoon` by mapCategory so the category
    // card shows the COMING SOON overlay (and becomes non-clickable) in that zone, and
    // the flag cascades to the category's products through the products adapter.
    ...(zoneId ? { zoneLeadDays: { where: { zoneId }, select: { comingSoon: true } } } : {}),
  };
}

/** Trim a label to null when blank/absent. */
function cleanSaleLabel(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function normalizeStatus(value, fallback = 'DRAFT') {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toUpperCase();
  return v === 'PUBLISHED' ? 'PUBLISHED' : v === 'DRAFT' ? 'DRAFT' : fallback;
}

function normalizeDraftScope(value, fallback = 'HOME_ONLY') {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toUpperCase();
  return v === 'ENTIRE_STORE' ? 'ENTIRE_STORE' : v === 'HOME_ONLY' ? 'HOME_ONLY' : fallback;
}

async function resolveWriteRegionIds(regionIds) {
  if (Array.isArray(regionIds) && regionIds.length > 0) {
    return regionService.assertValidRegionIds(regionIds);
  }
  const def = await regionService.getDefaultRegion();
  return def ? [def.id] : [];
}

/**
 * Which of `regionIds` this category is "coming soon" in. Prefers the new
 * per-region `comingSoonRegionIds` (a subset of the category's regions); falls
 * back to the legacy global `comingSoon` boolean (true = coming-soon in ALL its
 * regions) so older admin clients keep working. Empty unless PUBLISHED (a draft
 * is already hidden, so coming-soon is meaningless there).
 */
function resolveComingSoonRegionSet(data, regionIds, status) {
  if (status !== 'PUBLISHED') return new Set();
  const allowed = new Set(regionIds);
  if (Array.isArray(data.comingSoonRegionIds)) {
    return new Set(data.comingSoonRegionIds.filter((id) => allowed.has(id)));
  }
  if (data.comingSoon === true) return new Set(regionIds);
  return new Set();
}

/**
 * Which of `regionIds` this category is "on sale" in. Prefers per-region `onSaleRegionIds`
 * (a subset of the category's regions); falls back to the legacy global `onSale` boolean.
 * Orthogonal to status (a sale is a visual badge, not an orderability gate).
 */
function resolveOnSaleRegionSet(data, regionIds) {
  const allowed = new Set(regionIds);
  if (Array.isArray(data.onSaleRegionIds)) {
    return new Set(data.onSaleRegionIds.filter((id) => allowed.has(id)));
  }
  if (data.onSale === true) return new Set(regionIds);
  return new Set();
}

/** Shape a category row (with regions/_count includes) for API output. */
function mapCategory(category) {
  if (!category) return null;
  const {
    regions,
    zoneLeadDays,
    _count,
    cashArrangementFeeStepAmount,
    cashArrangementFeeMarginPercent,
    ...rest
  } = category;
  const out = {
    ...rest,
    totalProducts: _count?.products ?? rest.totalProducts,
    cashArrangementFeeStepAmount: decimalToNumber(cashArrangementFeeStepAmount),
    cashArrangementFeeMarginPercent: decimalToNumber(cashArrangementFeeMarginPercent),
  };
  // `regions` has two shapes: staff reads (REGION_INCLUDE) carry a nested `region`
  // tag; storefront reads carry only the requesting region's scalar row (no `region`).
  if (Array.isArray(regions)) {
    const hasRegionTags = regions.some((r) => r.region);
    if (!hasRegionTags) {
      // Storefront: overlay THIS region's coming-soon + on-sale onto the returned flags,
      // so a category can be a teaser / on sale in one region and not another.
      // The zone teaser ORs on top of the region one — a zone can only ADD a teaser.
      const zoneComingSoon = Array.isArray(zoneLeadDays)
        ? zoneLeadDays.some((zrow) => zrow.comingSoon)
        : false;
      out.comingSoon = Boolean(regions[0]?.comingSoon) || zoneComingSoon;
      out.onSale = Boolean(regions[0]?.onSale);
      return out;
    }
    const regionList = regions.map((r) => r.region).filter(Boolean);
    out.regions = regionList;
    out.regionIds = regionList.map((r) => r.id);
    // Which regions this category is a coming-soon teaser in (for the admin edit form).
    out.comingSoonRegionIds = regions.filter((r) => r.comingSoon).map((r) => r.regionId);
    // Which regions this category is on sale in (for the admin edit form).
    out.onSaleRegionIds = regions.filter((r) => r.onSale).map((r) => r.regionId);
    // Per-region "ships within N days" + cash-arrangement fee overrides, so the admin
    // edit form can show and edit a different value per region. Additive alongside the tags.
    out.regionLeadDays = regions.map((r) => ({
      regionId: r.regionId,
      deliveryLeadDays: r.deliveryLeadDays ?? null,
      cashArrangementFeeStepAmount: decimalToNumber(r.cashArrangementFeeStepAmount),
      cashArrangementFeeMarginPercent: decimalToNumber(r.cashArrangementFeeMarginPercent),
    }));
    // Per-zone overrides (highest precedence), for the admin edit form.
    out.zoneLeadDays = (zoneLeadDays ?? []).map((z) => ({
      zoneId: z.zoneId,
      deliveryLeadDays: z.deliveryLeadDays ?? null,
      cashArrangementFeeStepAmount: decimalToNumber(z.cashArrangementFeeStepAmount),
      cashArrangementFeeMarginPercent: decimalToNumber(z.cashArrangementFeeMarginPercent),
      hidden: Boolean(z.hidden),
      comingSoon: Boolean(z.comingSoon),
    }));
  }
  return out;
}

/** Index an incoming `regionLeadDays: {regionId, deliveryLeadDays, cashArrangementFeeStepAmount,
 *  cashArrangementFeeMarginPercent}[]` payload into a Map of {deliveryLeadDays, cashArrangementFeeStepAmount,
 *  cashArrangementFeeMarginPercent}, validating each value (throws VALIDATION on a bad number). */
function buildCategoryRegionLeadMap(regionLeadDays) {
  const map = new Map();
  if (!Array.isArray(regionLeadDays)) return map;
  for (const entry of regionLeadDays) {
    if (!entry || typeof entry.regionId !== 'string' || !entry.regionId) continue;
    const deliveryLeadDays = parseDeliveryLeadDays(entry.deliveryLeadDays);
    const feeSchedule = parseCashArrangementFeeSchedule({
      feeStepAmount: entry.cashArrangementFeeStepAmount,
      feeMarginPercent: entry.cashArrangementFeeMarginPercent,
    });
    map.set(entry.regionId, {
      deliveryLeadDays,
      cashArrangementFeeStepAmount: feeSchedule.feeStepAmount,
      cashArrangementFeeMarginPercent: feeSchedule.feeMarginPercent,
    });
  }
  return map;
}

/** Clean a `zoneLeadDays: [{ zoneId, deliveryLeadDays, cashArrangementFeeStepAmount,
 *  cashArrangementFeeMarginPercent }]` payload into CategoryZone rows, keeping only entries
 *  with a real override (a non-null lead OR a cash-arrangement fee schedule). */
function buildCategoryZoneLeadRows(zoneLeadDays) {
  if (!Array.isArray(zoneLeadDays)) return [];
  const rows = [];
  const seen = new Set();
  for (const entry of zoneLeadDays) {
    if (!entry || typeof entry.zoneId !== 'string' || !entry.zoneId) continue;
    if (seen.has(entry.zoneId)) continue;
    const lead = parseDeliveryLeadDays(entry.deliveryLeadDays);
    const feeSchedule = parseCashArrangementFeeSchedule({
      feeStepAmount: entry.cashArrangementFeeStepAmount,
      feeMarginPercent: entry.cashArrangementFeeMarginPercent,
    });
    // `hidden` alone is a real reason to keep the row: zone VISIBILITY lives on this
    // same join table, so an entry that only hides the category (no lead/fee override)
    // must still be stored or the hide would be silently discarded.
    const hidden = entry.hidden === true;
    const comingSoon = entry.comingSoon === true;
    if (lead == null && feeSchedule.feeStepAmount == null && !hidden && !comingSoon) continue;
    seen.add(entry.zoneId);
    rows.push({
      zoneId: entry.zoneId,
      deliveryLeadDays: lead,
      cashArrangementFeeStepAmount: feeSchedule.feeStepAmount,
      cashArrangementFeeMarginPercent: feeSchedule.feeMarginPercent,
      hidden,
      comingSoon,
    });
  }
  return rows;
}

/**
 * Next sortOrder for a new category = one past the current max, so new categories
 * always append to the end of the admin-defined order. Mirrors DeliveryZone.
 */
async function nextCategorySortOrder() {
  const agg = await prisma.category.aggregate({ _max: { sortOrder: true } });
  return (agg._max.sortOrder ?? -1) + 1;
}

/**
 * Persist a drag-reorder of categories. Accepts [{ id, sortOrder }]; ignores any
 * malformed entry and writes the rest in one transaction. Categories are global
 * (not region-scoped) so there's no per-region tier to reconcile — the sortOrder
 * is a single store-wide order that the storefront home grid + menus follow.
 * Mirrors deliveryZone.service.reorderZones.
 */
async function reorderCategories(items) {
  const clean = (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it.id === 'string' && Number.isInteger(it.sortOrder))
    .map((it) => ({ id: it.id, sortOrder: it.sortOrder }));
  if (clean.length === 0) return { count: 0 };

  await prisma.$transaction(
    clean.map((it) =>
      prisma.category.update({ where: { id: it.id }, data: { sortOrder: it.sortOrder } })
    )
  );
  return { count: clean.length };
}

async function createCategory(data) {
  const status = normalizeStatus(data.status);
  const draftScope = normalizeDraftScope(data.draftScope);
  const regionIds = await resolveWriteRegionIds(data.regionIds);
  // Optional override of Settings.defaultDeliveryLeadDays for every product in this
  // category that doesn't set its own Product.deliveryLeadDays. null/undefined -> no
  // override (falls through to the global default).
  const deliveryLeadDays = parseDeliveryLeadDays(data.deliveryLeadDays);
  // Default cash-arrangement fee schedule for this category (both-or-neither; see
  // utils/cashArrangementMath.js for the full precedence chain).
  const cashArrangementFee = parseCashArrangementFeeSchedule({
    feeStepAmount: data.cashArrangementFeeStepAmount,
    feeMarginPercent: data.cashArrangementFeeMarginPercent,
  });
  // Optional PER-REGION lead-day + cash-arrangement fee overrides (same values can differ by region).
  const regionLeadMap = buildCategoryRegionLeadMap(data.regionLeadDays);
  // Optional PER-ZONE overrides (highest precedence).
  const zoneLeadRows = buildCategoryZoneLeadRows(data.zoneLeadDays);
  // Which regions this category is a "coming soon" teaser in (per-region, default none).
  const comingSoonSet = resolveComingSoonRegionSet(data, regionIds, status);
  const onSaleSet = resolveOnSaleRegionSet(data, regionIds);
  // New categories append to the end of the admin-defined order (max + 1), same as
  // DeliveryZone/BannerImage. Order is then changed only via drag-reorder.
  const sortOrder = await nextCategorySortOrder();

  const draft = {
    title: data.title ?? null,
    title_ar: data.title_ar ?? null,
    description: data.description ?? null,
    description_ar: data.description_ar ?? null,
  };
  await autoTranslate(draft, CATEGORY_BILINGUAL);
  // If Google failed for the required pair, copy across so the NOT NULL column has a value.
  fillBilingualGapsFromTwin(draft, CATEGORY_REQUIRED_PAIRS);
  const category = await prisma.category.create({
    data: {
      title: draft.title,
      title_ar: draft.title_ar ?? null,
      description: draft.description ?? null,
      description_ar: draft.description_ar ?? null,
      image: data.image ?? null,
      totalProducts: 0,
      sortOrder,
      status,
      // Global mirror = "coming soon in at least one region" (drives the admin list
      // badge + legacy/global consumers). The authoritative per-region state lives on
      // the CategoryRegion rows below; storefront reads resolve the region's own value.
      comingSoon: comingSoonSet.size > 0,
      // On-sale global mirror (admin list badge) + custom Sale-badge label (bilingual;
      // blank falls back to section, then the default "Sale" on the storefront).
      onSale: onSaleSet.size > 0,
      saleLabel: cleanSaleLabel(data.saleLabel),
      saleLabel_ar: cleanSaleLabel(data.saleLabel_ar),
      giftCardMode: normalizeGiftCardMode(data.giftCardMode),
      draftScope,
      deliveryLeadDays,
      cashArrangementFeeStepAmount: cashArrangementFee.feeStepAmount,
      cashArrangementFeeMarginPercent: cashArrangementFee.feeMarginPercent,
      ...(regionIds.length > 0
        ? {
            regions: {
              create: regionIds.map((regionId) => {
                const rl = regionLeadMap.get(regionId);
                return {
                  regionId,
                  deliveryLeadDays: rl?.deliveryLeadDays ?? null,
                  cashArrangementFeeStepAmount: rl?.cashArrangementFeeStepAmount ?? null,
                  cashArrangementFeeMarginPercent: rl?.cashArrangementFeeMarginPercent ?? null,
                  comingSoon: comingSoonSet.has(regionId),
                  onSale: onSaleSet.has(regionId),
                };
              }),
            },
          }
        : {}),
      ...(zoneLeadRows.length > 0 ? { zoneLeadDays: { create: zoneLeadRows } } : {}),
    },
    include: { ...REGION_INCLUDE, _count: { select: { products: true } } },
  });
  return mapCategory(category);
}

async function updateCategory(id, data) {
  // Only translate sides the admin actually touched in this request.
  const draft = {};
  if (data.title !== undefined) draft.title = data.title;
  if (data.title_ar !== undefined) draft.title_ar = data.title_ar;
  if (data.description !== undefined) draft.description = data.description;
  if (data.description_ar !== undefined) draft.description_ar = data.description_ar;
  await autoTranslate(draft, CATEGORY_BILINGUAL);

  // Per-region coming-soon is being (re)set when the admin sends comingSoonRegionIds
  // (new) or the legacy global comingSoon boolean.
  const comingSoonExplicit = data.comingSoonRegionIds !== undefined || data.comingSoon !== undefined;
  const onSaleExplicit = data.onSaleRegionIds !== undefined || data.onSale !== undefined;

  const newRegionIds = data.regionIds !== undefined
    ? await regionService.assertValidRegionIds(Array.isArray(data.regionIds) ? data.regionIds : [])
    : null;
  const regionLeadMap = buildCategoryRegionLeadMap(data.regionLeadDays);
  // Per-zone lead overrides: null = key absent (leave untouched); array = full replace.
  const zoneLeadRows = data.zoneLeadDays !== undefined ? buildCategoryZoneLeadRows(data.zoneLeadDays) : null;
  // Rewrite the CategoryRegion rows when EITHER the region set OR the per-region lead
  // days changed. Existing rows are read up front so regions left out of the incoming
  // payload keep their current lead days (an edit to one region mustn't null the rest).
  const wantRegionRewrite = data.regionIds !== undefined || data.regionLeadDays !== undefined;
  let existingCatRegionLead = new Map();
  let existingCatRegionIds = [];
  // Existing per-region coming-soon + on-sale, so a regionIds/lead rewrite preserves them.
  let existingCatComingSoon = new Map();
  let existingCatOnSale = new Map();
  if (wantRegionRewrite) {
    const rows = await prisma.categoryRegion.findMany({
      where: { categoryId: id },
      select: {
        regionId: true,
        deliveryLeadDays: true,
        cashArrangementFeeStepAmount: true,
        cashArrangementFeeMarginPercent: true,
        comingSoon: true,
        onSale: true,
      },
    });
    existingCatRegionLead = new Map(rows.map((r) => [r.regionId, {
      deliveryLeadDays: r.deliveryLeadDays ?? null,
      cashArrangementFeeStepAmount: decimalToNumber(r.cashArrangementFeeStepAmount),
      cashArrangementFeeMarginPercent: decimalToNumber(r.cashArrangementFeeMarginPercent),
    }]));
    existingCatComingSoon = new Map(rows.map((r) => [r.regionId, !!r.comingSoon]));
    existingCatOnSale = new Map(rows.map((r) => [r.regionId, !!r.onSale]));
    existingCatRegionIds = rows.map((r) => r.regionId);
  }

  // Fetch existing status/draftScope so a malformed value falls back to the current
  // one instead of silently resetting (status -> DRAFT, draftScope -> HOME_ONLY). Also
  // needed to know the effective status when reconciling per-region coming-soon.
  const existing = data.status !== undefined || data.draftScope !== undefined || comingSoonExplicit
    ? await prisma.category.findUnique({ where: { id }, select: { status: true, draftScope: true } })
    : null;

  await prisma.$transaction(async (tx) => {
    await tx.category.update({
      where: { id },
      data: {
        ...(draft.title != null && { title: draft.title }),
        ...(draft.title_ar !== undefined && { title_ar: draft.title_ar ?? null }),
        ...(draft.description !== undefined && { description: draft.description }),
        ...(draft.description_ar !== undefined && { description_ar: draft.description_ar ?? null }),
        ...(data.image !== undefined && { image: data.image }),
        ...(data.status !== undefined && { status: normalizeStatus(data.status, existing?.status) }),
        // Per-region coming-soon (incl. the global `comingSoon` mirror) is reconciled
        // AFTER the region rows below — see the coming-soon block at the end of the tx.
        ...(data.draftScope !== undefined && { draftScope: normalizeDraftScope(data.draftScope, existing?.draftScope) }),
        // Category-default gift-card mode. Omit to leave untouched; send null/'' to clear
        // the default (products fall through to MESSAGE).
        ...(data.giftCardMode !== undefined && { giftCardMode: normalizeGiftCardMode(data.giftCardMode) }),
        // Custom Sale-badge label (bilingual). Omit to leave untouched; blank clears it.
        ...(data.saleLabel !== undefined && { saleLabel: cleanSaleLabel(data.saleLabel) }),
        ...(data.saleLabel_ar !== undefined && { saleLabel_ar: cleanSaleLabel(data.saleLabel_ar) }),
        // Optional override; omit to leave untouched, or send null to clear it back to
        // "no override" (falls through to Settings.defaultDeliveryLeadDays).
        ...(data.deliveryLeadDays !== undefined && { deliveryLeadDays: parseDeliveryLeadDays(data.deliveryLeadDays) }),
        // Fee schedule is a matched pair — only touched when EITHER field is sent (both-or-
        // neither enforced by parseCashArrangementFeeSchedule).
        ...((data.cashArrangementFeeStepAmount !== undefined || data.cashArrangementFeeMarginPercent !== undefined) && (() => {
          const fee = parseCashArrangementFeeSchedule({
            feeStepAmount: data.cashArrangementFeeStepAmount,
            feeMarginPercent: data.cashArrangementFeeMarginPercent,
          });
          return {
            cashArrangementFeeStepAmount: fee.feeStepAmount,
            cashArrangementFeeMarginPercent: fee.feeMarginPercent,
          };
        })()),
      },
    });
    if (wantRegionRewrite) {
      // Explicit regionIds when sent, else keep the current region set (a
      // lead-days-only edit shouldn't change which regions the category is in).
      const targetRegionIds = newRegionIds !== null ? newRegionIds : existingCatRegionIds;
      await tx.categoryRegion.deleteMany({ where: { categoryId: id } });
      if (targetRegionIds.length > 0) {
        await tx.categoryRegion.createMany({
          data: targetRegionIds.map((regionId) => {
            // Incoming per-region entry wins (even null = clear); else carry existing forward
            // so an edit to one region's lead/fee doesn't null out another region's values.
            const rl = regionLeadMap.has(regionId)
              ? regionLeadMap.get(regionId)
              : existingCatRegionLead.get(regionId);
            return {
              categoryId: id,
              regionId,
              deliveryLeadDays: rl?.deliveryLeadDays ?? null,
              cashArrangementFeeStepAmount: rl?.cashArrangementFeeStepAmount ?? null,
              cashArrangementFeeMarginPercent: rl?.cashArrangementFeeMarginPercent ?? null,
              // Preserve this region's coming-soon across a regionIds/lead rewrite; a
              // brand-new region defaults to false (available). The explicit coming-soon
              // reconcile below then applies any comingSoonRegionIds change.
              comingSoon: existingCatComingSoon.get(regionId) ?? false,
              // Preserve this region's on-sale across a rewrite; new region → false.
              onSale: existingCatOnSale.get(regionId) ?? false,
            };
          }),
          skipDuplicates: true,
        });
      }
    }

    // Reconcile per-region coming-soon when the admin changed it (comingSoonRegionIds /
    // legacy comingSoon) or changed status (drafting forces it off). Targeted updateMany
    // so we don't need to also rewrite the region rows.
    if (comingSoonExplicit || data.status !== undefined) {
      const effectiveStatus =
        data.status !== undefined ? normalizeStatus(data.status, existing?.status) : existing?.status;
      const currentRows = await tx.categoryRegion.findMany({ where: { categoryId: id }, select: { regionId: true } });
      const currentRegionIds = currentRows.map((r) => r.regionId);
      let comingSoonSet;
      if (effectiveStatus !== 'PUBLISHED') comingSoonSet = new Set(); // draft clears all
      else if (comingSoonExplicit) comingSoonSet = resolveComingSoonRegionSet(data, currentRegionIds, effectiveStatus);
      else comingSoonSet = null; // published + status-only change (no coming-soon fields) → preserve
      if (comingSoonSet !== null) {
        await tx.categoryRegion.updateMany({ where: { categoryId: id }, data: { comingSoon: false } });
        if (comingSoonSet.size > 0) {
          await tx.categoryRegion.updateMany({
            where: { categoryId: id, regionId: { in: [...comingSoonSet] } },
            data: { comingSoon: true },
          });
        }
        // Keep the global mirror in step with "coming soon in at least one region".
        await tx.category.update({ where: { id }, data: { comingSoon: comingSoonSet.size > 0 } });
      }
    }

    // Reconcile per-region on-sale independently of status (a sale is visual, not an
    // orderability gate). Same targeted updateMany pattern as coming-soon above.
    if (onSaleExplicit) {
      const currentRows = await tx.categoryRegion.findMany({ where: { categoryId: id }, select: { regionId: true } });
      const onSaleSet = resolveOnSaleRegionSet(data, currentRows.map((r) => r.regionId));
      await tx.categoryRegion.updateMany({ where: { categoryId: id }, data: { onSale: false } });
      if (onSaleSet.size > 0) {
        await tx.categoryRegion.updateMany({
          where: { categoryId: id, regionId: { in: [...onSaleSet] } },
          data: { onSale: true },
        });
      }
      await tx.category.update({ where: { id }, data: { onSale: onSaleSet.size > 0 } });
    }

    // Per-zone lead overrides: full replace when the key was sent.
    if (zoneLeadRows !== null) {
      await tx.categoryZone.deleteMany({ where: { categoryId: id } });
      if (zoneLeadRows.length > 0) {
        await tx.categoryZone.createMany({
          data: zoneLeadRows.map((z) => ({ categoryId: id, ...z })),
          skipDuplicates: true,
        });
      }
    }
  });

  const category = await prisma.category.findUnique({
    where: { id },
    include: { ...REGION_INCLUDE, _count: { select: { products: true } } },
  });
  return mapCategory(category);
}

async function deleteCategory(id) {
  // CAT-4: count + delete in ONE transaction so a product created between the count and
  // the delete can't slip through. The DB-level onDelete:Restrict FK is the final guard;
  // if it fires (race), Prisma throws P2003 which the controller maps to a clean 409.
  return prisma.$transaction(async (tx) => {
    const count = await tx.product.count({ where: { categoryId: id } });
    if (count > 0) {
      const err = new Error('Cannot delete category with products');
      err.code = 'CATEGORY_HAS_PRODUCTS';
      throw err;
    }
    return tx.category.delete({ where: { id } });
  });
}

async function getAllCategories(visibility = {}) {
  const categories = await prisma.category.findMany({
    where: { ...buildVisibilityWhere(visibility), ...buildZoneVisibilityWhere(visibility) },
    // Admin-defined display order first (drag-reorder), newest-first as the
    // tiebreak so pre-existing categories (all sortOrder 0) keep their historical
    // order until an admin reorders. Storefront home grid + menus consume this order.
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    include: {
      ...(visibility.isStaff ? REGION_INCLUDE : categoryRegionComingSoonInclude(visibility.regionId, visibility.zoneId)),
      // Storefront count reflects only PUBLISHED + in-region products (not DRAFT /
      // other-region), so the category-card badge matches the shop grid. Staff get
      // the true total. See buildProductCountSelect.
      _count: { select: buildProductCountSelect(visibility) },
    },
  });
  return categories.map(mapCategory);
}

async function getCategoryById(id, includeProducts = false, visibility = {}) {
  // Apply the same region + status visibility filter to nested products that
  // section.service.js uses, so non-staff only see PUBLISHED + in-region products
  // and a DRAFT / other-region product never leaks into the storefront.
  // Nested products inherit the zone hide too, so a product hidden in this zone
  // never leaks through a category's embedded product list.
  const contentWhere = {
    ...buildVisibilityWhere(visibility),
    ...buildZoneVisibilityWhere(visibility),
  };
  const hasFilter = Object.keys(contentWhere).length > 0;
  const isStaff = !!visibility.isStaff;
  const include = {
    ...(visibility.isStaff ? REGION_INCLUDE : categoryRegionComingSoonInclude(visibility.regionId, visibility.zoneId)),
    // Storefront count reflects only PUBLISHED + in-region products; staff get the
    // true total. Matches the shop grid / "load more" total. See buildProductCountSelect.
    _count: { select: buildProductCountSelect(visibility) },
    ...(includeProducts
      ? {
          products: {
            ...(hasFilter ? { where: contentWhere } : {}),
            // CAT-1: bound the nested product fetch so a category with thousands of
            // products can't blow up the response / DB load on this public endpoint.
            // Deterministic newest-first; full browsing uses the paginated
            // GET /products/category/:categoryId endpoint.
            take: 100,
            orderBy: { createdAt: 'desc' },
            include: {
              category: { select: { id: true, title: true, deliveryLeadDays: true, comingSoon: true, giftCardMode: true, onSale: true, saleLabel: true, saleLabel_ar: true } },
              images: { orderBy: { sortOrder: 'asc' } },
              descriptions: { orderBy: { sortOrder: 'asc' } },
              productOptions: { orderBy: { sortOrder: 'asc' } },
              ...(isStaff ? REGION_INCLUDE : {}),
            },
          },
        }
      : {}),
  };
  const category = await prisma.category.findFirst({
    where: { id, ...buildVisibilityWhere(visibility), ...buildZoneVisibilityWhere(visibility) },
    include,
  });
  if (!category) return null;
  const { products, ...rest } = category;
  const mapped = mapCategory(rest);
  if (products) {
    mapped.products = products.map(productService.mapProduct);
    // Same resolved lead-time field the storefront product endpoints expose (see
    // product.service.js's attachResolvedDeliveryLeadDays) — this nested list is
    // consumed the same way (e.g. GET /categories/:id), so it must carry it too.
    await productService.attachResolvedDeliveryLeadDays(mapped.products, isStaff ? null : visibility.regionId);
  }
  return mapped;
}

async function incrementCategoryProductCount(categoryId, delta = 1) {
  return prisma.category.update({
    where: { id: categoryId },
    data: { totalProducts: { increment: delta } },
  });
}

async function decrementCategoryProductCount(categoryId, delta = 1) {
  return prisma.category.update({
    where: { id: categoryId },
    data: { totalProducts: { decrement: delta } },
  });
}

module.exports = {
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
  getAllCategories,
  getCategoryById,
  incrementCategoryProductCount,
  decrementCategoryProductCount,
  mapCategory,
};
