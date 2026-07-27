/**
 * Delivery configuration resolution — the single source of truth for how a region's and
 * a zone's delivery settings combine into the values the storefront and checkout use.
 *
 * Resolution rule for fields that exist at BOTH levels:
 *     zone value (if set)  ->  region value (if set)  ->  built-in default
 * mirroring the existing deliveryLeadDays chain. Zone booleans are nullable (null =
 * inherit); zone arrays use empty = inherit. City-only: blackout dates. Zone-only: time
 * slots, min/max order.
 *
 * The resolver is a PURE function (inject `now` for tests). A thin prisma loader is
 * provided for callers that only have ids/codes.
 */

const prisma = require('../config/db');
const {
  DEFAULT_TIMEZONE,
  todayKeyInTz,
  nowMinutesInTz,
  weekdayOfKey,
  addDaysToKey,
  parseHHmm,
} = require('../utils/businessTime');

/** Prisma Decimal | number | string | null -> number | null. */
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** zone value wins when set; else region; else fallback. Empty string counts as "unset"
 *  (a string field like sameDayCutoff cleared to "" must inherit, not blank out). */
function inherit(zoneVal, regionVal, fallback = null) {
  if (zoneVal !== null && zoneVal !== undefined && zoneVal !== '') return zoneVal;
  if (regionVal !== null && regionVal !== undefined && regionVal !== '') return regionVal;
  return fallback;
}

/** A day is deliverable if its weekday is allowed (empty list = all allowed) and it is
 *  not a blackout date. */
function isDeliverableDay(key, deliveryDays, blackoutSet) {
  if (blackoutSet.has(key)) return false;
  if (Array.isArray(deliveryDays) && deliveryDays.length > 0) {
    return deliveryDays.includes(weekdayOfKey(key));
  }
  return true;
}

/** First deliverable day at/after `fromKey` (caps the search so an impossible config
 *  can never loop forever). Returns null if none within a year. */
function nextDeliverableKey(fromKey, deliveryDays, blackoutSet) {
  let key = fromKey;
  for (let i = 0; i < 366; i += 1) {
    if (isDeliverableDay(key, deliveryDays, blackoutSet)) return key;
    key = addDaysToKey(key, 1);
  }
  return null;
}

/**
 * Resolve the effective delivery config for a (region, zone) pair.
 *
 * @param {object}   region        Region row (may include `blackoutDates` relation).
 * @param {object|null} zone       DeliveryZone row (may include `timeSlots` relation), or null.
 * @param {object}   opts
 * @param {number|null} opts.subtotal   Net order subtotal, for free-delivery + min/max checks.
 * @param {Date}     [opts.now]         Injected clock (tests).
 * @param {Array}    [opts.blackoutDates] Explicit blackout rows (else read region.blackoutDates).
 * @param {Array}    [opts.timeSlots]     Explicit slot rows (else read zone.timeSlots).
 */
function resolveDeliveryConfig(region, zone, opts = {}) {
  const { subtotal = null, now = new Date() } = opts;
  const r = region || {};
  const z = zone || {};

  const timezone = r.timezone || DEFAULT_TIMEZONE;

  const deliveryFee = inherit(toNum(z.shippingFlatRate), toNum(r.shippingFlatRate), 0);
  const freeDeliveryThreshold = inherit(toNum(z.freeDeliveryThreshold), toNum(r.freeDeliveryThreshold), null);
  const sameDayEnabled = !!inherit(z.sameDayEnabled, r.sameDayEnabled, false);
  const sameDayCutoff = inherit(z.sameDayCutoff, r.sameDayCutoff, null);
  const standardLeadDays = inherit(z.standardLeadDays, r.standardDeliveryDays, null);
  const codEnabled = !!inherit(z.codEnabled, r.codEnabled, true);
  const minOrderAmount = toNum(z.minOrderAmount);
  const maxOrderAmount = toNum(z.maxOrderAmount);
  const deliveryDays =
    Array.isArray(z.deliveryDays) && z.deliveryDays.length > 0
      ? z.deliveryDays
      : Array.isArray(r.deliveryDays)
        ? r.deliveryDays
        : [];

  const blackoutRows = opts.blackoutDates ?? r.blackoutDates ?? [];
  const blackoutDates = blackoutRows.map((b) => (typeof b === 'string' ? b : b.date));
  const blackoutSet = new Set(blackoutDates);

  // --- free-delivery / effective fee ---
  const freeDeliveryApplied =
    freeDeliveryThreshold != null && subtotal != null && subtotal >= freeDeliveryThreshold;
  const effectiveFee = freeDeliveryApplied ? 0 : deliveryFee;

  // --- same-day availability (in the region's local clock) ---
  const todayKey = todayKeyInTz(timezone, now);
  const cutoffMin = parseHHmm(sameDayCutoff);
  const nowMin = nowMinutesInTz(timezone, now);
  const todayDeliverable = isDeliverableDay(todayKey, deliveryDays, blackoutSet);
  const sameDayAvailableNow =
    sameDayEnabled && todayDeliverable && (cutoffMin === null || nowMin < cutoffMin);

  // --- earliest schedulable day ---
  // Same-day when available; otherwise at least the lead time out (min 1 day), then the
  // next day that is an allowed weekday and not a blackout.
  const minLead = standardLeadDays != null ? standardLeadDays : 0;
  const earliestBase = sameDayAvailableNow ? todayKey : addDaysToKey(todayKey, Math.max(minLead, 1));
  const earliestDeliveryKey = nextDeliverableKey(earliestBase, deliveryDays, blackoutSet);

  return {
    timezone,
    currency: r.currency ?? null,
    deliveryFee,
    freeDeliveryThreshold,
    effectiveFee,
    freeDeliveryApplied,
    deliveryDays,
    sameDayEnabled,
    sameDayCutoff,
    standardLeadDays,
    codEnabled,
    minOrderAmount,
    maxOrderAmount,
    blackoutDates,
    // computed
    todayKey,
    sameDayAvailableNow,
    earliestDeliveryKey,
  };
}

/**
 * Load region (+ blackout dates) and zone (+ time slots) then resolve. `regionRef` may be
 * a region id or code; `zoneId` optional.
 */
async function loadAndResolve({ regionRef, zoneId = null, subtotal = null, now = new Date() }) {
  if (!regionRef) return null;
  const region = await prisma.region.findFirst({
    where: { OR: [{ id: String(regionRef) }, { code: String(regionRef).toUpperCase() }] },
    include: { blackoutDates: true },
  });
  if (!region) return null;

  let zone = null;
  if (zoneId) {
    zone = await prisma.deliveryZone.findFirst({
      where: { id: String(zoneId), regionId: region.id },
    });
  }
  return { region, zone, config: resolveDeliveryConfig(region, zone, { subtotal, now }) };
}

module.exports = {
  resolveDeliveryConfig,
  loadAndResolve,
  isDeliverableDay,
  nextDeliverableKey,
};
