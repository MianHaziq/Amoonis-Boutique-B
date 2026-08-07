const { Prisma } = require('@prisma/client');
const prisma = require('../config/db');
const { autoTranslate, autoTranslateMany, fillBilingualGapsFromTwin } = require('../utils/bilingual');
const regionService = require('./region.service');
const { buildVisibilityWhere, buildCategoryVisibilityWhere } = require('../utils/regionVisibility');
const {
  parseDeliveryLeadDays,
  resolveDeliveryLeadDays,
  getDefaultDeliveryLeadDays,
} = require('../utils/deliveryLeadDays');
const { parseCashArrangementFeeSchedule } = require('../utils/cashArrangementMath');
const { normalizeGiftCardMode } = require('../utils/giftCardMode');

// Standard include for region join rows on a product read (staff/admin only).
const REGION_INCLUDE = {
  regions: { include: { region: { select: { id: true, code: true, name: true, name_ar: true } } } },
  // Per-zone prep-lead + cash-arrangement fee overrides — surfaced to the admin edit form
  // so it can show/edit every zone's overrides at once (mirrors regionPrices). Storefront
  // reads don't include this.
  zoneLeadDays: {
    select: {
      zoneId: true,
      deliveryLeadDays: true,
      cashArrangementFeeStepAmount: true,
      cashArrangementFeeMarginPercent: true,
    },
  },
};

/**
 * Clean a `zoneLeadDays: [{ zoneId, deliveryLeadDays, cashArrangementFeeStepAmount,
 * cashArrangementFeeMarginPercent }]` payload into ProductZone/CategoryZone create rows,
 * keeping only entries with a real override (a non-null lead OR a cash-arrangement fee
 * schedule) — a zone entry that sets only the fee schedule (no lead override) still needs
 * a row, so this is NOT gated on `deliveryLeadDays` alone. Uses the same 0-30 validator as
 * the global/region lead, and parseCashArrangementFeeSchedule for the fee pair (both-or-
 * neither). Returns [] for empty input.
 */
function buildZoneLeadRows(zoneLeadDays) {
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
    if (lead == null && feeSchedule.feeStepAmount == null) continue; // no override at all; don't store a row
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

const PRODUCT_BILINGUAL = [
  { src: 'title', dst: 'title_ar' },
  { src: 'subtitle', dst: 'subtitle_ar' },
];
const PRODUCT_DESCRIPTION_BILINGUAL = [
  { src: 'title', dst: 'title_ar' },
  { src: 'description', dst: 'description_ar' },
];
const PRODUCT_OPTION_BILINGUAL = [
  { src: 'title', dst: 'title_ar' },
  { src: 'options', dst: 'options_ar', kind: 'arrayOfString' },
];
const PRODUCT_VARIANT_BILINGUAL = [
  { src: 'optionValue', dst: 'optionValue_ar' },
  { src: 'subtitle', dst: 'subtitle_ar' },
];
const PRODUCT_VARIANT_COLOR_BILINGUAL = [{ src: 'label', dst: 'label_ar' }];

// NOT NULL constraints in the schema — must be filled at write time.
const PRODUCT_REQUIRED_PAIRS = [{ src: 'title', dst: 'title_ar' }];
const PRODUCT_DESCRIPTION_REQUIRED_PAIRS = [{ src: 'description', dst: 'description_ar' }];
const PRODUCT_OPTION_REQUIRED_PAIRS = [{ src: 'title', dst: 'title_ar' }];
const PRODUCT_VARIANT_REQUIRED_PAIRS = [{ src: 'optionValue', dst: 'optionValue_ar' }];
const PRODUCT_VARIANT_COLOR_REQUIRED_PAIRS = [{ src: 'label', dst: 'label_ar' }];

const MAX_IMAGES = 10;
const ACTIVE_ORDER_STATUSES = ['PENDING_PAYMENT', 'PROCESSING', 'ON_HOLD'];
const decimalToNumber = (v) => (v == null ? null : Number(v));

function orderedImages(product) {
  const list = product.images && Array.isArray(product.images)
    ? [...product.images].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    : [];
  return list.map((img) => ({ url: img.url, sortOrder: img.sortOrder }));
}

// Takes a raw ProductDescription[] (either product.descriptions or a single
// variant's own .descriptions — same row shape either way) and returns the
// ordered display list. Shared by orderedVariants below for the per-variant blocks.
function orderedDescriptions(list) {
  const sorted = Array.isArray(list)
    ? [...list].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    : [];
  return sorted.map((d) => ({
    id: d.id,
    title: d.title ?? null,
    title_ar: d.title_ar ?? null,
    description: d.description,
    description_ar: d.description_ar ?? null,
  }));
}

function orderedProductOptions(product) {
  const list = product.productOptions && Array.isArray(product.productOptions)
    ? [...product.productOptions].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    : [];
  return list.map((o) => ({
    id: o.id,
    title: o.title,
    title_ar: o.title_ar ?? null,
    options: Array.isArray(o.options) ? o.options : [],
    options_ar: Array.isArray(o.options_ar) ? o.options_ar : [],
    // Additive: per-value image URLs (aligned with `options`). Older clients
    // that don't read this field are unaffected.
    optionImages: Array.isArray(o.optionImages) ? o.optionImages : [],
    // Additive: per-value swatch colours (hex), aligned with `options`.
    optionColors: Array.isArray(o.optionColors) ? o.optionColors : [],
    // Additive: per-value image SETS (array-of-arrays), aligned with `options`.
    // Null/absent when unused; consumers fall back to single `optionImages`.
    optionImageSets: Array.isArray(o.optionImageSets) ? o.optionImageSets : [],
    // Marks this the group whose values drive Product.variants (price/photos/subtitle).
    isVariantAxis: !!o.isVariantAxis,
  }));
}

// This variant's own colour choices (e.g. Large offers Pink/Blue/Red while Medium
// only offers Blue/Black) — completely independent per variant, unlike the shared
// ProductOption groups. Purely cosmetic: never affects price/stock.
function orderedVariantColors(variant) {
  const list = variant.colors && Array.isArray(variant.colors)
    ? [...variant.colors].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    : [];
  return list.map((c) => ({
    id: c.id,
    label: c.label,
    label_ar: c.label_ar ?? null,
    images: Array.isArray(c.images) ? c.images : [],
    isDefault: !!c.isDefault,
  }));
}

function orderedVariants(product) {
  const list = product.variants && Array.isArray(product.variants)
    ? [...product.variants].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    : [];
  return list.map((v) => ({
    id: v.id,
    optionValue: v.optionValue,
    optionValue_ar: v.optionValue_ar ?? null,
    price: decimalToNumber(v.price),
    discountedPrice: decimalToNumber(v.discountedPrice),
    images: Array.isArray(v.images) ? v.images : [],
    subtitle: v.subtitle ?? null,
    subtitle_ar: v.subtitle_ar ?? null,
    isDefault: !!v.isDefault,
    sortOrder: v.sortOrder,
    // This variant's own description blocks. Empty = it has none of its own and
    // shares the product's top-level `descriptions` instead — storefront picks
    // whichever list is non-empty for the selected variant (variant own > shared).
    descriptions: orderedDescriptions(v.descriptions),
    // This variant's own colour choices. Empty = this size offers no colour picker
    // at all (most products) — see ProductVariantColor.
    colors: orderedVariantColors(v),
  }));
}

/**
 * "From X to Y" price span across a product's variants (using each variant's own
 * discounted price when it's actually lower, same rule as effective-price elsewhere).
 * Null when the product has no variants — callers fall back to the plain price.
 */
function variantPriceRange(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const v of variants) {
    const price = decimalToNumber(v.price);
    const discountedPrice = decimalToNumber(v.discountedPrice);
    const effective = discountedPrice != null && discountedPrice < price ? discountedPrice : price;
    if (effective < min) min = effective;
    if (effective > max) max = effective;
  }
  return { min, max };
}

