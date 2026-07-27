/**
 * Timezone-aware "business day" helpers.
 *
 * Every delivery day-boundary decision (same-day cutoff, "today", allowed weekday,
 * blackout date) must be computed in the REGION's local timezone — never the server
 * process clock (UTC on Railway) nor the customer's device. A container's default TZ is
 * UTC, 3-4h behind the Gulf; computing "start of day" from raw server time would let a
 * customer near midnight look like they're on a different calendar day than Dubai/Riyadh.
 *
 * All functions take an explicit IANA `timeZone` (e.g. "Asia/Dubai") so the same code
 * serves any region. Date-only values are handled as tz-neutral "YYYY-MM-DD" string keys
 * (matching the storefront DeliveryDatePicker), so they never drift across zones.
 */

const DEFAULT_TIMEZONE = process.env.JOBS_TIMEZONE || 'Asia/Dubai';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** UTC offset (minutes) of `timeZone` at the instant `date`, via Intl — DST-aware for
 *  any IANA zone, not just fixed-offset ones. */
function tzOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = Number(p.value);
    return acc;
  }, {});
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (asUTC - date.getTime()) / 60000;
}

/** The wall-clock calendar/time parts of `date` as seen in `timeZone`. */
function zonedParts(date, timeZone) {
  const offsetMin = tzOffsetMinutes(date, timeZone);
  const zoned = new Date(date.getTime() + offsetMin * 60000);
  return {
    year: zoned.getUTCFullYear(),
    month0: zoned.getUTCMonth(),
    day: zoned.getUTCDate(),
    hour: zoned.getUTCHours(),
    minute: zoned.getUTCMinutes(),
    weekday: zoned.getUTCDay(), // 0=Sun..6=Sat
    offsetMin,
  };
}

/** UTC instant of local midnight, `daysFromNow` out, on the calendar in `timeZone`. */
function startOfBusinessDay(daysFromNow, timeZone = DEFAULT_TIMEZONE, now = new Date()) {
  const p = zonedParts(now, timeZone);
  return new Date(Date.UTC(p.year, p.month0, p.day + daysFromNow) - p.offsetMin * 60000);
}

/** "YYYY-MM-DD" calendar-date key of `date` as seen in `timeZone`. */
function dateKeyInTz(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad2(p.month0 + 1)}-${pad2(p.day)}`;
}

/** Today's "YYYY-MM-DD" key in `timeZone`. */
function todayKeyInTz(timeZone = DEFAULT_TIMEZONE, now = new Date()) {
  return dateKeyInTz(now, timeZone);
}

/** Minutes since local midnight of "now" in `timeZone` (for cutoff comparisons). */
function nowMinutesInTz(timeZone = DEFAULT_TIMEZONE, now = new Date()) {
  const p = zonedParts(now, timeZone);
  return p.hour * 60 + p.minute;
}

/** Weekday (0=Sun..6=Sat) of a "YYYY-MM-DD" key — pure calendar math, tz-neutral. */
function weekdayOfKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "YYYY-MM-DD" key `n` days after `key`. */
function addDaysToKey(key, n) {
  const [y, m, d] = String(key).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** Whole-day difference `toKey - fromKey` (calendar days, tz-neutral). */
function daysBetweenKeys(fromKey, toKey) {
  const [ay, am, ad] = String(fromKey).split('-').map(Number);
  const [by, bm, bd] = String(toKey).split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/** Parse "HH:mm" -> minutes since midnight, or null if malformed. */
function parseHHmm(value) {
  if (value == null) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** True if `value` is a valid "HH:mm" 24h time string. */
function isValidHHmm(value) {
  return parseHHmm(value) !== null;
}

/** True if `value` is a valid "YYYY-MM-DD" calendar date. */
function isValidDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

module.exports = {
  DEFAULT_TIMEZONE,
  tzOffsetMinutes,
  zonedParts,
  startOfBusinessDay,
  dateKeyInTz,
  todayKeyInTz,
  nowMinutesInTz,
  weekdayOfKey,
  addDaysToKey,
  daysBetweenKeys,
  parseHHmm,
  isValidHHmm,
  isValidDateKey,
};
