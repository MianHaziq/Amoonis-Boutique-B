const prisma = require('../config/db');
const regionService = require('./region.service');
const { round2, isLineTaxable, allocateDiscount, computeOrderVat } = require('../utils/vatMath');

/**
 * VAT / tax service.
 *
 * VAT is configured PER REGION (one VatConfig row per Region — UAE 5%, KSA 15%, ...): a rate,
 * an `inclusive` flag, and a scope (ALL_PRODUCTS / SPECIFIC_CATEGORIES / SPECIFIC_PRODUCTS). A
 * region with no row is treated as VAT-disabled — nothing is persisted just by reading it.
 *
 *   • EXCLUSIVE (inclusive = false): VAT is ADDED on top of the discounted line price at
 *     checkout, so it increases the order total.
 *   • INCLUSIVE (inclusive = true): the catalogue price ALREADY contains the VAT, so nothing
 *     is added — we only EXTRACT the tax portion for reporting; the order total is unchanged.
 *
 * The pricing math lives in ../utils/vatMath (pure, no DB) so it can be unit tested directly
 * (see scripts/vat-verify.js). This service adds DB-backed, per-region config resolution + CRUD.
 */

const VAT_APPLIES_TO = Object.freeze(['ALL_PRODUCTS', 'SPECIFIC_PRODUCTS', 'SPECIFIC_CATEGORIES']);

function decimalToNumber(v) {
  return v == null ? null : Number(v);
}

// ---------------------------------------------------------------------------
// DB-backed config resolution + CRUD (per region)
// ---------------------------------------------------------------------------

/** Shape a VatConfig row (with joins) for API responses. */
function mapVatConfig(row, region = null) {
  if (!row) return null;
  return {
    regionId: row.regionId,
    regionCode: region?.code ?? row.region?.code ?? null,
    regionName: region?.name ?? row.region?.name ?? null,
    enabled: row.enabled,
    ratePercent: decimalToNumber(row.ratePercent) ?? 0,
    inclusive: row.inclusive,
    appliesTo: row.appliesTo,
    productIds: (row.products || []).map((p) => p.productId),
    categoryIds: (row.categories || []).map((c) => c.categoryId),
    updatedAt: row.updatedAt,
  };
}

/** Unsaved, disabled default shape for a region that has no VatConfig row yet. */
function defaultConfigShape(regionId, region = null) {
  return {
    regionId,
    regionCode: region?.code ?? null,
    regionName: region?.name ?? null,
    enabled: false,
    ratePercent: 0,
    inclusive: false,
    appliesTo: 'ALL_PRODUCTS',
    productIds: [],
    categoryIds: [],
    updatedAt: null,
  };
}

async function assertRegion(regionId) {
  const region = await regionService.getRegionById(regionId);
  if (!region) {
    throw Object.assign(new Error('Region not found'), { code: 'VAT_REGION_NOT_FOUND', status: 404 });
  }
  return region;
}

/** Read-only lookup of the config row for a region (with scope joins). Null if none exists. */
async function getConfigRow(regionId) {
  if (!regionId) return null;
  return prisma.vatConfig.findUnique({
    where: { regionId },
    include: { products: true, categories: true },
  });
}

/**
 * Full config for the admin edit screen. Synthesizes a disabled default when the region has no
 * row yet — nothing is written until the admin actually saves via updateConfig.
 */
async function getConfig(regionId) {
  const region = await assertRegion(regionId);
  const row = await getConfigRow(regionId);
  return row ? mapVatConfig(row, region) : defaultConfigShape(regionId, region);
}

/**
 * Every region with its VAT config (or a synthesized disabled default) — powers the admin's
 * region picker / overview list in one call.
 */
async function listConfigs() {
  const regions = await regionService.listRegions({ includeInactive: true });
  if (regions.length === 0) return [];
  const rows = await prisma.vatConfig.findMany({
    where: { regionId: { in: regions.map((r) => r.id) } },
    include: { products: true, categories: true },
  });
  const byRegionId = new Map(rows.map((r) => [r.regionId, r]));
  return regions.map((region) => {
    const row = byRegionId.get(region.id);
    return row ? mapVatConfig(row, region) : defaultConfigShape(region.id, region);
  });
}

/**
 * Minimal public view (safe for the storefront) for the request's CURRENT region: rate +
 * inclusive + scope, no id lists. Resolved from X-Region via the `resolveRegion` middleware.
 */
async function getPublicConfig(regionId) {
  const row = await getConfigRow(regionId);
  if (!row) return { enabled: false, ratePercent: 0, inclusive: false, appliesTo: 'ALL_PRODUCTS' };
  return {
    enabled: row.enabled,
    ratePercent: decimalToNumber(row.ratePercent) ?? 0,
    inclusive: row.inclusive,
    appliesTo: row.appliesTo,
  };
}