function mapProduct(product) {
  if (!product) return null;
  const {
    price,
    discountedPrice,
    giftCardExtraPrice,
    customNamePrice,
    cashArrangementFeeStepAmount,
    cashArrangementFeeMarginPercent,
    images,
    descriptions,
    productOptions,
    variants,
    regions,
    zoneLeadDays,
    ...rest
  } = product;
  const imagesList = orderedImages(product);
  // product.descriptions (the Product -> ProductDescription relation) carries EVERY
  // description row for this product, shared AND variant-scoped alike, since both kinds
  // share the same productId — filter down to the shared ones (variantId: null) here.
  // A variant's own rows are surfaced separately, via orderedVariants -> v.descriptions.
  const sharedDescriptionRows = Array.isArray(product.descriptions)
    ? product.descriptions.filter((d) => d.variantId == null)
    : product.descriptions;
  const descriptionsList = orderedDescriptions(sharedDescriptionRows);
  const productOptionsList = orderedProductOptions(product);
  const variantsList = orderedVariants(product);
  const out = {
    ...rest,
    price: decimalToNumber(price),
    discountedPrice: decimalToNumber(discountedPrice),
    giftCardExtraPrice: decimalToNumber(giftCardExtraPrice),
    customNamePrice: decimalToNumber(customNamePrice),
    cashArrangementFeeStepAmount: decimalToNumber(cashArrangementFeeStepAmount),
    cashArrangementFeeMarginPercent: decimalToNumber(cashArrangementFeeMarginPercent),
    images: imagesList.map((i) => i.url),
    image: imagesList[0]?.url ?? null,
    descriptions: descriptionsList,
    productOptions: productOptionsList,
    // Additive: Small/Medium/Large-style variants, each with its own price/photos/
    // subtitle. Empty array for every product that doesn't use this (the vast
    // majority) — older clients (mobile) never read this and keep using the plain
    // price/discountedPrice above, which mirror the default variant when one exists.
    variants: variantsList,
    // "From X to Y" span across variants, for the storefront/admin "From AED 25"
    // display. Null when the product has no variants.
    priceRange: Array.isArray(variants) ? variantPriceRange(variants) : null,
  };
  // `regions` has two possible shapes depending on the caller:
  //  - Staff/admin reads (REGION_INCLUDE): each row carries a nested `region` object —
  //    the full region tag list plus, additively, this product's per-region price
  //    overrides (`regionPrices`) so the edit form can show/edit every region at once.
  //  - Storefront reads: 0-1 row, scoped to the requesting region, with only
  //    price/discountedPrice (no nested `region`) — stashed on an internal key for
  //    applyRegionCurrency to overlay and strip. Storefront responses never expose
  //    `regions`/`regionIds` — the app already filtered by region and doesn't need tags.
  if (Array.isArray(regions)) {
    const hasRegionTags = regions.some((r) => r.region);
    if (hasRegionTags) {
      const regionList = regions.map((r) => r.region).filter(Boolean);
      out.regions = regionList;
      out.regionIds = regionList.map((r) => r.id);
      out.regionPrices = regions.map((r) => ({
        regionId: r.regionId,
        price: decimalToNumber(r.price),
        discountedPrice: decimalToNumber(r.discountedPrice),
        deliveryLeadDays: r.deliveryLeadDays ?? null,
        cashArrangementFeeStepAmount: decimalToNumber(r.cashArrangementFeeStepAmount),
        cashArrangementFeeMarginPercent: decimalToNumber(r.cashArrangementFeeMarginPercent),
      }));
    } else {
      out._regionPriceRow = regions[0]
        ? { price: decimalToNumber(regions[0].price), discountedPrice: decimalToNumber(regions[0].discountedPrice) }
        : null;
    }
  }
  // Per-zone prep-lead + cash-arrangement fee overrides (staff/admin reads only, via
  // REGION_INCLUDE) — decimal fields need explicit conversion since they're no longer
  // passed through the raw `...rest` spread above.
  if (Array.isArray(zoneLeadDays)) {
    out.zoneLeadDays = zoneLeadDays.map((z) => ({
      zoneId: z.zoneId,
      deliveryLeadDays: z.deliveryLeadDays ?? null,
      cashArrangementFeeStepAmount: decimalToNumber(z.cashArrangementFeeStepAmount),
      cashArrangementFeeMarginPercent: decimalToNumber(z.cashArrangementFeeMarginPercent),
    }));
  }
  return out;
}

/**
 * Overlay the requesting region's price override (if any) onto an already-mapped
 * product for STOREFRONT reads: `price`/`discountedPrice` become the region's override
 * (falling back to the base AED value when no override is set for that region), so the
 * frontend reads the same field names regardless of region — no currency-branching
 * needed client-side. Relies on `mapped._regionPriceRow`, set by mapProduct from a
 * region-scoped ProductRegion include (see REGION_PRICE_INCLUDE below).
 * Staff/admin reads should NOT call this — they get the raw base price + regionPrices
 * array so the edit form can show/edit every region's override at once.
 */
function applyRegionCurrency(mapped) {
  if (!mapped) return mapped;
  const override = mapped._regionPriceRow;
  const { _regionPriceRow, ...clean } = mapped;
  if (!override) return clean;
  return {
    ...clean,
    price: override.price != null ? override.price : clean.price,
    discountedPrice: override.discountedPrice != null ? override.discountedPrice : clean.discountedPrice,
  };
}

// Storefront (non-staff) include: the requesting region's own price-override row only —
// no nested region tag, distinguishing it from REGION_INCLUDE in mapProduct above.
function regionPriceInclude(regionId) {
  return regionId
    ? { regions: { where: { regionId }, select: { regionId: true, price: true, discountedPrice: true } } }
    : {};
}

/**
 * Batches a single groupBy aggregate query for however many mapped products are
 * passed in, then merges `avgRating`/`reviewCount` onto each — one round trip per
 * page/list, never per-row. Products with no reviews get avgRating: null,
 * reviewCount: 0. Mutates and returns the same array for convenience.
 *
 * Defensive: falls back to null/0 (rather than throwing) if the Review table/
 * client isn't available yet — e.g. this code has shipped but the reviews
 * migration hasn't been deployed to this particular environment yet. Product
 * reads must never break because of that rollout ordering.
 */
async function attachRatingAggregates(mappedProducts) {
  const ids = mappedProducts.map((p) => p.id).filter(Boolean);
  if (ids.length === 0) return mappedProducts;

  let byProductId = new Map();
  try {
    const groups = await prisma.review.groupBy({
      by: ['productId'],
      where: { productId: { in: ids } },
      _avg: { rating: true },
      _count: { _all: true },
    });
    byProductId = new Map(
      groups.map((g) => [g.productId, { avgRating: Number(g._avg.rating.toFixed(2)), reviewCount: g._count._all }])
    );
  } catch (err) {
    console.error('[reviews] rating aggregate unavailable, defaulting to null/0:', err.message);
  }

  for (const p of mappedProducts) {
    const agg = byProductId.get(p.id);
    p.avgRating = agg?.avgRating ?? null;
    p.reviewCount = agg?.reviewCount ?? 0;
  }
  return mappedProducts;
}

/**
 * Attaches `resolvedDeliveryLeadDays` (always a number, never null) to each already-mapped
 * product — the product's own deliveryLeadDays override, falling back to its category's
 * override, falling back to the global Settings.defaultDeliveryLeadDays. The raw (possibly
 * null) `deliveryLeadDays` override stays on the product/category as-is (admin edit forms
 * rely on it to distinguish "no override" from "explicitly set"); this only ADDS the
 * resolved number for the storefront.
 *
 * Fetches Settings once per call (cached briefly by getDefaultDeliveryLeadDays — see
 * utils/deliveryLeadDays.js), not once per product, so a page of 100 products costs at
 * most one Settings round trip, not 100.
 */
async function attachResolvedDeliveryLeadDays(mappedProducts, regionId = null, zoneId = null) {
  const defaultLeadDays = await getDefaultDeliveryLeadDays();
  if (!Array.isArray(mappedProducts) || mappedProducts.length === 0) return mappedProducts;

  // Per-region + per-zone overrides (only for a storefront/region-scoped read — admin
  // passes null and gets the raw product/category chain). One batch query per tier for
  // the whole page. Products/categories with no override aren't in the maps → the chain
  // falls through to the area's standard, then the global default.
  let productRegionLead = new Map();
  let categoryRegionLead = new Map();
  let productZoneLead = new Map();
  let categoryZoneLead = new Map();
  let zoneStandard = null;
  let regionStandard = null;

  if (regionId) {
    const productIds = [...new Set(mappedProducts.map((p) => p.id).filter(Boolean))];
    const categoryIds = [
      ...new Set(mappedProducts.map((p) => p.category?.id ?? p.categoryId).filter(Boolean)),
    ];
    // Region tier + the region's standard delivery days (the area default before global).
    const [prRows, crRows, region] = await Promise.all([
      productIds.length
        ? prisma.productRegion.findMany({
            where: { regionId, productId: { in: productIds }, deliveryLeadDays: { not: null } },
            select: { productId: true, deliveryLeadDays: true },
          })
        : [],
      categoryIds.length
        ? prisma.categoryRegion.findMany({
            where: { regionId, categoryId: { in: categoryIds }, deliveryLeadDays: { not: null } },
            select: { categoryId: true, deliveryLeadDays: true },
          })
        : [],
      regionService.getRegionById(regionId), // cached — avoids a DB hit per product page
    ]);
    productRegionLead = new Map(prRows.map((r) => [r.productId, r.deliveryLeadDays]));
    categoryRegionLead = new Map(crRows.map((r) => [r.categoryId, r.deliveryLeadDays]));
    regionStandard = region?.standardDeliveryDays ?? null;

    // Zone tier + the zone's standard lead — highest-priority location tiers. The zone must
    // belong to the requesting region (guards a stale/tampered id).
    if (zoneId) {
      const [pzRows, czRows, zone] = await Promise.all([
        productIds.length
          ? prisma.productZone.findMany({
              where: { zoneId, productId: { in: productIds }, deliveryLeadDays: { not: null } },
              select: { productId: true, deliveryLeadDays: true },
            })
          : [],
        categoryIds.length
          ? prisma.categoryZone.findMany({
              where: { zoneId, categoryId: { in: categoryIds }, deliveryLeadDays: { not: null } },
              select: { categoryId: true, deliveryLeadDays: true },
            })
          : [],
        prisma.deliveryZone.findFirst({
          where: { id: zoneId, regionId, isActive: true },
          select: { standardLeadDays: true },
        }),
      ]);
      // Only apply ANY zone tier (product/category override OR standard) when the zone is a
      // real, active zone of THIS region — a stale/tampered zoneId from another region must
      // not leak its overrides. Otherwise fall through to region-level resolution.
      if (zone) {
        productZoneLead = new Map(pzRows.map((r) => [r.productId, r.deliveryLeadDays]));
        categoryZoneLead = new Map(czRows.map((r) => [r.categoryId, r.deliveryLeadDays]));
        zoneStandard = zone.standardLeadDays ?? null;
      }
    }
  }

  for (const p of mappedProducts) {
    const catId = p.category?.id ?? p.categoryId ?? null;
    p.resolvedDeliveryLeadDays = resolveDeliveryLeadDays({
      productZoneLeadDays: productZoneLead.get(p.id) ?? null,
      productRegionLeadDays: productRegionLead.get(p.id) ?? null,
      productLeadDays: p.deliveryLeadDays,
      categoryZoneLeadDays: catId ? categoryZoneLead.get(catId) ?? null : null,
      categoryRegionLeadDays: catId ? categoryRegionLead.get(catId) ?? null : null,
      categoryLeadDays: p.category?.deliveryLeadDays ?? null,
      zoneStandardLeadDays: zoneStandard,
      regionStandardLeadDays: regionStandard,
      defaultLeadDays,
    });
  }
  return mappedProducts;
}

