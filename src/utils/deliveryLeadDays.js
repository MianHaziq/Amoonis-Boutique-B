/**
 * Shared "delivery days" resolution — the SINGLE source of truth for how many days a
 * product takes to arrive. Used by Settings, Category, Product (admin CRUD + public
 * serialization) and Order creation. Reuse `resolveDeliveryLeadDays` everywhere; never
 * re-implement the precedence.
 *
 * MODEL (deliberate, see resolveDeliveryLeadDays below): ONE unified fallback chain, most
 * specific wins, and a product/category delivery time FULLY OVERRIDES the area's standard
 * lead — even when smaller. It is NOT max'd with a separate courier-transit number. The
 * area "standard" (DeliveryZone.standardLeadDays, then Region.standardDeliveryDays) is just
 * the default delivery time used when no product/category value applies. Precedence:
 *   productZone ?? productRegion ?? product
 *     ?? categoryZone ?? categoryRegion ?? category
 *     ?? zoneStandard ?? regionStandard
 *     ?? settings.defaultDeliveryLeadDays
 *
 * (Historical note: an earlier version treated this purely as PREP time and did
 * `max(prep, region.standardDeliveryDays)` at checkout. That max is GONE — do not restore
 * it; the override-wins behavior above is intentional.)
 */
const prisma = require('../config/db');

const MIN_DELIVERY_LEAD_DAYS = 0;
const MAX_DELIVERY_LEAD_DAYS = 30;

/**
 * Validates an optional deliveryLeadDays override (Category.deliveryLeadDays,
 * Product.deliveryLeadDays, or Settings.defaultDeliveryLeadDays input). Mirrors
 * region.service.js's parseStandardDeliveryDays style exactly:
 *   - null/undefined/'' -> null (no override / "clear it")
 *   - otherwise must be a whole number in [MIN_DELIVERY_LEAD_DAYS, MAX_DELIVERY_LEAD_DAYS]
 * Throws a tagged { code: 'VALIDATION' } error (never lets a bad value reach Prisma).
 */
function parseDeliveryLeadDays(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_DELIVERY_LEAD_DAYS || n > MAX_DELIVERY_LEAD_DAYS) {
    throw Object.assign(
      new Error(`deliveryLeadDays must be a whole number between ${MIN_DELIVERY_LEAD_DAYS} and ${MAX_DELIVERY_LEAD_DAYS}`),
      { code: 'VALIDATION' }
    );
  }
  return n;
}

/**
 * The ONE unified delivery-days resolution chain. The MOST SPECIFIC setting wins, and a
 * specific product/category "delivery time" fully OVERRIDES the area's standard lead (even
 * if smaller) — this is a deliberate business rule (a product/category delivery time IS its
 * promised time, not merely prep to be max'd with transit). Precedence, highest → lowest:
 *   productZone ?? productRegion ?? product
 *     ?? categoryZone ?? categoryRegion ?? category
 *     ?? zoneStandard ?? regionStandard
 *     ?? default
 * Always returns a number (never null): callers resolve `defaultLeadDays` via
 * getDefaultDeliveryLeadDays() as the final floor. Every param defaults to null, so a caller
 * that doesn't know a zone (or region) simply skips those tiers. `zoneStandardLeadDays` is
 * DeliveryZone.standardLeadDays and `regionStandardLeadDays` is Region.standardDeliveryDays —
 * the area's default delivery time, used only when no product/category override applies.
 */
function resolveDeliveryLeadDays({
  productZoneLeadDays = null,
  productRegionLeadDays = null,
  productLeadDays = null,
  categoryZoneLeadDays = null,
  categoryRegionLeadDays = null,
  categoryLeadDays = null,
  zoneStandardLeadDays = null,
  regionStandardLeadDays = null,
  defaultLeadDays = 1,
} = {}) {
  if (productZoneLeadDays != null) return productZoneLeadDays;
  if (productRegionLeadDays != null) return productRegionLeadDays;
  if (productLeadDays != null) return productLeadDays;
  if (categoryZoneLeadDays != null) return categoryZoneLeadDays;
  if (categoryRegionLeadDays != null) return categoryRegionLeadDays;
  if (categoryLeadDays != null) return categoryLeadDays;
  if (zoneStandardLeadDays != null) return zoneStandardLeadDays;
  if (regionStandardLeadDays != null) return regionStandardLeadDays;
  return defaultLeadDays ?? 1;
}

// In-process cache for Settings.defaultDeliveryLeadDays: it's read on nearly every
// product-list/order-creation request but changes rarely (admin-edited settings), so a
// short TTL cache avoids a Settings round trip per request without needing a bespoke
// cache-invalidation channel across processes. invalidateDefaultDeliveryLeadDaysCache()
// below clears it immediately in-process when the admin PUT actually changes the value;
// the short TTL is just a safety net for other worker/API processes.
let cachedDefault = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

/** Fetch Settings.defaultDeliveryLeadDays once (cached briefly) — call this ONCE per
 *  request, never once per product, then pass the number into resolveDeliveryLeadDays. */
async function getDefaultDeliveryLeadDays() {
  const now = Date.now();
  if (cachedDefault != null && now - cachedAt < CACHE_TTL_MS) return cachedDefault;
  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: { defaultDeliveryLeadDays: true },
  });
  cachedDefault = settings?.defaultDeliveryLeadDays ?? 1;
  cachedAt = now;
  return cachedDefault;
}

/** Call after Settings.defaultDeliveryLeadDays is written so subsequent reads in THIS
 *  process see the new value immediately instead of waiting out the TTL. */
function invalidateDefaultDeliveryLeadDaysCache() {
  cachedDefault = null;
  cachedAt = 0;
}

module.exports = {
  MIN_DELIVERY_LEAD_DAYS,
  MAX_DELIVERY_LEAD_DAYS,
  parseDeliveryLeadDays,
  resolveDeliveryLeadDays,
  getDefaultDeliveryLeadDays,
  invalidateDefaultDeliveryLeadDaysCache,
};
