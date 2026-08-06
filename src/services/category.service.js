const prisma = require('../config/db');
const { autoTranslate, fillBilingualGapsFromTwin } = require('../utils/bilingual');
const regionService = require('./region.service');
const productService = require('./product.service');
const { buildVisibilityWhere } = require('../utils/regionVisibility');
const { parseDeliveryLeadDays } = require('../utils/deliveryLeadDays');
const { parseCashArrangementFeeSchedule } = require('../utils/cashArrangementMath');

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
    },
  },
};

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
  // Region tags only attached for staff reads (storefront doesn't need them).
  if (Array.isArray(regions)) {
    const regionList = regions.map((r) => r.region).filter(Boolean);
    out.regions = regionList;
    out.regionIds = regionList.map((r) => r.id);
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
    if (lead == null && feeSchedule.feeStepAmount == null) continue;
    seen.add(entry.zoneId);
    rows.push({
      zoneId: entry.zoneId,
      deliveryLeadDays: lead,
      cashArrangementFeeStepAmount: feeSchedule.feeStepAmount,
      cashArrangementFeeMarginPercent: feeSchedule.feeMarginPercent,
    });
  }
  return rows;
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
      status,
      // Coming-soon is meaningful only on a visible (PUBLISHED) category; never persist
      // a DRAFT+comingSoon combo (draft is already hidden).
      comingSoon: status === 'PUBLISHED' ? !!data.comingSoon : false,
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
  if (wantRegionRewrite) {
    const rows = await prisma.categoryRegion.findMany({
      where: { categoryId: id },
      select: {
        regionId: true,
        deliveryLeadDays: true,
        cashArrangementFeeStepAmount: true,
        cashArrangementFeeMarginPercent: true,
      },
    });
    existingCatRegionLead = new Map(rows.map((r) => [r.regionId, {
      deliveryLeadDays: r.deliveryLeadDays ?? null,
      cashArrangementFeeStepAmount: decimalToNumber(r.cashArrangementFeeStepAmount),
      cashArrangementFeeMarginPercent: decimalToNumber(r.cashArrangementFeeMarginPercent),
    }]));
    existingCatRegionIds = rows.map((r) => r.regionId);
  }

  // Fetch existing status/draftScope so a malformed value falls back to the current
  // one instead of silently resetting (status -> DRAFT, draftScope -> HOME_ONLY).
  const existing = data.status !== undefined || data.draftScope !== undefined
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
        // comingSoon only applies while PUBLISHED; drafting the category forces it off.
        ...((data.comingSoon !== undefined || data.status !== undefined) && (() => {
          const effectiveStatus =
            data.status !== undefined ? normalizeStatus(data.status, existing?.status) : existing?.status;
          if (effectiveStatus !== 'PUBLISHED') return { comingSoon: false };
          if (data.comingSoon !== undefined) return { comingSoon: !!data.comingSoon };
          return {};
        })()),
        ...(data.draftScope !== undefined && { draftScope: normalizeDraftScope(data.draftScope, existing?.draftScope) }),
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
            };
          }),
          skipDuplicates: true,
        });
      }
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
    where: buildVisibilityWhere(visibility),
    orderBy: { createdAt: 'desc' },
    include: { ...(visibility.isStaff ? REGION_INCLUDE : {}), _count: { select: { products: true } } },
  });
  return categories.map(mapCategory);
}

async function getCategoryById(id, includeProducts = false, visibility = {}) {
  // Apply the same region + status visibility filter to nested products that
  // section.service.js uses, so non-staff only see PUBLISHED + in-region products
  // and a DRAFT / other-region product never leaks into the storefront.
  const contentWhere = buildVisibilityWhere(visibility);
  const hasFilter = Object.keys(contentWhere).length > 0;
  const isStaff = !!visibility.isStaff;
  const include = {
    ...(visibility.isStaff ? REGION_INCLUDE : {}),
    _count: { select: { products: true } },
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
              category: { select: { id: true, title: true, deliveryLeadDays: true, comingSoon: true } },
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
    where: { id, ...buildVisibilityWhere(visibility) },
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
  getAllCategories,
  getCategoryById,
  incrementCategoryProductCount,
  decrementCategoryProductCount,
  mapCategory,
};
