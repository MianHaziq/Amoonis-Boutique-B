/**
 * Shared "ships within N day(s)" PREP/BOOKING lead-time helpers, used by Settings,
 * Category, Product (admin CRUD + public serialization) and Order creation.
 *
 * This is a DIFFERENT concept from Region.standardDeliveryDays (courier/regional
 * transit time — see region.service.js's parseStandardDeliveryDays). This one is how
 * long the PRODUCT ITSELF takes to prepare/book before it can even ship (e.g. flowers
 * need 2 days prep, gift boxes need 1 day). The two are combined via Math.max (not
 * summed — the longer of "courier transit" and "product prep" governs) at checkout
 * time to produce the customer-facing estimate for STANDARD orders (see order.service.js).
 *
 * Resolution chain (single source of truth — reuse this everywhere, never re-implement):
 *   resolvedLeadDays = product.deliveryLeadDays ?? category.deliveryLeadDays ?? settings.defaultDeliveryLeadDays
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
 * The ONE resolution chain: product override wins, then category override, then the
 * global Settings default. Always returns a number (never null) — callers should have
 * already resolved `defaultLeadDays` via getDefaultDeliveryLeadDays() below so there's
 * always a fallback.
 */
function resolveDeliveryLeadDays({ productLeadDays = null, categoryLeadDays = null, defaultLeadDays = 1 } = {}) {
  if (productLeadDays != null) return productLeadDays;
  if (categoryLeadDays != null) return categoryLeadDays;
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