/**
 * Same resolution as applyRegionCurrency, but works directly on a raw Prisma product
 * row (Decimal fields) instead of an already-mapped product — used where only the
 * numeric price is needed (order totals, cart line totals), not the full product shape.
 * `row.regions` must be pre-scoped to the requesting region (0-1 row) by the caller's
 * query, e.g. `regions: { where: { regionId }, select: { price, discountedPrice } }`.
 */
function regionPriceFromRow(row) {
  const price = decimalToNumber(row.price) ?? 0;
  const discountedPrice = decimalToNumber(row.discountedPrice);
  const override = Array.isArray(row.regions) ? row.regions[0] : null;
  if (!override) return { price, discountedPrice };
  const overridePrice = decimalToNumber(override.price);
  const overrideDiscountedPrice = decimalToNumber(override.discountedPrice);
  return {
    price: overridePrice != null ? overridePrice : price,
    discountedPrice: overrideDiscountedPrice != null ? overrideDiscountedPrice : discountedPrice,
  };
}

// Extra charge for a cart/order line's gift-card + custom-name selections. Only
// counts a selection if the PRODUCT actually has that option enabled — a client
// sending giftCardSelected/customName for a product that doesn't offer it is
// silently worth 0, never charged. Shared by cart.service and order.service so
// the enabled-AND-selected guard lives in exactly one place.
function optionExtraCharge(productRow, { giftCardSelected, customName } = {}) {
  let extra = 0;
  if (giftCardSelected && productRow.giftCardEnabled) {
    extra += decimalToNumber(productRow.giftCardExtraPrice) ?? 0;
  }
  if (customName && productRow.customNameEnabled) {
    extra += decimalToNumber(productRow.customNamePrice) ?? 0;
  }
  return extra;
}

function normalizeDescriptions(descriptions) {
  if (!Array.isArray(descriptions)) return [];
  return descriptions
    .map((d, i) => {
      if (d == null || typeof d !== 'object') return null;
      const descEn = d.description != null ? String(d.description).trim() : '';
      const descAr = d.description_ar != null ? String(d.description_ar).trim() : '';
      // At least one side of description must be filled (validator enforces this too,
      // but double-check here so the service is safe when called from non-HTTP paths).
      if (!descEn && !descAr) return null;
      return {
        title: d.title != null ? String(d.title).trim() || null : null,
        title_ar: d.title_ar != null ? String(d.title_ar).trim() || null : null,
        description: descEn || null,
        description_ar: descAr || null,
        sortOrder: i,
      };
    })
    .filter(Boolean);
}

function normalizeProductOptions(productOptions) {
  if (!Array.isArray(productOptions)) return [];
  return productOptions
    .map((item, i) => {
      if (item == null || typeof item !== 'object') return null;
      const titleEn = item.title != null ? String(item.title).trim() : '';
      const titleAr = item.title_ar != null ? String(item.title_ar).trim() : '';
      // At least one side of title must be filled.
      if (!titleEn && !titleAr) return null;
      const options = Array.isArray(item.options)
        ? item.options.filter((v) => v != null && String(v).trim() !== '').map((v) => String(v).trim())
        : [];
      const options_ar = Array.isArray(item.options_ar)
        ? item.options_ar.filter((v) => v != null && String(v).trim() !== '').map((v) => String(v).trim())
        : [];
      // Optional per-value images, aligned by index with `options`. We keep the
      // full array (including "" gaps) so index alignment with options holds.
      // Optional per-value swatch colours (hex), aligned by index with `options`.
      const optionColors = Array.isArray(item.optionColors)
        ? item.optionColors.map((v) => (v == null ? '' : String(v).trim())).slice(0, options.length)
        : [];

      // Per-value image SETS (array-of-arrays). When provided, they are the
      // source of truth and we derive the single `optionImages` (mobile/hover =
      // first photo of each set). When absent, fall back to the legacy single
      // `optionImages` and synthesise trivial one-item sets from it.
      const cleanUrl = (v) => (v == null ? '' : String(v).trim());
      let optionImages;
      let optionImageSets;
      if (Array.isArray(item.optionImageSets)) {
        optionImageSets = [];
        for (let k = 0; k < options.length; k++) {
          const raw = Array.isArray(item.optionImageSets[k]) ? item.optionImageSets[k] : [];
          optionImageSets.push(raw.map(cleanUrl).filter(Boolean));
        }
        optionImages = optionImageSets.map((set) => set[0] || '');
      } else {
        optionImages = Array.isArray(item.optionImages)
          ? item.optionImages.map(cleanUrl).slice(0, options.length)
          : [];
        while (optionImages.length < options.length) optionImages.push('');
        optionImageSets = optionImages.map((u) => (u ? [u] : []));
      }

      return {
        title: titleEn || null,
        title_ar: titleAr || null,
        options,
        options_ar,
        optionImages,
        optionColors,
        optionImageSets,
        isVariantAxis: !!item.isVariantAxis,
        sortOrder: i,
      };
    })
    .filter(Boolean);
}

/**
 * Validate & normalize a `variants: [{optionValue, price, discountedPrice, images,
 * subtitle, isDefault, descriptions}]` payload into ProductVariant create rows. Each
 * row's own `descriptions` (same shape as the top-level description blocks) is
 * normalized too, via normalizeDescriptions — empty means this size has no override
 * and shares the product's shared blocks. Throws INVALID_PRICE (code set) on a
 * missing/invalid price or a discount exceeding its own row's price —
 * same convention as buildRegionPriceMap. Drops rows with no label on either side.
 * De-dupes by (case-insensitive) label — the DB's @@unique([productId, optionValue])
 * would otherwise reject the whole write. Exactly one row ends up `isDefault: true`:
 * the admin's first explicit choice, else the first remaining row.
 */
/**
 * Validate & normalize a `colors: [{label, label_ar, images, isDefault}]` payload
 * scoped to ONE variant — e.g. Large's own Pink/Blue/Red, entirely independent from
 * any other size's colour list. Drops rows with no label on either side, de-dupes
 * by (case-insensitive) label (no DB unique constraint to rely on here, so this is
 * belt-and-suspenders against the admin accidentally listing the same colour twice),
 * and collapses to exactly one `isDefault: true` — same convention as normalizeVariants.
 */
function normalizeVariantColors(colors) {
  if (!Array.isArray(colors)) return [];
  const rows = colors
    .map((item, i) => {
      if (item == null || typeof item !== 'object') return null;
      const label = item.label != null ? String(item.label).trim() : '';
      const label_ar = item.label_ar != null ? String(item.label_ar).trim() : '';
      if (!label && !label_ar) return null;
      const images = Array.isArray(item.images)
        ? item.images.filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim())
        : [];
      return {
        label: label || null,
        label_ar: label_ar || null,
        images,
        isDefault: !!item.isDefault,
        sortOrder: i,
      };
    })
    .filter(Boolean);

  const seenLabels = new Set();
  const deduped = rows.filter((row) => {
    const key = (row.label || row.label_ar || '').toLowerCase();
    if (seenLabels.has(key)) return false;
    seenLabels.add(key);
    return true;
  });

  const defaultIdx = deduped.findIndex((r) => r.isDefault);
  deduped.forEach((r, i) => {
    r.isDefault = defaultIdx >= 0 ? i === defaultIdx : i === 0;
    r.sortOrder = i;
  });

  return deduped;
}

function normalizeVariants(variants) {
  if (!Array.isArray(variants)) return [];
  const rows = variants
    .map((item, i) => {
      if (item == null || typeof item !== 'object') return null;
      const optionValue = item.optionValue != null ? String(item.optionValue).trim() : '';
      const optionValue_ar = item.optionValue_ar != null ? String(item.optionValue_ar).trim() : '';
      if (!optionValue && !optionValue_ar) return null;

      const price = item.price != null ? Number(item.price) : NaN;
      if (!Number.isFinite(price) || price < 0) {
        const err = new Error(`Variant "${optionValue || optionValue_ar}" requires a valid price`);
        err.code = 'INVALID_PRICE';
        throw err;
      }
      const discountedPrice = item.discountedPrice != null ? Number(item.discountedPrice) : null;
      if (discountedPrice != null && discountedPrice > price) {
        const err = new Error(`discountedPrice cannot exceed price for variant "${optionValue || optionValue_ar}"`);
        err.code = 'INVALID_PRICE';
        throw err;
      }
      const images = Array.isArray(item.images)
        ? item.images.filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim())
        : [];

      return {
        optionValue: optionValue || null,
        optionValue_ar: optionValue_ar || null,
        price,
        discountedPrice,
        images,
        subtitle: item.subtitle != null ? String(item.subtitle).trim() || null : null,
        subtitle_ar: item.subtitle_ar != null ? String(item.subtitle_ar).trim() || null : null,
        isDefault: !!item.isDefault,
        sortOrder: i,
        // This variant's own description blocks (same shape as the top-level
        // `descriptions` card). Empty array = admin left this size on the shared
        // copy; a non-empty array overrides the shared blocks for this size only.
        descriptions: normalizeDescriptions(item.descriptions),
        // This variant's own colour choices (e.g. Large's Pink/Blue/Red) — entirely
        // independent from any other size's list. Empty = this size offers no
        // colour picker at all.
        colors: normalizeVariantColors(item.colors),
      };
    })
    .filter(Boolean);

  const seenLabels = new Set();
  const deduped = rows.filter((row) => {
    const key = (row.optionValue || row.optionValue_ar || '').toLowerCase();
    if (seenLabels.has(key)) return false;
    seenLabels.add(key);
    return true;
  });

  const defaultIdx = deduped.findIndex((r) => r.isDefault);
  deduped.forEach((r, i) => {
    r.isDefault = defaultIdx >= 0 ? i === defaultIdx : i === 0;
    r.sortOrder = i;
  });

  return deduped;
}

