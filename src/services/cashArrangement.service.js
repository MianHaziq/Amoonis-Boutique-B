const prisma = require('../config/db');
const regionService = require('./region.service');
const { isLineTaxable } = require('../utils/vatMath');
const {
  resolveCashArrangementFeeInputs,
  parseCashArrangementFeeSchedule,
  parseCashArrangementAmountList,
} = require('../utils/cashArrangementMath');

/**
 * Cash-arrangement ENABLEMENT service — mirrors vat.service.js's shape exactly (one row per
 * Region, disabled-by-default default shape when absent, SPECIFIC_PRODUCTS/SPECIFIC_CATEGORIES
 * scoping with the same empty-list guard). This service answers "is the 'Add cash arrangement'
 * option offered at all, and what quick-pick amounts/denominations does it show" — it does NOT
 * know or care what the fee costs. The fee VALUE (feeStepAmount/feeMarginPercent) is resolved
 * separately via resolveForOrder() below, which reads Product/Category/ProductRegion/
 * CategoryRegion/ProductZone/CategoryZone — see utils/cashArrangementMath.js for the chain.
 */

const CASH_ARRANGEMENT_APPLIES_TO = Object.freeze(['ALL_PRODUCTS', 'SPECIFIC_PRODUCTS', 'SPECIFIC_CATEGORIES']);

const NOT_ELIGIBLE = Object.freeze({
  eligible: false,
  feeStepAmount: null,
  feeMarginPercent: null,
  governingProductId: null,
  governingCategoryId: null,
  quickPickAmounts: [],
  denominations: [],
});

function mapConfig(row, region = null) {
  if (!row) return null;
  return {
    regionId: row.regionId,
    regionCode: region?.code ?? row.region?.code ?? null,
    regionName: region?.name ?? row.region?.name ?? null,
    enabled: row.enabled,
    appliesTo: row.appliesTo,
    productIds: (row.products || []).map((p) => p.productId),
    categoryIds: (row.categories || []).map((c) => c.categoryId),
    quickPickAmounts: row.quickPickAmounts || [],
    denominations: row.denominations || [],
    feeStepAmount: row.feeStepAmount != null ? Number(row.feeStepAmount) : null,
    feeMarginPercent: row.feeMarginPercent != null ? Number(row.feeMarginPercent) : null,
    updatedAt: row.updatedAt,
  };
}

function defaultConfigShape(regionId, region = null) {
  return {
    regionId,
    regionCode: region?.code ?? null,
    regionName: region?.name ?? null,
    enabled: false,
    appliesTo: 'ALL_PRODUCTS',
    productIds: [],
    categoryIds: [],
    quickPickAmounts: [],
    denominations: [],
    feeStepAmount: null,
    feeMarginPercent: null,
    updatedAt: null,
  };
}

async function assertRegion(regionId) {
  const region = await regionService.getRegionById(regionId);
  if (!region) {
    throw Object.assign(new Error('Region not found'), { code: 'CASH_ARRANGEMENT_REGION_NOT_FOUND', status: 404 });
  }
  return region;
}

async function getConfigRow(regionId) {
  if (!regionId) return null;
  return prisma.cashArrangementConfig.findUnique({
    where: { regionId },
    include: { products: true, categories: true },
  });
}

/** Full config for the admin edit screen. Synthesizes a disabled default when the region has
 *  no row yet — nothing is written until the admin actually saves via updateConfig. */
async function getConfig(regionId) {
  const region = await assertRegion(regionId);
  const row = await getConfigRow(regionId);
  return row ? mapConfig(row, region) : defaultConfigShape(regionId, region);
}

/** Every region with its cash-arrangement config (or a synthesized disabled default). */
async function listConfigs() {
  const regions = await regionService.listRegions({ includeInactive: true });
  if (regions.length === 0) return [];
  const rows = await prisma.cashArrangementConfig.findMany({
    where: { regionId: { in: regions.map((r) => r.id) } },
    include: { products: true, categories: true },
  });
  const byRegionId = new Map(rows.map((r) => [r.regionId, r]));
  return regions.map((region) => {
    const row = byRegionId.get(region.id);
    return row ? mapConfig(row, region) : defaultConfigShape(region.id, region);
  });
}

