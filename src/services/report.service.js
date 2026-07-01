/**
 * Reporting service — builds the data for the scheduled admin emails (daily stock,
 * weekly + monthly sales). Pure data assembly: it reuses analytics.service for the
 * heavy aggregation and queries products/admins directly; rendering lives in
 * src/emails/templates.js and delivery in the email.send job.
 *
 * All sales windows are computed as whole, already-completed calendar periods using
 * UTC day boundaries (matching analytics.service, which aggregates in UTC). The cron
 * fires in JOBS_TIMEZONE (Asia/Dubai) but the *window* is UTC — consistent with what
 * the admin dashboard shows.
 */

const prisma = require('../config/db');
const analytics = require('./analytics.service');

const DAY_MS = 86_400_000;

/* --------------------------------- recipients -------------------------------- */

/**
 * Every active ADMIN's email. Falls back to CONTACT_EMAIL/FROM_EMAIL if there are no
 * admins (e.g. fresh install) so reports are never silently dropped.
 */
async function getAdminRecipients() {
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', status: 'ACTIVE' },
    select: { email: true },
  });
  const emails = admins.map((a) => a.email).filter(Boolean);
  if (emails.length) return [...new Set(emails)];

  const fallback = process.env.CONTACT_EMAIL || process.env.FROM_EMAIL;
  return fallback ? [fallback] : [];
}

/* ------------------------------- date helpers -------------------------------- */

/** Midnight UTC of the day `d` falls in. */
function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** 'YYYY-MM-DD' for a Date (UTC) — the format analytics.parseCustomRange expects. */
function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Last completed week (Mon..Sun) relative to `now`. analytics treats `to` as inclusive,
 * so we pass the Sunday. Returns the current and the week-before window for comparison.
 */
function lastWeekRanges(now = new Date()) {
  const today = startOfUtcDay(now);
  const dow = today.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7; // Mon->0, Sun->6
  const thisMonday = new Date(today.getTime() - daysSinceMonday * DAY_MS);
  const lastMonday = new Date(thisMonday.getTime() - 7 * DAY_MS);
  const lastSunday = new Date(thisMonday.getTime() - DAY_MS);
  const prevMonday = new Date(lastMonday.getTime() - 7 * DAY_MS);
  const prevSunday = new Date(lastMonday.getTime() - DAY_MS);
  return {
    from: isoDay(lastMonday),
    to: isoDay(lastSunday),
    prevFrom: isoDay(prevMonday),
    prevTo: isoDay(prevSunday),
    label: `${isoDay(lastMonday)} – ${isoDay(lastSunday)}`,
    comparisonLabel: `${isoDay(prevMonday)} – ${isoDay(prevSunday)}`,
  };
}

/** Last completed calendar month relative to `now`, plus the month before for comparison. */
function lastMonthRanges(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // current month index
  const lastStart = new Date(Date.UTC(y, m - 1, 1));
  const lastEnd = new Date(Date.UTC(y, m, 1) - DAY_MS); // last day of previous month
  const prevStart = new Date(Date.UTC(y, m - 2, 1));
  const prevEnd = new Date(Date.UTC(y, m - 1, 1) - DAY_MS);
  const monthName = lastStart.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const prevName = prevStart.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return {
    from: isoDay(lastStart),
    to: isoDay(lastEnd),
    prevFrom: isoDay(prevStart),
    prevTo: isoDay(prevEnd),
    label: monthName,
    comparisonLabel: prevName,
  };
}

/* ------------------------------- sales report -------------------------------- */

function pctChange(current, previous) {
  if (previous == null || previous === 0) return current ? null : 0; // null = no baseline ("new")
  return ((current - previous) / previous) * 100;
}

/**
 * Build a sales report for a window, with percentage deltas vs the prior equal window.
 * @param {object} opts - { from, to, prevFrom, prevTo, title, periodLabel, comparisonLabel }
 * @returns report object consumed by templates.renderSalesReport
 */
async function buildSalesReport(opts) {
  const { from, to, prevFrom, prevTo, title, periodLabel, comparisonLabel } = opts;

  const [kpi, prevKpi, categories] = await Promise.all([
    analytics.getKpiAnalytics({ from, to }),
    analytics.getKpiAnalytics({ from: prevFrom, to: prevTo }),
    analytics.getCategorySalesAnalytics({ from, to }).catch(() => null),
  ]);

  if (kpi.error) throw new Error(`analytics KPI failed: ${kpi.error}`);

  const cur = kpi.totals;
  const prev = prevKpi.error ? {} : prevKpi.totals;

  const deltas = {
    netRevenue: pctChange(cur.netRevenue, prev.netRevenue),
    netSalesCount: pctChange(cur.netSalesCount, prev.netSalesCount),
    unitsSold: pctChange(cur.unitsSold, prev.unitsSold),
    averageOrderValue: pctChange(cur.averageOrderValue, prev.averageOrderValue),
    distinctCustomers: pctChange(cur.distinctCustomers, prev.distinctCustomers),
  };

  // getCategorySalesAnalytics returns ranked categories; shape tolerated defensively.
  const topCategories = (categories?.categories || categories?.rows || categories?.data || [])
    .map((c) => ({
      categoryTitle: c.categoryTitle || c.title || c.name,
      revenue: c.revenue,
      unitsSold: c.unitsSold,
    }))
    .slice(0, 5);

  return {
    title,
    periodLabel,
    comparisonLabel,
    currency: kpi.currency || 'AED',
    current: cur,
    deltas,
    byStatus: kpi.byStatus || {},
    topCategories,
  };
}

async function buildWeeklyReport(now = new Date()) {
  const r = lastWeekRanges(now);
  return buildSalesReport({
    ...r,
    title: 'Weekly sales report',
    periodLabel: `Week of ${r.label}`,
    comparisonLabel: r.comparisonLabel,
  });
}

async function buildMonthlyReport(now = new Date()) {
  const r = lastMonthRanges(now);
  return buildSalesReport({
    ...r,
    title: 'Monthly sales report',
    periodLabel: r.label,
    comparisonLabel: r.comparisonLabel,
  });
}

/* ------------------------------- stock report -------------------------------- */

/** Published products at/under the low-stock threshold (zero-stock first via qty asc). */
async function buildStockReport() {
  const threshold = Math.max(0, parseInt(process.env.LOW_STOCK_THRESHOLD || '5', 10));
  const products = await prisma.product.findMany({
    where: { status: 'PUBLISHED', quantity: { lte: threshold } },
    select: { id: true, title: true, quantity: true },
    orderBy: { quantity: 'asc' },
    take: 200,
  });
  return { threshold, products };
}

module.exports = {
  getAdminRecipients,
  buildSalesReport,
  buildWeeklyReport,
  buildMonthlyReport,
  buildStockReport,
  // exported for tests
  lastWeekRanges,
  lastMonthRanges,
};