// Normalize a publish status from admin input; defaults to DRAFT.
function normalizeStatus(value, fallback = 'DRAFT') {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toUpperCase();
  return v === 'PUBLISHED' ? 'PUBLISHED' : v === 'DRAFT' ? 'DRAFT' : fallback;
}

/**
 * Resolve the region ids to attach to a piece of content at write time.
 * - explicit non-empty list  -> validated against existing regions
 * - omitted / empty          -> default region (matches "default UAE")
 * Throws REGION_NOT_FOUND for unknown ids.
 */
async function resolveWriteRegionIds(regionIds) {
  if (Array.isArray(regionIds) && regionIds.length > 0) {
    return regionService.assertValidRegionIds(regionIds);
  }
  const def = await regionService.getDefaultRegion();
  return def ? [def.id] : [];
}

/**
 * Validate & index a `regionPrices: {regionId, price, discountedPrice}[]` payload
 * (the per-region manual price override, replacing the old single-currency
 * priceSar/discountedPriceSar columns) into a Map keyed by regionId, for merging
 * onto the ProductRegion create/update rows. Throws INVALID_PRICE (naming the
 * offending region) when a discount exceeds its own region's base price.
 */
function buildRegionPriceMap(regionPrices) {
  const map = new Map();
  if (!Array.isArray(regionPrices)) return map;
  for (const entry of regionPrices) {
    if (!entry || typeof entry.regionId !== 'string' || !entry.regionId) continue;
    const price = entry.price != null ? Number(entry.price) : null;
    const discountedPrice = entry.discountedPrice != null ? Number(entry.discountedPrice) : null;
    if (discountedPrice != null && price != null && discountedPrice > price) {
      const err = new Error(`discountedPrice cannot exceed price for region ${entry.regionId}`);
      err.code = 'INVALID_PRICE';
      throw err;
    }
    // Per-region "ships within N days" override (null = no override). Same validator
    // as the global Product.deliveryLeadDays; throws VALIDATION on a bad value.
    const deliveryLeadDays = parseDeliveryLeadDays(entry.deliveryLeadDays);
    // Per-region cash-arrangement fee schedule override (both-or-neither; null/null = no
    // override at this tier — falls through to the product/category default).
    const feeSchedule = parseCashArrangementFeeSchedule({
      feeStepAmount: entry.cashArrangementFeeStepAmount,
      feeMarginPercent: entry.cashArrangementFeeMarginPercent,
    });
    map.set(entry.regionId, {
      price,
      discountedPrice,
      deliveryLeadDays,
      cashArrangementFeeStepAmount: feeSchedule.feeStepAmount,
      cashArrangementFeeMarginPercent: feeSchedule.feeMarginPercent,
    });
  }
  return map;
}

async function createProduct(data) {
  const categoryId = data.categoryId ? String(data.categoryId).trim() || null : null;
  const status = normalizeStatus(data.status);
  // Optional override of Category.deliveryLeadDays / Settings.defaultDeliveryLeadDays for
  // this product specifically. null/undefined -> no override (falls through the chain).
  const deliveryLeadDays = parseDeliveryLeadDays(data.deliveryLeadDays);
  // Default cash-arrangement fee schedule for this product (both-or-neither; see
  // utils/cashArrangementMath.js for the full product/category/region/zone precedence chain).
  const cashArrangementFee = parseCashArrangementFeeSchedule({
    feeStepAmount: data.cashArrangementFeeStepAmount,
    feeMarginPercent: data.cashArrangementFeeMarginPercent,
  });
  // CAT-2: a discount must never exceed the base price (guard here too, not only in the
  // route validator, so non-HTTP callers can't create an inverted price).
  if (data.discountedPrice != null && data.price != null && Number(data.discountedPrice) > Number(data.price)) {
    const err = new Error('discountedPrice cannot exceed price');
    err.code = 'INVALID_PRICE';
    throw err;
  }
  const regionPriceMap = buildRegionPriceMap(data.regionPrices);
  const zoneLeadRows = buildZoneLeadRows(data.zoneLeadDays);
  const regionIds = await resolveWriteRegionIds(data.regionIds);
  const imageUrls = Array.isArray(data.images)
    ? data.images.filter((u) => typeof u === 'string' && u.trim()).slice(0, MAX_IMAGES)
    : [];
  const descriptionRows = normalizeDescriptions(data.descriptions);

  const quantity = data.quantity != null ? Math.max(0, parseInt(data.quantity, 10) || 0) : 0;
  const productOptionRows = normalizeProductOptions(data.productOptions);
  const variantRows = normalizeVariants(data.variants);
  // At most one option group drives variants (v1: single-axis) — a second one is
  // defensively cleared here even if the client somehow sent two.
  let variantAxisSeen = false;
  for (const row of productOptionRows) {
    if (row.isVariantAxis && variantAxisSeen) row.isVariantAxis = false;
    else if (row.isVariantAxis) variantAxisSeen = true;
  }
  // When variants exist, they're the source of truth for price — the top-level
  // price/discountedPrice mirror the default variant so older (variant-unaware)
  // clients, e.g. the mobile app, still show a sensible single price.
  const defaultVariantRow = variantRows.find((v) => v.isDefault) ?? null;
  // Flattened across every variant, for one batched translate/gap-fill call — same
  // pattern as the top-level descriptionRows.
  const variantDescriptionRows = variantRows.flatMap((v) => v.descriptions);
  const variantColorRows = variantRows.flatMap((v) => v.colors);

  // Auto-translate the en/_ar twins before the DB write. We translate the parent product
  // fields and every child description/option/variant in a single batched call so an
  // entire product create costs one round-trip, not N.
  const productDraft = {
    title: data.title ?? null,
    title_ar: data.title_ar ?? null,
    subtitle: data.subtitle ?? null,
    subtitle_ar: data.subtitle_ar ?? null,
  };
  await Promise.all([
    autoTranslate(productDraft, PRODUCT_BILINGUAL),
    autoTranslateMany(descriptionRows, PRODUCT_DESCRIPTION_BILINGUAL),
    autoTranslateMany(productOptionRows, PRODUCT_OPTION_BILINGUAL),
    autoTranslateMany(variantRows, PRODUCT_VARIANT_BILINGUAL),
    autoTranslateMany(variantDescriptionRows, PRODUCT_DESCRIPTION_BILINGUAL),
    autoTranslateMany(variantColorRows, PRODUCT_VARIANT_COLOR_BILINGUAL),
  ]);

  // If translation failed for any required column, copy the populated side across so
  // the Prisma write doesn't trip NOT NULL. Admin can re-save later for a real translation.
  fillBilingualGapsFromTwin(productDraft, PRODUCT_REQUIRED_PAIRS);
  for (const row of descriptionRows) fillBilingualGapsFromTwin(row, PRODUCT_DESCRIPTION_REQUIRED_PAIRS);
  for (const row of productOptionRows) fillBilingualGapsFromTwin(row, PRODUCT_OPTION_REQUIRED_PAIRS);
  for (const row of variantRows) fillBilingualGapsFromTwin(row, PRODUCT_VARIANT_REQUIRED_PAIRS);
  for (const row of variantDescriptionRows) fillBilingualGapsFromTwin(row, PRODUCT_DESCRIPTION_REQUIRED_PAIRS);
  for (const row of variantColorRows) fillBilingualGapsFromTwin(row, PRODUCT_VARIANT_COLOR_REQUIRED_PAIRS);

  // Wrap product create + category counter bump in a single transaction so a counter-update
  // failure rolls the product create back instead of leaving the cached count drifted.
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        title: productDraft.title,
        title_ar: productDraft.title_ar ?? null,
        subtitle: productDraft.subtitle ?? null,
        subtitle_ar: productDraft.subtitle_ar ?? null,
        price: defaultVariantRow ? defaultVariantRow.price : data.price,
        discountedPrice: defaultVariantRow ? defaultVariantRow.discountedPrice : data.discountedPrice ?? null,
        giftCardEnabled: !!data.giftCardEnabled,
        giftCardMode: normalizeGiftCardMode(data.giftCardMode),
        giftCardExtraPrice: data.giftCardExtraPrice != null ? Number(data.giftCardExtraPrice) : null,
        customNameEnabled: !!data.customNameEnabled,
        customNamePrice: data.customNamePrice != null ? Number(data.customNamePrice) : null,
        deliveryLeadDays,
        cashArrangementFeeStepAmount: cashArrangementFee.feeStepAmount,
        cashArrangementFeeMarginPercent: cashArrangementFee.feeMarginPercent,
        quantity,
        status,
        // Only a PUBLISHED product can be "coming soon"; a DRAFT is hidden anyway, so
        // never persist a confusing DRAFT+comingSoon state.
        comingSoon: status === 'PUBLISHED' ? !!data.comingSoon : false,
        ...(regionIds.length > 0
          ? {
              regions: {
                create: regionIds.map((regionId) => {
                  const rp = regionPriceMap.get(regionId);
                  return {
                    regionId,
                    price: rp?.price ?? null,
                    discountedPrice: rp?.discountedPrice ?? null,
                    deliveryLeadDays: rp?.deliveryLeadDays ?? null,
                    cashArrangementFeeStepAmount: rp?.cashArrangementFeeStepAmount ?? null,
                    cashArrangementFeeMarginPercent: rp?.cashArrangementFeeMarginPercent ?? null,
                  };
                }),
              },
            }
          : {}),
        ...(zoneLeadRows.length > 0 ? { zoneLeadDays: { create: zoneLeadRows } } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(imageUrls.length > 0
          ? {
              images: {
                create: imageUrls.map((url, i) => ({ url: url.trim(), sortOrder: i })),
              },
            }
          : {}),
        ...(descriptionRows.length > 0
          ? {
              descriptions: {
                create: descriptionRows,
              },
            }
          : {}),
        ...(productOptionRows.length > 0
          ? {
              productOptions: {
                create: productOptionRows,
              },
            }
          : {}),
        ...(variantRows.length > 0
          ? {
              // Own description blocks are attached in a second pass below, once the
              // variant rows (and this new product's id) actually exist — a variant's
              // `descriptions` relation points at Product too (productId), and Prisma's
              // nested-write auto-FK only reaches the IMMEDIATE parent (variantId), not
              // a grandparent id that doesn't exist yet within this same insert. Colours
              // don't have that problem (they only need variantId, the IMMEDIATE parent
              // of this very nesting level), so they're safe to create in this same pass.
              variants: {
                create: variantRows.map(({ descriptions, colors, ...rest }) => ({
                  ...rest,
                  ...(colors.length > 0 ? { colors: { create: colors } } : {}),
                })),
              },
            }
          : {}),
      },
      include: {
        variants: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (categoryId) {
      await tx.category.update({
        where: { id: categoryId },
        data: { totalProducts: { increment: 1 } },
      });
    }

    // Second pass: attach each variant's own description blocks now that both the
    // product id and each variant's id exist. `product.variants` is sorted by the same
    // sortOrder used to build variantRows, so index i always lines up with variantRows[i].
    for (let i = 0; i < variantRows.length; i++) {
      const ownDescriptions = variantRows[i].descriptions;
      if (ownDescriptions.length > 0) {
        await tx.productDescription.createMany({
          data: ownDescriptions.map((d) => ({ ...d, productId: product.id, variantId: product.variants[i].id })),
        });
      }
    }

    return tx.product.findUnique({
      where: { id: product.id },
      include: {
        category: { select: { id: true, title: true, deliveryLeadDays: true, comingSoon: true, giftCardMode: true } },
        images: { orderBy: { sortOrder: 'asc' } },
        descriptions: { orderBy: { sortOrder: 'asc' } },
        productOptions: { orderBy: { sortOrder: 'asc' } },
        variants: {
          orderBy: { sortOrder: 'asc' },
          include: {
            descriptions: { orderBy: { sortOrder: 'asc' } },
            colors: { orderBy: { sortOrder: 'asc' } },
          },
        },
        ...REGION_INCLUDE,
      },
    });
  });
}

