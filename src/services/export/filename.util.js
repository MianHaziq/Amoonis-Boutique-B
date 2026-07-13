/**
 * Professional, human-meaningful export filenames (used to set
 * Content-Disposition on the export responses) instead of a bare timestamp.
 *   Orders:    Orders_2026-07-13_09-40.xlsx        (generation date + time)
 *   Analytics: Analytics_June_2026.xlsx            (month preset)
 *              Analytics_Last7Days.pdf             (week preset)
 *              Analytics_2026-06-01_to_2026-06-30.csv  (custom range)
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad(n) {
  return String(n).padStart(2, '0');
}

function stamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

/** Strip anything that isn't filename-safe. */
function safe(part) {
  return String(part).replace(/[^A-Za-z0-9_.-]/g, '');
}

function ordersFilename(format, now = new Date()) {
  return safe(`Orders_${stamp(now)}`) + `.${format}`;
}

/**
 * @param {string} format
 * @param {{ preset?: string|null, from?: string|null, to?: string|null }} range
 * @param {Date} [now]
 */
function analyticsFilename(format, range = {}, now = new Date()) {
  const { preset, from, to } = range;
  let label;
  if (from && to) {
    label = `${String(from).slice(0, 10)}_to_${String(to).slice(0, 10)}`;
  } else {
    switch (preset) {
      case 'today':
        label = 'Today';
        break;
      case 'week':
        label = 'Last7Days';
        break;
      case 'month':
        label = `${MONTHS[now.getUTCMonth()]}_${now.getUTCFullYear()}`;
        break;
      case 'year':
        label = String(now.getUTCFullYear());
        break;
      case 'all_time':
        label = 'AllTime';
        break;
      default:
        label = stamp(now);
    }
  }
  return safe(`Analytics_${label}`) + `.${format}`;
}

module.exports = { ordersFilename, analyticsFilename };
