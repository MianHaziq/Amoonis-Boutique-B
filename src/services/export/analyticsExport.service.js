/**
 * Data-gathering layer for the Analytics Export feature (Excel + PDF). Composes
 * the existing analytics.service.js functions (same range/preset resolution,
 * same "excludes cancelled orders" rule as the on-screen dashboard) plus the
 * two new gap-filling ones (product sales, inventory) into one payload.
 */

const analyticsService = require('../analytics.service');

/** Groups a daily-sales point series into ISO week buckets — a presentational
 * rollup only; no new backend analytics primitive needed for "revenue by week". */
function rollupToWeeks(dailyPoints) {
  const weeks = new Map();
  for (const p of dailyPoints) {
    const d = new Date(p.date + 'T00:00:00.000Z');
    // ISO week start (Monday) — dayOfWeek: Sun=0..Sat=6, shift so Monday=0.
    const dayOfWeek = (d.getUTCDay() + 6) % 7;
    const weekStart = new Date(d.getTime() - dayOfWeek * 86400000);
    const key = weekStart.toISOString().slice(0, 10);
    const existing = weeks.get(key) || { weekStart: key, netOrderCount: 0, netRevenue: 0 };
    existing.netOrderCount += p.netOrderCount;
    existing.netRevenue += p.netRevenue;
    weeks.set(key, existing);
  }
  return [...weeks.values()]
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map((w) => ({ ...w, netRevenue: Math.round(w.netRevenue * 100) / 100 }));
}

/**
 * @param {{ preset?: string, from?: string, to?: string, region?: string }} params
 */
async function getAnalyticsForExport(params = {}) {
  const [revenue, kpi, category, dailySales, products, inventory, orderInsights] = await Promise.all([
    analyticsService.getRevenueAnalytics(params),
    analyticsService.getKpiAnalytics(params),
    analyticsService.getCategorySalesAnalytics(params),
    analyticsService.getDailySalesAnalytics(params),
    analyticsService.getProductSalesAnalytics({ ...params, limit: 10 }),
    analyticsService.getInventoryAnalytics(),
    analyticsService.getOrderInsights(params),
  ]);

  // Any range-resolution error (bad preset / bad from-to) surfaces from every
  // range-scoped call identically — the first one found is the reported error.
  const rangeError = [revenue, kpi, category, dailySales, products, orderInsights].find((r) => r?.error)?.error;
  if (rangeError) return { error: rangeError };

  // getDailySalesAnalytics returns MONTHLY points (not daily) when the resolved
  // window is all_time (bounded response) — weekly/monthly rollups only make
  // sense to derive from genuinely daily points.
  const isDailyGranularity = dailySales.granularity === 'day';
  const weeklySales = isDailyGranularity ? rollupToWeeks(dailySales.points) : [];
  const monthlySales = isDailyGranularity
    ? Object.values(
        dailySales.points.reduce((acc, p) => {
          const month = p.date.slice(0, 7);
          acc[month] = acc[month] || { month, netOrderCount: 0, netRevenue: 0 };
          acc[month].netOrderCount += p.netOrderCount;
          acc[month].netRevenue += p.netRevenue;
          return acc;
        }, {})
      ).map((m) => ({ ...m, netRevenue: Math.round(m.netRevenue * 100) / 100 }))
    : dailySales.points.map((p) => ({ month: p.month, netOrderCount: p.netOrderCount, netRevenue: p.netRevenue }));

  // REFUNDED is a real, tracked OrderStatus (kpi.byStatus.REFUNDED) — merged in here
  // alongside CANCELLED (which lives in a separate top-level `kpi.cancelled` field,
  // not `kpi.byStatus`) so this export sees every status bucket in one object.
  const orderStatusCounts = {
    ...kpi.byStatus,
    CANCELLED: kpi.cancelled,
  };

  return {
    error: null,
    preset: revenue.preset,
    presetLabel: revenue.presetLabel,
    currency: revenue.currency,
    range: revenue.range,
    revenue,
    kpi,
    category,
    dailySales: dailySales.points,
    weeklySales,
    monthlySales,
    products,
    inventory,
    orderInsights,
    orderStatusCounts,
  };
}

module.exports = { getAnalyticsForExport, rollupToWeeks };