/** Minimal public view for the request's current region — enablement only, no cart/fee info. */
async function getPublicConfig(regionId) {
  const row = await getConfigRow(regionId);
  if (!row || !row.enabled) {
    return { enabled: false, appliesTo: 'ALL_PRODUCTS', quickPickAmounts: [], denominations: [] };
  }
  return {
    enabled: true,
    appliesTo: row.appliesTo,
    quickPickAmounts: row.quickPickAmounts || [],
    denominations: row.denominations || [],
  };
}

/** Partial update (upsert) of ONE region's enablement config — enabled/appliesTo/scope lists/
 *  quick-pick amounts/denominations only. The fee formula is edited via product/category CRUD. */
async function updateConfig(regionId, input = {}) {
  await assertRegion(regionId);
  const existing = await getConfigRow(regionId);

  const data = {};
  if (input.enabled !== undefined) data.enabled = Boolean(input.enabled);

  let appliesTo;
  if (input.appliesTo !== undefined) {
    appliesTo = String(input.appliesTo).trim().toUpperCase();
    if (!CASH_ARRANGEMENT_APPLIES_TO.includes(appliesTo)) {
      throw Object.assign(
        new Error(`Invalid appliesTo. Use ${CASH_ARRANGEMENT_APPLIES_TO.join(', ')}.`),
        { code: 'CASH_ARRANGEMENT_INVALID_APPLIES_TO', status: 400 }
      );
    }
    data.appliesTo = appliesTo;
  }

  const quickPickAmounts = parseCashArrangementAmountList(input.quickPickAmounts, { fieldName: 'quickPickAmounts' });
  if (quickPickAmounts !== undefined) data.quickPickAmounts = quickPickAmounts;
  const denominations = parseCashArrangementAmountList(input.denominations, { fieldName: 'denominations' });
  if (denominations !== undefined) data.denominations = denominations;

  // Region-wide FLAT fee schedule (both-or-neither, same validator as every other tier).
  // Only touched when EITHER field is present in the payload; sending both as null/'' clears
  // the region flat fee back to "no region-wide fee".
  if (input.feeStepAmount !== undefined || input.feeMarginPercent !== undefined) {
    const fee = parseCashArrangementFeeSchedule({
      feeStepAmount: input.feeStepAmount,
      feeMarginPercent: input.feeMarginPercent,
    });
    data.feeStepAmount = fee.feeStepAmount;
    data.feeMarginPercent = fee.feeMarginPercent;
  }

  const productIds = Array.isArray(input.productIds)
    ? [...new Set(input.productIds.map(String).filter(Boolean))]
    : null;
  const categoryIds = Array.isArray(input.categoryIds)
    ? [...new Set(input.categoryIds.map(String).filter(Boolean))]
    : null;

  // Guard: enabling a SPECIFIC_* scope with an empty target set would offer cash arrangement
  // for nothing — reject it so the admin doesn't silently save a no-op config (mirrors VAT).
  const effectiveAppliesTo = appliesTo ?? existing?.appliesTo ?? 'ALL_PRODUCTS';
  const willBeEnabled = data.enabled !== undefined ? data.enabled : Boolean(existing?.enabled);
  if (willBeEnabled) {
    if (effectiveAppliesTo === 'SPECIFIC_PRODUCTS' && productIds != null && productIds.length === 0) {
      throw Object.assign(new Error('Select at least one product for SPECIFIC_PRODUCTS cash arrangement'), {
        code: 'CASH_ARRANGEMENT_EMPTY_PRODUCTS',
        status: 400,
      });
    }
    if (effectiveAppliesTo === 'SPECIFIC_CATEGORIES' && categoryIds != null && categoryIds.length === 0) {
      throw Object.assign(new Error('Select at least one category for SPECIFIC_CATEGORIES cash arrangement'), {
        code: 'CASH_ARRANGEMENT_EMPTY_CATEGORIES',
        status: 400,
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    const row = await tx.cashArrangementConfig.upsert({
      where: { regionId },
      update: { ...data, updatedAt: new Date() },
      create: { regionId, ...data },
      select: { id: true },
    });

    if (productIds != null) {
      await tx.cashArrangementConfigProduct.deleteMany({ where: { cashArrangementConfigId: row.id } });
      if (productIds.length) {
        await tx.cashArrangementConfigProduct.createMany({
          data: productIds.map((productId) => ({ cashArrangementConfigId: row.id, productId })),
          skipDuplicates: true,
        });
      }
    }
    if (categoryIds != null) {
      await tx.cashArrangementConfigCategory.deleteMany({ where: { cashArrangementConfigId: row.id } });
      if (categoryIds.length) {
        await tx.cashArrangementConfigCategory.createMany({
          data: categoryIds.map((categoryId) => ({ cashArrangementConfigId: row.id, categoryId })),
          skipDuplicates: true,
        });
      }
    }
  });

  return getConfig(regionId);
}

/**
 * Single source of truth for "is cash arrangement offered for THIS cart, and what fee
 * schedule governs it." Called PRE-tx (plain `prisma`, early friendly rejection) and again
 * INSIDE the order transaction (`tx`, server-trusted) — never trust the pre-tx read at
 * commit time, exactly like vatService.resolveConfigForOrder.
 *
 * @param {{regionId: string, zoneId?: string|null, cartLines: Array<{productId: string, categoryId: string|null}>}} args
 *   cartLines MUST be in cart order (not deduped) — the resolver walks them in order and
 *   returns the fee schedule of the FIRST line that both (a) matches the enablement scope and
 *   (b) actually has a resolvable fee schedule. A cart can have an enablement-eligible product
 *   with no fee schedule set anywhere ahead of one that does — skipping past it (not stopping
 *   at the first scope-match) is the only correct behavior; see the loop below.
 * @param {import('@prisma/client').Prisma.TransactionClient} [client]
 */
const NOT_ELIGIBLE_LINE = Object.freeze({
  eligible: false,
  feeStepAmount: null,
  feeMarginPercent: null,
  governingProductId: null,
  governingCategoryId: null,
});

/**
 * PER-LINE resolution — the foundation for per-item cash arrangement. Resolves a fee schedule
 * for EACH cart line independently (a line is eligible if it's in the region's enablement
 * scope AND its own product/category/zone/region fee chain resolves). Returns the effective
 * quick-pick/denomination lists once (region-level, zone override applied) plus a `lines`
 * array aligned by index with the input `cartLines`.
 *
 * @param {{regionId: string, zoneId?: string|null, cartLines: Array<{productId: string, categoryId: string|null}>}} args
 * @returns {Promise<{enabled: boolean, quickPickAmounts: number[], denominations: number[], lines: Array<typeof NOT_ELIGIBLE_LINE>}>}
 */
async function resolveForLines({ regionId, zoneId = null, cartLines = [] }, client = prisma) {
  const notEligibleAll = (enabled, quickPickAmounts = [], denominations = []) => ({
    enabled,
    quickPickAmounts,
    denominations,
    lines: cartLines.map(() => ({ ...NOT_ELIGIBLE_LINE })),
  });

  if (!regionId || cartLines.length === 0) return notEligibleAll(false);

  const configRow = await client.cashArrangementConfig.findUnique({
    where: { regionId },
    include: { products: { select: { productId: true } }, categories: { select: { categoryId: true } } },
  });
  if (!configRow || !configRow.enabled) return notEligibleAll(false);

  const scope = {
    appliesTo: configRow.appliesTo,
    productIds: new Set(configRow.products.map((p) => p.productId)),
    categoryIds: new Set(configRow.categories.map((c) => c.categoryId)),
  };
  const inScope = cartLines.map((l) => isLineTaxable(scope, l));
  if (!inScope.some(Boolean)) {
    return notEligibleAll(true, configRow.quickPickAmounts || [], configRow.denominations || []);
  }

  const scopedLines = cartLines.filter((_, i) => inScope[i]);
  const productIds = [...new Set(scopedLines.map((l) => l.productId))];
  const categoryIds = [...new Set(scopedLines.map((l) => l.categoryId).filter(Boolean))];

  const feeCols = { cashArrangementFeeStepAmount: true, cashArrangementFeeMarginPercent: true };
  const [products, categories, prRows, crRows, pzRows, czRows, zoneRow] = await Promise.all([
    client.product.findMany({ where: { id: { in: productIds } }, select: { id: true, categoryId: true, ...feeCols } }),
    categoryIds.length
      ? client.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, ...feeCols } })
      : [],
    client.productRegion.findMany({ where: { regionId, productId: { in: productIds } }, select: { productId: true, ...feeCols } }),
    categoryIds.length
      ? client.categoryRegion.findMany({ where: { regionId, categoryId: { in: categoryIds } }, select: { categoryId: true, ...feeCols } })
      : [],
    zoneId
      ? client.productZone.findMany({ where: { zoneId, productId: { in: productIds } }, select: { productId: true, ...feeCols } })
      : [],
    zoneId && categoryIds.length
      ? client.categoryZone.findMany({ where: { zoneId, categoryId: { in: categoryIds } }, select: { categoryId: true, ...feeCols } })
      : [],
    zoneId
      ? client.deliveryZone.findUnique({
          where: { id: zoneId },
          select: {
            cashArrangementQuickPickAmounts: true,
            cashArrangementDenominations: true,
            cashArrangementFeeStepAmount: true,
            cashArrangementFeeMarginPercent: true,
          },
        })
      : null,
  ]);

  const effectiveQuickPickAmounts =
    zoneRow?.cashArrangementQuickPickAmounts?.length ? zoneRow.cashArrangementQuickPickAmounts : (configRow.quickPickAmounts || []);
  const effectiveDenominations =
    zoneRow?.cashArrangementDenominations?.length ? zoneRow.cashArrangementDenominations : (configRow.denominations || []);

  const byId = (rows, key) => new Map(rows.map((r) => [r[key], r]));
  const productById = byId(products, 'id');
  const categoryById = byId(categories, 'id');
  const prByProduct = byId(prRows, 'productId');
  const crByCategory = byId(crRows, 'categoryId');
  const pzByProduct = byId(pzRows, 'productId');
  const czByCategory = byId(czRows, 'categoryId');

  const toFeePair = (row) =>
    row ? { feeStepAmount: row.cashArrangementFeeStepAmount, feeMarginPercent: row.cashArrangementFeeMarginPercent } : null;

  // Flat base tiers — SAME for every line. zoneFlat beats regionFlat; both below all tiers.
  const zoneFlat = toFeePair(zoneRow);
  const regionFlat =
    configRow.feeStepAmount != null && configRow.feeMarginPercent != null
      ? { feeStepAmount: configRow.feeStepAmount, feeMarginPercent: configRow.feeMarginPercent }
      : null;

  const lines = cartLines.map((line, i) => {
    if (!inScope[i]) return { ...NOT_ELIGIBLE_LINE };
    const categoryId = line.categoryId ?? productById.get(line.productId)?.categoryId ?? null;
    const resolved = resolveCashArrangementFeeInputs({
      productZone: toFeePair(pzByProduct.get(line.productId)),
      productRegion: toFeePair(prByProduct.get(line.productId)),
      product: toFeePair(productById.get(line.productId)),
      categoryZone: categoryId ? toFeePair(czByCategory.get(categoryId)) : null,
      categoryRegion: categoryId ? toFeePair(crByCategory.get(categoryId)) : null,
      category: categoryId ? toFeePair(categoryById.get(categoryId)) : null,
      zoneFlat,
      regionFlat,
    });
    if (!resolved) return { ...NOT_ELIGIBLE_LINE };
    return {
      eligible: true,
      feeStepAmount: resolved.feeStepAmount,
      feeMarginPercent: resolved.feeMarginPercent,
      governingProductId: line.productId,
      governingCategoryId: categoryId,
    };
  });

  return { enabled: true, quickPickAmounts: effectiveQuickPickAmounts, denominations: effectiveDenominations, lines };
}

/**
 * Single-result resolve (the /resolve endpoint + single-product PDP preview): returns the fee
 * schedule of the FIRST eligible+resolvable line in the cart, plus the effective lists.
 * Backed by resolveForLines. Called PRE-tx (plain `prisma`) and INSIDE the tx (`tx`).
 */
async function resolveForOrder(args, client = prisma) {
  const result = await resolveForLines(args, client);
  const line = result.lines.find((l) => l.eligible);
  if (!line) return NOT_ELIGIBLE;
  return {
    eligible: true,
    feeStepAmount: line.feeStepAmount,
    feeMarginPercent: line.feeMarginPercent,
    governingProductId: line.governingProductId,
    governingCategoryId: line.governingCategoryId,
    quickPickAmounts: result.quickPickAmounts,
    denominations: result.denominations,
  };
}

module.exports = {
  CASH_ARRANGEMENT_APPLIES_TO,
  parseCashArrangementFeeSchedule,
  getConfig,
  listConfigs,
  getPublicConfig,
  updateConfig,
  resolveForOrder,
  resolveForLines,
  mapConfig,
};