async function updateProduct(id, data) {
  const existing = await prisma.product.findUnique({
    where: { id },
    include: { images: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!existing) return null;

  // CAT-3: optimistic concurrency. When the caller passes the updatedAt it last read,
  // reject the write if the row changed since (concurrent edit, or stock moved under it)
  // rather than silently clobbering. Enforced again inside the transaction below.
  let expectedUpdatedAtMs = null;
  if (data.expectedUpdatedAt != null) {
    const ms = new Date(data.expectedUpdatedAt).getTime();
    if (!Number.isNaN(ms)) {
      expectedUpdatedAtMs = ms;
      if (ms !== new Date(existing.updatedAt).getTime()) {
        const err = new Error('This product was changed by someone else. Reload and try again.');
        err.code = 'STALE_WRITE';
        throw err;
      }
    }
  }

  // CAT-2: discount can't exceed the base price — compare against the incoming price, or
  // the EXISTING price when this partial update doesn't touch price.
  if (data.discountedPrice != null) {
    const basePrice = data.price != null ? Number(data.price) : Number(existing.price);
    if (Number(data.discountedPrice) > basePrice) {
      const err = new Error('discountedPrice cannot exceed price');
      err.code = 'INVALID_PRICE';
      throw err;
    }
  }
  const regionPriceMap = buildRegionPriceMap(data.regionPrices);
  // Per-zone prep-lead overrides: null = key absent (leave existing rows untouched); an
  // array = full replace with only the non-null entries.
  const zoneLeadRows = data.zoneLeadDays !== undefined ? buildZoneLeadRows(data.zoneLeadDays) : null;

  const bilingualDraft = {};
  if (data.title !== undefined) bilingualDraft.title = data.title;
  if (data.title_ar !== undefined) bilingualDraft.title_ar = data.title_ar;
  if (data.subtitle !== undefined) bilingualDraft.subtitle = data.subtitle;
  if (data.subtitle_ar !== undefined) bilingualDraft.subtitle_ar = data.subtitle_ar;

  // Normalize children up front so we can translate them BEFORE opening the transaction.
  // Doing network I/O inside $transaction would pin a DB connection for the duration of
  // the Azure call and risks transaction timeouts under load.
  const descriptionRows = data.descriptions !== undefined ? normalizeDescriptions(data.descriptions) : null;
  const productOptionRows = data.productOptions !== undefined ? normalizeProductOptions(data.productOptions) : null;
  const variantRows = data.variants !== undefined ? normalizeVariants(data.variants) : null;
  if (productOptionRows) {
    // At most one option group drives variants (v1: single-axis).
    let variantAxisSeen = false;
    for (const row of productOptionRows) {
      if (row.isVariantAxis && variantAxisSeen) row.isVariantAxis = false;
      else if (row.isVariantAxis) variantAxisSeen = true;
    }
  }
  // When this update sends a non-empty variants array, it becomes the source of truth
  // for price — see the matching comment in createProduct.
  const defaultVariantRow = variantRows && variantRows.length > 0 ? variantRows.find((v) => v.isDefault) ?? null : null;
  // Flattened across every incoming variant, for one batched translate/gap-fill call —
  // same pattern as createProduct. [] (not null) when variantRows is null so the
  // Promise.all/for-of below don't need a separate null check.
  const variantDescriptionRows = variantRows ? variantRows.flatMap((v) => v.descriptions) : [];
  const variantColorRows = variantRows ? variantRows.flatMap((v) => v.colors) : [];

  // Region links are replaced wholesale when `regionIds` OR `regionPrices` is sent — a
  // price-only update (visibility untouched) still needs the full existing region set so
  // the replace-on-write below doesn't wipe visibility. Validate before opening the
  // transaction so an unknown id fails fast without a partial write. Existing per-region
  // prices are fetched here too, as the fallback for any region left out of an incoming
  // `regionPrices` array (e.g. admin only touched Morocco's price — Saudi's must survive
  // the delete+recreate below, not silently null out).
  let existingRegionPriceByRegionId = new Map();
  let newRegionIds = null;
  if (data.regionIds !== undefined || data.regionPrices !== undefined) {
    const existingRegionRows = await prisma.productRegion.findMany({
      where: { productId: id },
      select: {
        regionId: true,
        price: true,
        discountedPrice: true,
        deliveryLeadDays: true,
        cashArrangementFeeStepAmount: true,
        cashArrangementFeeMarginPercent: true,
      },
    });
    existingRegionPriceByRegionId = new Map(
      existingRegionRows.map((r) => [
        r.regionId,
        {
          price: decimalToNumber(r.price),
          discountedPrice: decimalToNumber(r.discountedPrice),
          deliveryLeadDays: r.deliveryLeadDays ?? null,
          cashArrangementFeeStepAmount: decimalToNumber(r.cashArrangementFeeStepAmount),
          cashArrangementFeeMarginPercent: decimalToNumber(r.cashArrangementFeeMarginPercent),
        },
      ])
    );
    newRegionIds = data.regionIds !== undefined
      ? await regionService.assertValidRegionIds(Array.isArray(data.regionIds) ? data.regionIds : [])
      : [...existingRegionPriceByRegionId.keys()];
  }

  await Promise.all([
    autoTranslate(bilingualDraft, PRODUCT_BILINGUAL),
    descriptionRows ? autoTranslateMany(descriptionRows, PRODUCT_DESCRIPTION_BILINGUAL) : Promise.resolve(),
    productOptionRows ? autoTranslateMany(productOptionRows, PRODUCT_OPTION_BILINGUAL) : Promise.resolve(),
    variantRows ? autoTranslateMany(variantRows, PRODUCT_VARIANT_BILINGUAL) : Promise.resolve(),
    variantDescriptionRows.length > 0
      ? autoTranslateMany(variantDescriptionRows, PRODUCT_DESCRIPTION_BILINGUAL)
      : Promise.resolve(),
    variantColorRows.length > 0
      ? autoTranslateMany(variantColorRows, PRODUCT_VARIANT_COLOR_BILINGUAL)
      : Promise.resolve(),
  ]);

  // Child rows are fully replaced (delete + createMany) on update, so the NOT NULL columns
  // must be satisfied — copy across from the twin if translation didn't fill them.
  // The parent bilingualDraft is intentionally NOT gap-filled on update: leaving a side
  // undefined makes Prisma skip that column, preserving the existing DB value.
  if (descriptionRows) {
    for (const row of descriptionRows) fillBilingualGapsFromTwin(row, PRODUCT_DESCRIPTION_REQUIRED_PAIRS);
  }
  if (productOptionRows) {
    for (const row of productOptionRows) fillBilingualGapsFromTwin(row, PRODUCT_OPTION_REQUIRED_PAIRS);
  }
  if (variantRows) {
    for (const row of variantRows) fillBilingualGapsFromTwin(row, PRODUCT_VARIANT_REQUIRED_PAIRS);
  }
  for (const row of variantDescriptionRows) fillBilingualGapsFromTwin(row, PRODUCT_DESCRIPTION_REQUIRED_PAIRS);
  for (const row of variantColorRows) fillBilingualGapsFromTwin(row, PRODUCT_VARIANT_COLOR_REQUIRED_PAIRS);

  const updatePayload = {
    ...(bilingualDraft.title != null && { title: bilingualDraft.title }),
    ...(bilingualDraft.title_ar !== undefined && { title_ar: bilingualDraft.title_ar ?? null }),
    ...(bilingualDraft.subtitle !== undefined && { subtitle: bilingualDraft.subtitle }),
    ...(bilingualDraft.subtitle_ar !== undefined && { subtitle_ar: bilingualDraft.subtitle_ar ?? null }),
    // Variants (when this update carries any) are the source of truth for price —
    // overrides whatever data.price/discountedPrice was sent, same as createProduct.
    ...(defaultVariantRow
      ? { price: defaultVariantRow.price, discountedPrice: defaultVariantRow.discountedPrice }
      : {
          ...(data.price != null && { price: data.price }),
          ...(data.discountedPrice !== undefined && { discountedPrice: data.discountedPrice }),
        }),
    ...(data.giftCardEnabled !== undefined && { giftCardEnabled: !!data.giftCardEnabled }),
    ...(data.giftCardMode !== undefined && { giftCardMode: normalizeGiftCardMode(data.giftCardMode) }),
    ...(data.giftCardExtraPrice !== undefined && {
      giftCardExtraPrice: data.giftCardExtraPrice != null ? Number(data.giftCardExtraPrice) : null,
    }),
    ...(data.customNameEnabled !== undefined && { customNameEnabled: !!data.customNameEnabled }),
    ...(data.customNamePrice !== undefined && {
      customNamePrice: data.customNamePrice != null ? Number(data.customNamePrice) : null,
    }),
    // Optional override; omit the field to leave it untouched, or send null to clear it
    // back to "no override" (falls through to Category.deliveryLeadDays / the global default).
    ...(data.deliveryLeadDays !== undefined && { deliveryLeadDays: parseDeliveryLeadDays(data.deliveryLeadDays) }),
    // Fee schedule is a matched pair — only touched when EITHER field is sent (both-or-
    // neither enforced by parseCashArrangementFeeSchedule); omitting both leaves the
    // existing schedule untouched, sending both as null/'' clears it back to "no override".
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
    ...(data.quantity !== undefined && { quantity: Math.max(0, parseInt(data.quantity, 10) || 0) }),
    ...(data.categoryId !== undefined && { categoryId: data.categoryId || null }),
    ...(data.status !== undefined && { status: normalizeStatus(data.status, existing.status) }),
    // comingSoon is meaningful only while PUBLISHED: clamp any sent value to the
    // effective status, and force it off if this update drafts the product (so a
    // status-only edit can never leave a stale DRAFT+comingSoon state behind).
    ...((data.comingSoon !== undefined || data.status !== undefined) && (() => {
      const effectiveStatus =
        data.status !== undefined ? normalizeStatus(data.status, existing.status) : existing.status;
      if (effectiveStatus !== 'PUBLISHED') return { comingSoon: false };
      if (data.comingSoon !== undefined) return { comingSoon: !!data.comingSoon };
      return {}; // becoming/staying published without a comingSoon value → leave as-is
    })()),
  };

  // All product mutations + counter rebalances run inside one transaction so a partial
  // failure (e.g. counter update on a deleted target category) rolls everything back.
  await prisma.$transaction(async (tx) => {
    if (data.categoryId !== undefined && data.categoryId !== existing.categoryId) {
      if (existing.categoryId) {
        await tx.category.update({
          where: { id: existing.categoryId },
          data: { totalProducts: { decrement: 1 } },
        });
      }
      if (data.categoryId) {
        await tx.category.update({
          where: { id: data.categoryId },
          data: { totalProducts: { increment: 1 } },
        });
      }
    }

    if (expectedUpdatedAtMs != null) {
      // CAT-3: conditional write closes the read→write race — only succeeds if the row's
      // updatedAt still matches what the caller saw. 0 rows ⇒ someone else won; abort.
      const res = await tx.product.updateMany({
        where: { id, updatedAt: new Date(expectedUpdatedAtMs) },
        data: updatePayload,
      });
      if (res.count === 0) {
        const err = new Error('This product was changed by someone else. Reload and try again.');
        err.code = 'STALE_WRITE';
        throw err;
      }
    } else {
      await tx.product.update({
        where: { id },
        data: updatePayload,
      });
    }

    if (data.images !== undefined) {
      const imageUrls = Array.isArray(data.images)
        ? data.images.filter((u) => typeof u === 'string' && u.trim()).slice(0, MAX_IMAGES)
        : [];
      await tx.productImage.deleteMany({ where: { productId: id } });
      if (imageUrls.length > 0) {
        await tx.productImage.createMany({
          data: imageUrls.map((url, i) => ({
            productId: id,
            url: url.trim(),
            sortOrder: i,
          })),
        });
      }
    }

    if (descriptionRows !== null) {
      // Scoped to the SHARED blocks only (variantId: null) — a variant's own override
      // blocks live under its own ProductVariant row and are replaced below instead,
      // so editing the shared copy never wipes a size's custom description.
      await tx.productDescription.deleteMany({ where: { productId: id, variantId: null } });
      if (descriptionRows.length > 0) {
        await tx.productDescription.createMany({
          data: descriptionRows.map((row) => ({ productId: id, variantId: null, ...row })),
        });
      }
    }

    if (productOptionRows !== null) {
      await tx.productOption.deleteMany({ where: { productId: id } });
      if (productOptionRows.length > 0) {
        await tx.productOption.createMany({
          data: productOptionRows.map((row) => ({ productId: id, ...row })),
        });
      }
    }

    if (variantRows !== null) {
      // Deleting a variant cascades (DB-level) to its own description rows, so this
      // alone clears any prior per-variant overrides too.
      await tx.productVariant.deleteMany({ where: { productId: id } });
      // One-by-one create (not createMany) because a variant with its own description
      // blocks needs a nested write — createMany can't attach child relations.
      for (const row of variantRows) {
        const { descriptions, colors, ...rest } = row;
        await tx.productVariant.create({
          data: {
            productId: id,
            ...rest,
            // productId is supplied explicitly (not left to relation auto-connect) — the
            // product already exists here (unlike in createProduct's single-shot nested
            // write), so there's no chicken-and-egg id problem.
            ...(descriptions.length > 0
              ? { descriptions: { create: descriptions.map((d) => ({ ...d, productId: id })) } }
              : {}),
            // Colours only need variantId (this create's own immediate relation, not a
            // grandparent), so unlike descriptions they're safe to nest directly here.
            ...(colors.length > 0 ? { colors: { create: colors } } : {}),
          },
        });
      }
    }

    // Per-zone prep-lead overrides: full replace when the key was sent.
    if (zoneLeadRows !== null) {
      await tx.productZone.deleteMany({ where: { productId: id } });
      if (zoneLeadRows.length > 0) {
        await tx.productZone.createMany({
          data: zoneLeadRows.map((z) => ({ productId: id, ...z })),
        });
      }
    }

    if (newRegionIds !== null) {
      await tx.productRegion.deleteMany({ where: { productId: id } });
      if (newRegionIds.length > 0) {
        await tx.productRegion.createMany({
          data: newRegionIds.map((regionId) => {
            // An explicit entry in this update's regionPrices wins; otherwise carry the
            // region's existing price forward so an unrelated visibility/price edit for
            // another region doesn't silently null this one out.
            const rp = regionPriceMap.get(regionId) ?? existingRegionPriceByRegionId.get(regionId);
            return {
              productId: id,
              regionId,
              price: rp?.price ?? null,
              discountedPrice: rp?.discountedPrice ?? null,
              deliveryLeadDays: rp?.deliveryLeadDays ?? null,
              cashArrangementFeeStepAmount: rp?.cashArrangementFeeStepAmount ?? null,
              cashArrangementFeeMarginPercent: rp?.cashArrangementFeeMarginPercent ?? null,
            };
          }),
          skipDuplicates: true,
        });
      }
    }
  });

  return prisma.product.findUnique({
    where: { id },
    include: {
      category: { select: { id: true, title: true, deliveryLeadDays: true, comingSoon: true, giftCardMode: true } },
      images: { orderBy: { sortOrder: 'asc' } },
      descriptions: { orderBy: { sortOrder: 'asc' } },
      productOptions: { orderBy: { sortOrder: 'asc' } },
      variants: {
        orderBy: { sortOrder: 'asc' },
        include: {
          descriptions: { orderBy: { sortOrder: 'asc' } },
          colors: { orderBy: { sortOrder: 'asc' } },
        },
      },
      ...REGION_INCLUDE,
    },
  });
}

async function deleteProduct(id) {
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) return null;

  const activeOrderCount = await prisma.orderItem.count({
    where: {
      productId: id,
      order: { status: { in: ACTIVE_ORDER_STATUSES } },
    },
  });
  if (activeOrderCount > 0) {
    const err = new Error('Cannot delete product with active orders');
    err.code = 'PRODUCT_HAS_ACTIVE_ORDERS';
    err.activeOrderCount = activeOrderCount;
    throw err;
  }

  await prisma.$transaction(async (tx) => {
    // Snapshot title onto historical order items so they stay readable after the product is gone.
    await tx.orderItem.updateMany({
      where: { productId: id, productTitle: null },
      data: { productTitle: product.title, productTitle_ar: product.title_ar ?? null },
    });
    await tx.product.delete({ where: { id } });
    if (product.categoryId) {
      await tx.category.update({
        where: { id: product.categoryId },
        data: { totalProducts: { decrement: 1 } },
      });
    }
  });

  return product;
}

/**
 * Reorder products by assigning explicit sortOrder values (admin drag-and-drop).
 * Accepts an array of { id, sortOrder }. Because the admin list is paginated, the
 * caller sends absolute positions (base = page offset + row index) so ordering
 * stays globally consistent across pages. Runs in a single transaction.
 * @param {{ id: string, sortOrder: number }[]} items
 */
async function reorderProducts(items) {
  const clean = (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it.id === 'string' && Number.isInteger(it.sortOrder))
    .map((it) => ({ id: it.id, sortOrder: it.sortOrder }));
  if (clean.length === 0) return { count: 0 };

  await prisma.$transaction(
    clean.map((it) =>
      prisma.product.update({ where: { id: it.id }, data: { sortOrder: it.sortOrder } })
    )
  );
  return { count: clean.length };
}

// CAT-6: cap how deep a client can page so ?page=99999999 can't force a giant OFFSET
// scan on this public endpoint. 10k pages × 100/page covers any real catalog.
const MAX_PAGE = 10000;

async function getAllProductsOrdered(page, limit, categoryId, visibility, orderBy, rescueIds = null) {
  const safePage = Math.min(MAX_PAGE, Math.max(1, page));
  const take = Math.min(100, Math.max(1, limit));
  const skip = (safePage - 1) * take;
  const where = {
    ...buildVisibilityWhere(visibility),
    ...buildCategoryVisibilityWhere(visibility, rescueIds),
    ...(categoryId ? { categoryId } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        category: { select: { id: true, title: true, deliveryLeadDays: true, comingSoon: true, giftCardMode: true } },
        images: { orderBy: { sortOrder: 'asc' } },
        descriptions: { orderBy: { sortOrder: 'asc' } },
        productOptions: { orderBy: { sortOrder: 'asc' } },
        variants: {
          orderBy: { sortOrder: 'asc' },
          include: {
            descriptions: { orderBy: { sortOrder: 'asc' } },
            colors: { orderBy: { sortOrder: 'asc' } },
          },
        },
        ...(visibility.isStaff ? REGION_INCLUDE : regionPriceInclude(visibility.regionId)),
      },
    }),
    prisma.product.count({ where }),
  ]);

  const mapped = items.map(mapProduct);
  await attachRatingAggregates(mapped);
  await attachResolvedDeliveryLeadDays(mapped, visibility.isStaff ? null : visibility.regionId, visibility.isStaff ? null : visibility.zoneId);
  return {
    // Storefront-only: overlay the requesting region's currency (AED/SAR) so `price`/
    // `discountedPrice` are already correct for the region. Staff/admin keep raw fields.
    items: visibility.isStaff ? mapped : mapped.map((p) => applyRegionCurrency(p)),
    total,
    page: safePage,
    limit: take,
    totalPages: Math.ceil(total / take),
  };
}

