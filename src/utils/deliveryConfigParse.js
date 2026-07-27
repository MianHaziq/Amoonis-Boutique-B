/**
 * Shared parsers/validators for the delivery-config fields that appear on BOTH Region and
 * DeliveryZone (fee, threshold, days, cutoff, same-day, cod, lead) plus the zone-only
 * (min/max, time slots) and region-only (timezone, blackout dates) fields. Centralised so
 * region.service and deliveryZone.service validate identically. All throw a
 * `{ code: 'VALIDATION' }` Error on bad input, matching the existing service convention.
 */

const { isValidHHmm, isValidDateKey } = require('./businessTime');

function fail(message) {
  throw Object.assign(new Error(message), { code: 'VALIDATION' });
}

/** '' / null / undefined -> null; else a non-negative money number (2dp domain). */
function parseMoneyOrNull(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail(`${field} must be a non-negative number`);
  return Math.round(n * 100) / 100;
}

/** '' / null / undefined -> null; else a whole number of days in [0, max]. */
function parseWholeDaysOrNull(value, field, max = 90) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) fail(`${field} must be a whole number between 0 and ${max}`);
  return n;
}

/** Array of unique weekday ints 0..6. Non-array / empty -> []  ([] = "inherit / all days"). */
function parseDeliveryDays(value, field = 'deliveryDays') {
  if (value === null || value === undefined || value === '') return [];
  if (!Array.isArray(value)) fail(`${field} must be an array of weekday numbers (0-6)`);
  const out = [];
  for (const raw of value) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 6) fail(`${field} entries must be integers 0 (Sun) to 6 (Sat)`);
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** '' / null / undefined -> null (inherit); else strict boolean. */
function parseNullableBool(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return !!value;
}

/** Strict boolean with a default when unset. */
function parseBool(value, dflt) {
  if (value === null || value === undefined || value === '') return dflt;
  return parseNullableBool(value);
}

/** '' / null / undefined -> null; else a validated "HH:mm" string. */
function parseHHmmOrNull(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (!isValidHHmm(s)) fail(`${field} must be a valid 24h time "HH:mm"`);
  return s;
}

// Cache the IANA zone list once (Node 18+). Fallback keeps validation lenient if the
// runtime lacks Intl.supportedValuesOf.
let TZ_SET = null;
function tzSet() {
  if (TZ_SET) return TZ_SET;
  try {
    TZ_SET = new Set(Intl.supportedValuesOf('timeZone'));
  } catch {
    TZ_SET = null;
  }
  return TZ_SET;
}

/** Validate an IANA timezone. Empty -> the provided default. */
function parseTimezone(value, dflt = 'Asia/Dubai') {
  if (value === null || value === undefined || value === '') return dflt;
  const s = String(value).trim();
  const set = tzSet();
  if (set && !set.has(s)) fail(`timezone must be a valid IANA timezone (e.g. "Asia/Dubai")`);
  if (!set && !/^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$/.test(s)) fail('timezone must look like "Area/City"');
  return s;
}

/**
 * Clean a blackout-dates array into rows ready for a nested create. Dedupes by date.
 * @returns {{date,label,label_ar}[]}
 */
function parseBlackoutDates(value) {
  if (value === null || value === undefined || value === '') return [];
  if (!Array.isArray(value)) fail('blackoutDates must be an array');
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const date = String(raw?.date ?? raw ?? '').trim();
    if (!isValidDateKey(date)) fail(`blackout date "${date}" must be "YYYY-MM-DD"`);
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({
      date,
      label: raw?.label != null ? String(raw.label).trim() || null : null,
      label_ar: raw?.label_ar != null ? String(raw.label_ar).trim() || null : null,
    });
  }
  return out;
}

/** min/max order pair sanity: both optional, but if both set, min <= max. */
function assertMinMaxOrder(min, max) {
  if (min != null && max != null && min > max) {
    fail('minOrderAmount cannot be greater than maxOrderAmount');
  }
}

module.exports = {
  parseMoneyOrNull,
  parseWholeDaysOrNull,
  parseDeliveryDays,
  parseNullableBool,
  parseBool,
  parseHHmmOrNull,
  parseTimezone,
  parseBlackoutDates,
  assertMinMaxOrder,
};