/**
 * A compact, resolved config for the order pipeline, scoped to the order's region. Returns null
 * when the region has no VAT row, VAT is disabled, or the rate is 0 (caller applies no VAT).
 * @param {string|null} regionId the order's region
 * @param {import('@prisma/client').Prisma.TransactionClient} [client] optional tx client
 */
async function resolveConfigForOrder(regionId, client = prisma) {
  if (!regionId) return null;
  const row = await client.vatConfig.findUnique({
    where: { regionId },
    include: {
      products: { select: { productId: true } },
      categories: { select: { categoryId: true } },
    },
  });
  if (!row || !row.enabled) return null;
  const rate = decimalToNumber(row.ratePercent) ?? 0;
  if (rate <= 0) return null;
  return {
    enabled: true,
    ratePercent: rate,
    inclusive: row.inclusive,
    appliesTo: row.appliesTo,
    productIds: row.products.map((p) => p.productId),
    categoryIds: row.categories.map((c) => c.categoryId),
  };
}

function parseRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw Object.assign(new Error('ratePercent must be a number between 0 and 100'), {
      code: 'VAT_INVALID_RATE',
      status: 400,
    });
  }
  return round2(n);
}

/**
 * Update (upsert) the VAT config for ONE region. Partial: only provided fields change. When
 * appliesTo is SPECIFIC_*, the corresponding id list (if provided) replaces the scope join rows.
 */
async function updateConfig(regionId, input = {}) {
  await assertRegion(regionId);
  const existing = await getConfigRow(regionId);

  const data = {};
  if (input.enabled !== undefined) data.enabled = Boolean(input.enabled);
  if (input.inclusive !== undefined) data.inclusive = Boolean(input.inclusive);
  if (input.ratePercent !== undefined) data.ratePercent = parseRate(input.ratePercent);

  let appliesTo;
  if (input.appliesTo !== undefined) {
    appliesTo = String(input.appliesTo).trim().toUpperCase();
    if (!VAT_APPLIES_TO.includes(appliesTo)) {
      throw Object.assign(
        new Error(`Invalid appliesTo. Use ${VAT_APPLIES_TO.join(', ')}.`),
        { code: 'VAT_INVALID_APPLIES_TO', status: 400 }
      );
    }
    data.appliesTo = appliesTo;
  }

  const productIds = Array.isArray(input.productIds)
    ? [...new Set(input.productIds.map(String).filter(Boolean))]
    : null;
  const categoryIds = Array.isArray(input.categoryIds)
    ? [...new Set(input.categoryIds.map(String).filter(Boolean))]
    : null;

  // Guard: enabling a SPECIFIC_* scope with an empty target set would tax nothing — reject
  // it so the admin doesn't silently save a no-op VAT.
  const effectiveAppliesTo = appliesTo ?? existing?.appliesTo ?? 'ALL_PRODUCTS';
  const willBeEnabled = data.enabled !== undefined ? data.enabled : Boolean(existing?.enabled);
  if (willBeEnabled) {
    if (effectiveAppliesTo === 'SPECIFIC_PRODUCTS' && productIds != null && productIds.length === 0) {
      throw Object.assign(new Error('Select at least one product for SPECIFIC_PRODUCTS VAT'), {
        code: 'VAT_EMPTY_PRODUCTS',
        status: 400,
      });
    }
    if (effectiveAppliesTo === 'SPECIFIC_CATEGORIES' && categoryIds != null && categoryIds.length === 0) {
      throw Object.assign(new Error('Select at least one category for SPECIFIC_CATEGORIES VAT'), {
        code: 'VAT_EMPTY_CATEGORIES',
        status: 400,
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    const row = await tx.vatConfig.upsert({
      where: { regionId },
      update: { ...data, updatedAt: new Date() },
      create: { regionId, ...data },
      select: { id: true },
    });

    if (productIds != null) {
      await tx.vatConfigProduct.deleteMany({ where: { vatConfigId: row.id } });
      if (productIds.length) {
        await tx.vatConfigProduct.createMany({
          data: productIds.map((productId) => ({ vatConfigId: row.id, productId })),
          skipDuplicates: true,
        });
      }
    }
    if (categoryIds != null) {
      await tx.vatConfigCategory.deleteMany({ where: { vatConfigId: row.id } });
      if (categoryIds.length) {
        await tx.vatConfigCategory.createMany({
          data: categoryIds.map((categoryId) => ({ vatConfigId: row.id, categoryId })),
          skipDuplicates: true,
        });
      }
    }
  });

  return getConfig(regionId);
}

module.exports = {
  VAT_APPLIES_TO,
  // pure math
  round2,
  allocateDiscount,
  isLineTaxable,
  computeOrderVat,
  // db
  getConfig,
  listConfigs,
  getPublicConfig,
  resolveConfigForOrder,
  updateConfig,
  mapVatConfig,
};