async function getAllProducts(page = 1, limit = 10, categoryId = null, visibility = {}, rescueIds = null) {
  // Admin-controlled display order first (drag-and-drop sets sortOrder), then
  // newest. All products default to sortOrder 0, so the effective order is
  // unchanged until an admin explicitly reorders.
  // `rescueIds` (section-surfaced products) let the storefront "Everything" list keep
  // showing featured products whose category is ENTIRE_STORE-draft — see the controller.
  return getAllProductsOrdered(page, limit, categoryId, visibility, [{ sortOrder: 'asc' }, { createdAt: 'desc' }], rescueIds);
}

/**
 * "New Arrivals" feed — pure recency order (createdAt desc), deliberately ignoring
 * the admin's manual catalogue sortOrder (unlike getAllProducts' default order):
 * "new arrivals" is explicitly about what was just published, not curated display
 * order. Uses createdAt as the recency signal — this schema has no separate
 * publishedAt column, and createdAt is already this codebase's own established
 * proxy for it (see schema.prisma's `@@index([status, createdAt])` comment).
 * Mirrors getBestSellers' shape/pagination so the storefront's "View all"
 * experience is consistent between the two rails.
 */
async function getNewArrivals(page = 1, limit = 10, visibility = {}) {
  // `id` as a stable tiebreaker after createdAt — without it, products sharing an
  // identical createdAt (e.g. bulk-imported/seeded in one batch) have a
  // non-deterministic order, which can duplicate or skip a product across
  // OFFSET-paginated "load more" pages.
  return getAllProductsOrdered(page, limit, null, visibility, [{ createdAt: 'desc' }, { id: 'asc' }]);
}

async function getProductsByCategory(categoryId, page = 1, limit = 10, visibility = {}) {
  return getAllProducts(page, limit, categoryId, visibility);
}

// Best Sellers ranks products by real units sold (non-cancelled, non-refunded orders)
// in the requesting region. Bounds how many candidate ids we ever assemble across the
// ranked-sales + fallback tiers below — plenty for any realistic catalog size
// while keeping the query cost bounded.
const BEST_SELLERS_CANDIDATE_CAP = 300;

/** Product ids ranked by total units sold (non-cancelled, non-refunded orders), most-sold
 *  first. Scoped to a region when one is given; combined across all regions otherwise
 *  (staff/admin reads). Capped at BEST_SELLERS_CANDIDATE_CAP rows. */
async function getBestSellingProductIds(regionId) {
  const regionFilter = regionId ? Prisma.sql`AND o."regionId" = ${regionId}` : Prisma.empty;
  const rows = await prisma.$queryRaw`
    SELECT oi."productId" AS "productId"
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON o.id = oi."orderId"
    WHERE o.status NOT IN ('CANCELLED', 'REFUNDED') AND oi."productId" IS NOT NULL ${regionFilter}
    GROUP BY oi."productId"
    ORDER BY SUM(oi.quantity) DESC
    LIMIT ${BEST_SELLERS_CANDIDATE_CAP}
  `;
  return rows.map((r) => r.productId);
}

/**
 * "Best Selling" product feed for the storefront filter. Ranked by real sales first;
 * falls back so the result is never empty even for a brand-new store or region with
 * no orders yet:
 *   1. Products ranked by units sold (non-cancelled orders) in this region.
 *   2. The "Gift Boxes" showcase category — the same one the homepage's Best
 *      Sellers section falls back to — filling any remaining slots.
 *   3. The plain catalogue in its standard default order, filling whatever's left.
 * Each tier excludes ids already picked by an earlier tier, so the merged id list
 * has no duplicates. Paginates over that merged, deterministic id list exactly
 * like getAllProducts, so "load more" behaves the same as every other source.
 */
async function getBestSellers(page = 1, limit = 10, visibility = {}) {
  const safePage = Math.min(MAX_PAGE, Math.max(1, page));
  const take = Math.min(100, Math.max(1, limit));
  const skip = (safePage - 1) * take;
  const where = {
    ...buildVisibilityWhere(visibility),
    ...buildCategoryVisibilityWhere(visibility),
  };

  // Sales-ranked ids come straight from OrderItem sums — NOT visibility-filtered. Keep
  // only the ones that pass the current `where` (draft status / region / ENTIRE_STORE
  // category draft), preserving sales-rank order. Without this, `total` counts hidden
  // products that the final page fetch drops, so the count and pagination overstate the
  // real result set (e.g. total:13 but only 5 visible items).
  const rankedIds = await getBestSellingProductIds(visibility.regionId ?? null);
  const candidateIds = [];
  if (rankedIds.length > 0) {
    const visibleRanked = await prisma.product.findMany({
      where: { ...where, id: { in: rankedIds } },
      select: { id: true },
    });
    const visibleSet = new Set(visibleRanked.map((p) => p.id));
    for (const id of rankedIds) if (visibleSet.has(id)) candidateIds.push(id);
  }
  const seen = new Set(candidateIds);

  if (candidateIds.length < BEST_SELLERS_CANDIDATE_CAP) {
    const giftCategory = await prisma.category.findFirst({
      where: { title: { contains: 'gift box', mode: 'insensitive' } },
      select: { id: true },
    });
    if (giftCategory) {
      const fallbackProducts = await prisma.product.findMany({
        where: { ...where, categoryId: giftCategory.id, id: { notIn: [...seen] } },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        select: { id: true },
        take: BEST_SELLERS_CANDIDATE_CAP - candidateIds.length,
      });
      for (const p of fallbackProducts) {
        candidateIds.push(p.id);
        seen.add(p.id);
      }
    }
  }

  if (candidateIds.length < BEST_SELLERS_CANDIDATE_CAP) {
    const rest = await prisma.product.findMany({
      where: { ...where, id: { notIn: [...seen] } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      select: { id: true },
      take: BEST_SELLERS_CANDIDATE_CAP - candidateIds.length,
    });
    for (const p of rest) {
      candidateIds.push(p.id);
      seen.add(p.id);
    }
  }

  const total = candidateIds.length;
  const pageIds = candidateIds.slice(skip, skip + take);

  let items = [];
  if (pageIds.length > 0) {
    const products = await prisma.product.findMany({
      where: { ...where, id: { in: pageIds } },
      include: {
        category: { select: { id: true, title: true, deliveryLeadDays: true, comingSoon: true, giftCardMode: true } },
        images: { orderBy: { sortOrder: 'asc' } },
        descriptions: { orderBy: { sortOrder: 'asc' } },
        productOptions: { orderBy: { sortOrder: 'asc' } },
        variants: {
          orderBy: { sortOrder: 'asc' },
          include: {
            descriptions: { orderBy: { sortOrder: 'asc' } },
            colors: { orderBy: { sortOrder: 'asc' } },
          },
        },
        ...(visibility.isStaff ? REGION_INCLUDE : regionPriceInclude(visibility.regionId)),
      },
    });
    const orderIndex = new Map(pageIds.map((id, i) => [id, i]));
    products.sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0));
    items = products.map(mapProduct);
    await attachRatingAggregates(items);
    await attachResolvedDeliveryLeadDays(items, visibility.isStaff ? null : visibility.regionId, visibility.isStaff ? null : visibility.zoneId);
  }

  return {
    items: visibility.isStaff ? items : items.map((p) => applyRegionCurrency(p)),
    total,
    page: safePage,
    limit: take,
    totalPages: Math.ceil(total / take),
  };
}

// Cap the search term length so a pathological 10k-char query can't build a huge
// ILIKE pattern. Anything past this can't add meaningful signal for a catalog search.
const MAX_SEARCH_LEN = 100;

/**
 * Full-text-ish product search across the bilingual title/subtitle columns, the
 * product's description blocks, and its category name. Backed by pg_trgm GIN indexes
 * (see the 20260702000000_product_search_trgm and 20260803000000_product_description_search_trgm
 * migrations) so the case-insensitive substring match is served from an index instead
 * of a sequential scan.
 *
 * Visibility is applied through the same buildVisibilityWhere() used everywhere else,
 * so storefront callers only ever match PUBLISHED products in their region and staff
 * see everything (optionally narrowed by their admin filters). An optional `categoryId`
 * narrows results to one category — used by the admin panel's category filter, combined
 * with a search term or on its own.
 *
 * Results are ordered by recency (createdAt desc) — the standard catalog order — after
 * the index narrows the set to matches. Returns the same paginated shape as the list
 * endpoints, plus the normalized query echoed back.
 */
async function searchProducts(rawQuery, page = 1, limit = 10, visibility = {}, categoryId = null) {
  const q = String(rawQuery ?? '').trim().slice(0, MAX_SEARCH_LEN);
  const safePage = Math.min(MAX_PAGE, Math.max(1, page));
  const take = Math.min(100, Math.max(1, limit));
  const skip = (safePage - 1) * take;

  // Empty query → no results (rather than "everything"), so an accidental blank
  // search doesn't dump the whole catalog through the search path.
  if (!q) {
    return { items: [], total: 0, page: safePage, limit: take, totalPages: 0, query: q };
  }

  const contains = { contains: q, mode: 'insensitive' };
  const where = {
    ...buildVisibilityWhere(visibility),
    ...buildCategoryVisibilityWhere(visibility),
    ...(categoryId ? { categoryId } : {}),
    OR: [
      { title: contains },
      { title_ar: contains },
      { subtitle: contains },
      { subtitle_ar: contains },
      { category: { is: { title: contains } } },
      { category: { is: { title_ar: contains } } },
      { descriptions: { some: { OR: [{ description: contains }, { description_ar: contains }] } } },
    ],
  };

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        category: { select: { id: true, title: true, deliveryLeadDays: true, comingSoon: true, giftCardMode: true } },
        images: { orderBy: { sortOrder: 'asc' } },
        descriptions: { orderBy: { sortOrder: 'asc' } },
        productOptions: { orderBy: { sortOrder: 'asc' } },
        variants: {
          orderBy: { sortOrder: 'asc' },
          include: {
            descriptions: { orderBy: { sortOrder: 'asc' } },
            colors: { orderBy: { sortOrder: 'asc' } },
          },
        },
        ...(visibility.isStaff ? REGION_INCLUDE : regionPriceInclude(visibility.regionId)),
      },
    }),
    prisma.product.count({ where }),
  ]);

  const mappedResults = items.map(mapProduct);
  await attachRatingAggregates(mappedResults);
  await attachResolvedDeliveryLeadDays(mappedResults, visibility.isStaff ? null : visibility.regionId, visibility.isStaff ? null : visibility.zoneId);
  return {
    items: visibility.isStaff
      ? mappedResults
      : mappedResults.map((p) => applyRegionCurrency(p)),
    total,
    page: safePage,
    limit: take,
    totalPages: Math.ceil(total / take),
    query: q,
  };
}

async function getProductById(id, visibility = {}, rescueIds = null) {
  const product = await prisma.product.findFirst({
    where: { id, ...buildVisibilityWhere(visibility), ...buildCategoryVisibilityWhere(visibility, rescueIds) },
    include: {
      category: { select: { id: true, title: true, deliveryLeadDays: true, comingSoon: true, giftCardMode: true } },
      images: { orderBy: { sortOrder: 'asc' } },
      descriptions: { orderBy: { sortOrder: 'asc' } },
      productOptions: { orderBy: { sortOrder: 'asc' } },
      variants: {
        orderBy: { sortOrder: 'asc' },
        include: {
          descriptions: { orderBy: { sortOrder: 'asc' } },
          colors: { orderBy: { sortOrder: 'asc' } },
        },
      },
      ...(visibility.isStaff ? REGION_INCLUDE : regionPriceInclude(visibility.regionId)),
    },
  });
  if (!product) return null;
  const mapped = mapProduct(product);
  await attachRatingAggregates([mapped]);
  await attachResolvedDeliveryLeadDays([mapped], visibility.isStaff ? null : visibility.regionId, visibility.isStaff ? null : visibility.zoneId);
  return visibility.isStaff ? mapped : applyRegionCurrency(mapped);
}

/**
 * Resolve the representative image for a chosen variant, so the cart, order,
 * email, and admin surfaces show the photo of the colour/variant the shopper
 * picked rather than the product's default primary image.
 *
 * `selectedOptions` is the {title: value} snapshot captured at add-to-cart time
 * (keyed by the option-group title in whatever locale the shopper used).
 * `productOptions` are the RAW ProductOption rows (with `optionImages` /
 * `optionImageSets`), NOT the trimmed display shape. Matches the title against
 * EN and AR, and the value against `options`/`options_ar`, then returns that
 * value's first image (a full image-set entry wins over the single legacy
 * image). Returns null when nothing matches or the variant carries no image —
 * callers fall back to the product's primary image.
 */
/**
 * Finds the ProductVariant matching a chosen `selectedOptions` value, by walking only
 * the `isVariantAxis` ProductOption group(s) (never a purely-visual group like
 * "Colour") and resolving the chosen value to its EN/AR canonical form the same way
 * resolveVariantImage does. Returns null (not a fallback) when nothing matches or the
 * product has no variants — callers decide whether "no match" means "use the default"
 * (pricing) or "no override" (image).
 */
function findMatchingVariant(productOptions, variants, selectedOptions) {
  if (
    !Array.isArray(variants) ||
    variants.length === 0 ||
    !selectedOptions ||
    typeof selectedOptions !== 'object' ||
    Array.isArray(selectedOptions) ||
    !Array.isArray(productOptions)
  ) {
    return null;
  }
  for (const group of productOptions) {
    if (!group || !group.isVariantAxis) continue;
    const chosen =
      selectedOptions[group.title] ??
      (group.title_ar ? selectedOptions[group.title_ar] : undefined);
    if (!chosen) continue;
    const en = Array.isArray(group.options) ? group.options : [];
    const ar = Array.isArray(group.options_ar) ? group.options_ar : [];
    let idx = en.indexOf(chosen);
    if (idx < 0) idx = ar.indexOf(chosen);
    if (idx < 0) continue;
    const canonical = en[idx] || ar[idx];
    const match = variants.find((v) => v.optionValue === canonical || v.optionValue_ar === chosen);
    if (match) return match;
  }
  return null;
}

/**
 * Resolves which ProductVariant a cart/order line's `selectedOptions` picked, for
 * PRICING purposes: always returns a variant when the product has any (falling back to
 * the row flagged `isDefault`, else the first) so a line always has a definite price
 * even if the client's selection is missing/stale. Returns null only when the product
 * has no variants at all — callers then use the plain product/region price.
 */
function resolveVariantPricing(productOptions, variants, selectedOptions) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  return (
    findMatchingVariant(productOptions, variants, selectedOptions) ||
    variants.find((v) => v.isDefault) ||
    variants[0]
  );
}

/**
 * Effective per-unit price for a product row + the line's chosen options: the matching
 * variant's price (discounted only when lower) when the product has variants, else the
 * existing region-aware product price. `productRow` must carry `productOptions` and
 * `variants` (raw rows) alongside the usual `regions` scoping.
 */
function resolveEffectivePrice(productRow, selectedOptions) {
  const variants = Array.isArray(productRow.variants) ? productRow.variants : null;
  if (variants && variants.length > 0) {
    const variant = resolveVariantPricing(productRow.productOptions, variants, selectedOptions);
    if (variant) {
      const price = decimalToNumber(variant.price);
      const discountedPrice = decimalToNumber(variant.discountedPrice);
      return discountedPrice != null && discountedPrice < price ? discountedPrice : price;
    }
  }
  const { price, discountedPrice } = regionPriceFromRow(productRow);
  return discountedPrice != null && discountedPrice < price ? discountedPrice : price;
}

function resolveVariantImage(productOptions, selectedOptions, variants) {
  if (
    !selectedOptions ||
    typeof selectedOptions !== 'object' ||
    Array.isArray(selectedOptions) ||
    !Array.isArray(productOptions)
  ) {
    return null;
  }
  // A variant's own photos win — that's the specific box/size the shopper picked.
  const variantMatch = findMatchingVariant(productOptions, variants, selectedOptions);
  const variantImg = variantMatch?.images?.find((u) => u && String(u).trim());
  if (variantImg) return String(variantImg).trim();
  for (const group of productOptions) {
    if (!group) continue;
    const chosen =
      selectedOptions[group.title] ??
      (group.title_ar ? selectedOptions[group.title_ar] : undefined);
    if (!chosen) continue;
    const en = Array.isArray(group.options) ? group.options : [];
    const ar = Array.isArray(group.options_ar) ? group.options_ar : [];
    let idx = en.indexOf(chosen);
    if (idx < 0) idx = ar.indexOf(chosen);
    if (idx < 0) continue;
    const set = Array.isArray(group.optionImageSets) ? group.optionImageSets[idx] : null;
    const fromSet = Array.isArray(set) ? set.find((u) => u && String(u).trim()) : null;
    const single = Array.isArray(group.optionImages) ? group.optionImages[idx] : null;
    const img = String(fromSet || single || '').trim();
    if (img) return img;
  }
  return null;
}

module.exports = {
  createProduct,
  updateProduct,
  deleteProduct,
  reorderProducts,
  getAllProducts,
  getProductsByCategory,
  getBestSellers,
  getBestSellingProductIds,
  getNewArrivals,
  searchProducts,
  getProductById,
  mapProduct,
  applyRegionCurrency,
  regionPriceFromRow,
  optionExtraCharge,
  resolveVariantImage,
  resolveVariantPricing,
  resolveEffectivePrice,
  variantPriceRange,
  decimalToNumber,
  attachResolvedDeliveryLeadDays,
};
