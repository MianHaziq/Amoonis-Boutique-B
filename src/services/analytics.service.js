const { Prisma } = require('@prisma/client');
const prisma = require('../config/db');
const regionService = require('./region.service');

// Region id that can never match a row â€” so an unknown region code yields zeroed
// analytics rather than silently falling back to "all regions".
const NO_MATCH_REGION_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Resolve an optional region filter (a region code in params.region) onto the range.
 * No region param => combined ("both / mixed") view across all regions.
 */
async function attachRegionFilter(range, params) {
  const code = params && params.region ? String(params.region).trim() : '';
  if (!code) {
    // No region filter -> combined view across regions with mixed currencies;
    // callers fall back to the store's configured Settings.currency.
    range.regionId = null;
    range.regionCode = null;
    range.currency = null;
    return range;
  }
  const region = await regionService.getRegionByCode(code);
  range.regionId = region ? region.id : NO_MATCH_REGION_ID;
  range.regionCode = region ? region.code : code.toUpperCase();
  // A single region has one unambiguous currency â€” prefer it over the global default.
  range.currency = region?.currency || null;
  return range;
}

/** Allowed date_trunc units (internal only; never pass user input unchecked). */
const ALLOWED_TRUNC = new Set(['hour', 'day', 'week', 'month', 'quarter', 'year']);

const PRESETS = Object.freeze({
  all_time: { trunc: 'month', label: 'All time (no date filter; revenue chart uses monthly buckets)' },
  today: { trunc: 'hour', label: 'Today (UTC, hourly)' },
  last_3_days: { trunc: 'day', label: 'Last 3 calendar days (UTC)' },
  week: { trunc: 'day', label: 'Last 7 days (UTC)' },
  month: { trunc: 'day', label: 'Current calendar month (UTC, daily)' },
  last_3_months: { trunc: 'month', label: 'Last 3 calendar months (UTC)' },
  last_6_months: { trunc: 'month', label: 'Last 6 calendar months (UTC)' },
  year: { trunc: 'month', label: 'Current calendar year (UTC, monthly)' },
  last_3_years: { trunc: 'year', label: 'Last 3 calendar years (UTC)' },
});

const MAX_CUSTOM_RANGE_DAYS = 366 * 4; // cap ad-hoc ranges (~4y) for performance

function num(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addUtcMonths(date, delta) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + delta;
  return new Date(Date.UTC(y, m, 1));
}

function addUtcDays(date, days) {
  const x = new Date(date.getTime());
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

/**
 * @param {string} preset
 * @returns {{ from: Date, toExclusive: Date, trunc: string, label: string }}
 */
function resolvePresetRange(preset) {
  if (preset === 'all_time') {
    return {
      from: null,
      toExclusive: null,
      trunc: PRESETS.all_time.trunc,
      label: PRESETS.all_time.label,
      isAllTime: true,
    };
  }

  const now = new Date();
  const todayStart = startOfUtcDay(now);
  const def = PRESETS[preset];
  if (!def) throw new Error('INVALID_PRESET');

  let from;
  let toExclusive;

  switch (preset) {
    case 'today':
      from = todayStart;
      toExclusive = addUtcDays(todayStart, 1);
      break;
    case 'last_3_days':
      from = addUtcDays(todayStart, -2);
      toExclusive = addUtcDays(todayStart, 1);
      break;
    case 'week':
      from = addUtcDays(todayStart, -6);
      toExclusive = addUtcDays(todayStart, 1);
      break;
    case 'month':
      from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      toExclusive = addUtcMonths(from, 1);
      break;
    case 'last_3_months': {
      const curMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      from = addUtcMonths(curMonthStart, -2);
      toExclusive = addUtcMonths(curMonthStart, 1);
      break;
    }
    case 'last_6_months': {
      const curMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      from = addUtcMonths(curMonthStart, -5);
      toExclusive = addUtcMonths(curMonthStart, 1);
      break;
    }
    case 'year':
      from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      toExclusive = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
      break;
    case 'last_3_years':
      from = new Date(Date.UTC(now.getUTCFullYear() - 2, 0, 1));
      toExclusive = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
      break;
    default:
      throw new Error('INVALID_PRESET');
  }

  return { from, toExclusive, trunc: def.trunc, label: def.label, isAllTime: false };
}

/**
 * @param {string} [fromIso]
 * @param {string} [toIso]
 * @returns {{ from: Date, toExclusive: Date } | { error: string }}
 */
function parseCustomRange(fromIso, toIso) {
  if (!fromIso || !toIso) return { error: 'Custom range requires both from and to (ISO 8601 dates)' };
  const from = new Date(fromIso);
  const toEnd = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(toEnd.getTime())) {
    return { error: 'Invalid from or to date' };
  }
  const fromDay = startOfUtcDay(from);
  const toDay = startOfUtcDay(toEnd);
  const toExclusive = addUtcDays(toDay, 1);
  if (toExclusive <= fromDay) return { error: 'to must be on or after from' };
  const days = (toExclusive - fromDay) / 86400000;
  if (days > MAX_CUSTOM_RANGE_DAYS) return { error: `Range too large; max ${MAX_CUSTOM_RANGE_DAYS} days` };
  return { from: fromDay, toExclusive };
}

function pickTruncForCustomRange(from, toExclusive) {
  const days = (toExclusive - from) / 86400000;
  if (days <= 2) return 'hour';
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  if (days <= 800) return 'month';
  return 'year';
}

const KPI_SELECT = Prisma.sql`
  COUNT(*)::int AS "totalOrdersAllStatuses",
  COALESCE(SUM("totalAmount"), 0) AS "grossRevenueAllStatuses",
  COUNT(*) FILTER (WHERE status <> 'CANCELLED')::int AS "netOrderCount",
  COALESCE(SUM("totalAmount") FILTER (WHERE status <> 'CANCELLED'), 0) AS "netRevenue",
  COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS "cancelledCount",
  COALESCE(SUM("totalAmount") FILTER (WHERE status = 'CANCELLED'), 0) AS "cancelledRevenue",
  COUNT(*) FILTER (WHERE status = 'PENDING')::int AS "pendingCount",
  COALESCE(SUM("totalAmount") FILTER (WHERE status = 'PENDING'), 0) AS "pendingRevenue",
  COUNT(*) FILTER (WHERE status = 'CONFIRMED')::int AS "confirmedCount",
  COALESCE(SUM("totalAmount") FILTER (WHERE status = 'CONFIRMED'), 0) AS "confirmedRevenue",
  COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS "processingCount",
  COALESCE(SUM("totalAmount") FILTER (WHERE status = 'PROCESSING'), 0) AS "processingRevenue",
  COUNT(*) FILTER (WHERE status = 'SHIPPED')::int AS "shippedCount",
  COALESCE(SUM("totalAmount") FILTER (WHERE status = 'SHIPPED'), 0) AS "shippedRevenue",
  COUNT(*) FILTER (WHERE status = 'DELIVERED')::int AS "deliveredCount",
  COALESCE(SUM("totalAmount") FILTER (WHERE status = 'DELIVERED'), 0) AS "deliveredRevenue",
  COUNT(DISTINCT "userId") FILTER (WHERE status <> 'CANCELLED')::int AS "distinctCustomers"
`;

/**
 * Build the Order-scoped WHERE clause for an analytics query from a date range,
 * an optional region filter (range.regionId), and any extra base conditions.
 * Returns Prisma.empty when there is nothing to filter (all-time, all regions).
 *
 * This unifies what used to be hand-duplicated all-time vs dated query branches,
 * and is the single place region scoping is applied across every analytics aggregate.
 *
 * @param {object} range  - { isAllTime, from, toExclusive, regionId? }
 * @param {object} [opts] - { alias?: string, extra?: Prisma.Sql[] }
 */
function buildOrderWhere(range, { alias = '', extra = [] } = {}) {
  const prefix = alias ? `${alias}.` : '';
  const conds = [...extra];
  if (!range.isAllTime) {
    conds.push(Prisma.sql`${Prisma.raw(`${prefix}"createdAt"`)} >= ${range.from}`);
    conds.push(Prisma.sql`${Prisma.raw(`${prefix}"createdAt"`)} < ${range.toExclusive}`);
  }
  if (range.regionId) {
    conds.push(Prisma.sql`${Prisma.raw(`${prefix}"regionId"`)} = ${range.regionId}`);
  }
  if (conds.length === 0) return Prisma.empty;
  return Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}`;
}

/**
 * @param {{ isAllTime: boolean, from: Date | null, toExclusive: Date | null, regionId?: string|null }} range
 */
async function fetchSummary(range) {
  const rows = await prisma.$queryRaw`
    SELECT
      COUNT(*) FILTER (WHERE status <> 'CANCELLED')::int AS "activeOrderCount",
      COALESCE(SUM("totalAmount") FILTER (WHERE status <> 'CANCELLED'), 0) AS "revenue",
      COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS "cancelledOrderCount",
      COALESCE(SUM("totalAmount") FILTER (WHERE status = 'CANCELLED'), 0) AS "cancelledRevenue",
      COUNT(DISTINCT "userId") FILTER (WHERE status <> 'CANCELLED')::int AS "distinctCustomers"
    FROM "Order"
    ${buildOrderWhere(range)}
  `;
  const r = rows[0] || {};
  const revenue = num(r.revenue);
  const activeOrderCount = num(r.activeOrderCount);
  return {
    activeOrderCount,
    revenue,
    averageOrderValue: activeOrderCount > 0 ? Math.round((revenue / activeOrderCount) * 100) / 100 : 0,
    cancelledOrderCount: num(r.cancelledOrderCount),
    cancelledRevenue: num(r.cancelledRevenue),
    distinctCustomers: num(r.distinctCustomers),
  };
}

async function fetchSeries(range, trunc) {
  if (!ALLOWED_TRUNC.has(trunc)) throw new Error('INVALID_TRUNC');
  const truncLiteral = Prisma.raw(`'${trunc}'`);
  return prisma.$queryRaw`
    SELECT
      date_trunc(${truncLiteral}, "createdAt" AT TIME ZONE 'UTC') AS "bucket",
      COUNT(*) FILTER (WHERE status <> 'CANCELLED')::int AS "orderCount",
      COALESCE(SUM("totalAmount") FILTER (WHERE status <> 'CANCELLED'), 0) AS "revenue",
      COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS "cancelledOrderCount",
      COALESCE(SUM("totalAmount") FILTER (WHERE status = 'CANCELLED'), 0) AS "cancelledRevenue"
    FROM "Order"
    ${buildOrderWhere(range)}
    GROUP BY 1
    ORDER BY 1 ASC
  `;
}

async function fetchStatusBreakdown(range) {
  return prisma.$queryRaw`
    SELECT status::text AS "status",
           COUNT(*)::int AS "count",
           COALESCE(SUM("totalAmount"), 0) AS "revenue"
    FROM "Order"
    ${buildOrderWhere(range)}
    GROUP BY status
    ORDER BY "count" DESC
  `;
}

/**
 * One GROUP BY on Order.createdAt â€” day or month buckets (indexed range scan when dated).
 */
async function fetchSalesByCalendarUnit(range, unit) {
  const u = unit === 'month' ? 'month' : 'day';
  const truncLiteral = Prisma.raw(`'${u}'`);
  return prisma.$queryRaw`
    SELECT
      date_trunc(${truncLiteral}, "createdAt" AT TIME ZONE 'UTC') AS "bucket",
      COUNT(*) FILTER (WHERE status <> 'CANCELLED')::int AS "orderCount",
      COALESCE(SUM("totalAmount") FILTER (WHERE status <> 'CANCELLED'), 0) AS "revenue",
      COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS "cancelledOrderCount",
      COALESCE(SUM("totalAmount") FILTER (WHERE status = 'CANCELLED'), 0) AS "cancelledRevenue"
    FROM "Order"
    ${buildOrderWhere(range)}
    GROUP BY 1
    ORDER BY 1 ASC
  `;
}

function formatDailySalesPoint(row) {
  const d = new Date(row.bucket);
  return {
    date: d.toISOString().slice(0, 10),
    netOrderCount: num(row.orderCount),
    netRevenue: num(row.revenue),
    cancelledOrderCount: num(row.cancelledOrderCount),
    cancelledRevenue: num(row.cancelledRevenue),
  };
}

function formatMonthlySalesPoint(row) {
  const d = new Date(row.bucket);
  return {
    month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
    periodStart: d.toISOString(),
    netOrderCount: num(row.orderCount),
    netRevenue: num(row.revenue),
    cancelledOrderCount: num(row.cancelledOrderCount),
    cancelledRevenue: num(row.cancelledRevenue),
  };
}

/** Every calendar day in [from, toExclusive) UTC with zeros for no-sale days. */
function fillDailySalesGaps(rows, from, toExclusive) {
  const map = new Map();
  for (const r of rows || []) {
    const key = new Date(r.bucket).toISOString().slice(0, 10);
    map.set(key, r);
  }
  const out = [];
  let cursor = startOfUtcDay(from);
  const end = new Date(toExclusive.getTime());
  while (cursor < end) {
    const key = cursor.toISOString().slice(0, 10);
    const hit = map.get(key);
    out.push(
      hit
        ? formatDailySalesPoint(hit)
        : {
            date: key,
            netOrderCount: 0,
            netRevenue: 0,
            cancelledOrderCount: 0,
            cancelledRevenue: 0,
          }
    );
    cursor = addUtcDays(cursor, 1);
  }
  return out;
}

function summarizeSalesPoints(points, isMonthly) {
  const netOrders = points.reduce((s, p) => s + p.netOrderCount, 0);
  const netRev = points.reduce((s, p) => s + p.netRevenue, 0);
  const cancO = points.reduce((s, p) => s + p.cancelledOrderCount, 0);
  const cancR = points.reduce((s, p) => s + p.cancelledRevenue, 0);
  const bestDayPoint =
    !isMonthly && points.length > 0
      ? points.reduce((best, p) => (p.netRevenue > (best?.netRevenue ?? -1) ? p : best), null)
      : null;
  const bestMonthPoint =
    isMonthly && points.length > 0
      ? points.reduce((best, p) => (p.netRevenue > (best?.netRevenue ?? -1) ? p : best), null)
      : null;
  return {
    periodCount: points.length,
    netOrderCount: netOrders,
    netRevenue: Math.round(netRev * 100) / 100,
    averageNetRevenuePerPeriod:
      points.length > 0 ? Math.round((netRev / points.length) * 100) / 100 : 0,
    cancelledOrderCount: cancO,
    cancelledRevenue: Math.round(cancR * 100) / 100,
    bestDay: bestDayPoint && bestDayPoint.netRevenue > 0 ? bestDayPoint : null,
    bestMonth: bestMonthPoint && bestMonthPoint.netRevenue > 0 ? bestMonthPoint : null,
  };
}

async function getDailySalesAnalytics(params) {
  const w = resolveAnalyticsWindow(params);
  if (w.error) return { error: w.error };
  await attachRegionFilter(w.range, params);

  const isAllTime = w.range.isAllTime;
  const unit = isAllTime ? 'month' : 'day';

  const rows = await fetchSalesByCalendarUnit(w.range, unit);

  let points;
  if (isAllTime) {
    points = (rows || []).map(formatMonthlySalesPoint);
  } else {
    points = fillDailySalesGaps(rows, w.range.from, w.range.toExclusive);
  }

  const settingsRow = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: { currency: true },
  });

  const summary = summarizeSalesPoints(points, isAllTime);

  return {
    preset: w.preset,
    presetLabel: isAllTime ? `${w.presetLabel} (monthly buckets)` : w.presetLabel,
    currency: w.range.currency ?? settingsRow?.currency ?? 'AED',
    range: rangeMetaPayload(w.range),
    granularity: isAllTime ? 'month' : 'day',
    note: isAllTime
      ? 'Preset **all_time** returns **monthly** buckets so the response stays bounded. Use **week** / **month** / custom **from**/**to** for per-day sales.'
      : 'Each row is one **UTC calendar day**. **netOrderCount** / **netRevenue** exclude cancelled orders; cancelled metrics are shown separately.',
    summary,
    points,
  };
}

async function fetchKpiAggregate(range) {
  return prisma.$queryRaw`
    SELECT ${KPI_SELECT}
    FROM "Order"
    ${buildOrderWhere(range)}
  `;
}

async function fetchUnitsSoldNet(range) {
  return prisma.$queryRaw`
    SELECT COALESCE(SUM(oi.quantity), 0)::bigint AS "unitsSold"
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON o.id = oi."orderId"
    ${buildOrderWhere(range, { alias: 'o', extra: [Prisma.sql`o.status <> 'CANCELLED'`] })}
  `;
}

/**
 * Net line revenue by product category (excludes cancelled orders). One grouped query.
 */
async function fetchCategorySales(range) {
  return prisma.$queryRaw`
    SELECT
      COALESCE(c.id::text, '') AS "categoryId",
      COALESCE(c.title, 'Uncategorized') AS "categoryTitle",
      COUNT(DISTINCT o.id)::int AS "orderCount",
      COALESCE(SUM(oi.quantity * oi.price), 0) AS "revenue",
      COALESCE(SUM(oi.quantity), 0)::bigint AS "unitsSold",
      COUNT(oi.id)::int AS "lineItemCount"
    FROM "Order" o
    INNER JOIN "OrderItem" oi ON oi."orderId" = o.id
    INNER JOIN "Product" p ON p.id = oi."productId"
    LEFT JOIN "Category" c ON c.id = p."categoryId"
    ${buildOrderWhere(range, { alias: 'o', extra: [Prisma.sql`o.status <> 'CANCELLED'`] })}
    GROUP BY c.id, c.title
    ORDER BY COALESCE(SUM(oi.quantity * oi.price), 0) DESC NULLS LAST
  `;
}

function bucketKey(d) {
  return new Date(d).toISOString();
}

function formatSeriesRow(row) {
  const b = row.bucket;
  return {
    periodStart: b instanceof Date ? b.toISOString() : new Date(b).toISOString(),
    orderCount: num(row.orderCount),
    revenue: num(row.revenue),
    cancelledOrderCount: num(row.cancelledOrderCount),
    cancelledRevenue: num(row.cancelledRevenue),
  };
}

/**
 * Fill missing buckets with zeros so chart libraries get even spacing.
 */
function fillSeriesGaps(rows, from, toExclusive, trunc) {
  const map = new Map(rows.map((r) => [bucketKey(r.bucket), r]));
  const out = [];
  let cursor = new Date(from.getTime());
  const end = new Date(toExclusive.getTime());

  const step = (() => {
    if (trunc === 'hour') return () => {
      cursor = new Date(cursor.getTime() + 3600000);
    };
    if (trunc === 'day') return () => {
      cursor = addUtcDays(cursor, 1);
    };
    if (trunc === 'week') return () => {
      cursor = addUtcDays(cursor, 7);
    };
    if (trunc === 'month') return () => {
      cursor = addUtcMonths(cursor, 1);
    };
    if (trunc === 'quarter') return () => {
      cursor = addUtcMonths(cursor, 3);
    };
    if (trunc === 'year') return () => {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear() + 1, 0, 1));
    };
    return () => {
      cursor = addUtcDays(cursor, 1);
    };
  })();

  while (cursor < end) {
    const key = bucketKey(cursor);
    const hit = map.get(key);
    if (hit) {
      out.push(formatSeriesRow(hit));
    } else {
      out.push({
        periodStart: cursor.toISOString(),
        orderCount: 0,
        revenue: 0,
        cancelledOrderCount: 0,
        cancelledRevenue: 0,
      });
    }
    const prev = cursor.getTime();
    step();
    if (cursor.getTime() <= prev) break;
  }

  return out;
}

/**
 * For hour/day buckets, PG date_trunc aligns to UTC; gap-fill uses same stepping.
 * Week/month/year: gap fill uses calendar stepping (approximation for week/month alignment).
 */
function monthKeyFromDate(d) {
  const x = new Date(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Align chart to calendar months in [from, toExclusive). */
function fillMonthSeriesGaps(rows, from, toExclusive) {
  const map = new Map(rows.map((r) => [monthKeyFromDate(r.bucket), r]));
  const out = [];
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(toExclusive.getTime());
  while (cursor < end) {
    const key = monthKeyFromDate(cursor);
    const hit = map.get(key);
    if (hit) out.push(formatSeriesRow(hit));
    else {
      out.push({
        periodStart: cursor.toISOString(),
        orderCount: 0,
        revenue: 0,
        cancelledOrderCount: 0,
        cancelledRevenue: 0,
      });
    }
    cursor = addUtcMonths(cursor, 1);
  }
  return out;
}

/** One point per calendar year overlapping the range (for last_3_years etc.). */
function fillYearSeriesGaps(rows, from, toExclusive) {
  const map = new Map(rows.map((r) => [String(new Date(r.bucket).getUTCFullYear()), r]));
  const startY = from.getUTCFullYear();
  const endY = toExclusive.getUTCFullYear() - 1;
  const out = [];
  for (let y = startY; y <= endY; y++) {
    const hit = map.get(String(y));
    if (hit) out.push(formatSeriesRow(hit));
    else {
      out.push({
        periodStart: new Date(Date.UTC(y, 0, 1)).toISOString(),
        orderCount: 0,
        revenue: 0,
        cancelledOrderCount: 0,
        cancelledRevenue: 0,
      });
    }
  }
  return out;
}

function seriesFromDb(rows, from, toExclusive, trunc) {
  if (trunc === 'hour' || trunc === 'day') {
    return fillSeriesGaps(rows, from, toExclusive, trunc);
  }
  if (trunc === 'month') {
    return fillMonthSeriesGaps(rows, from, toExclusive);
  }
  if (trunc === 'year') {
    return fillYearSeriesGaps(rows, from, toExclusive);
  }
  return rows.length ? rows.map(formatSeriesRow) : [];
}

/**
 * @param {{ preset?: string | null, from?: string | null, to?: string | null }} params
 */
function resolveAnalyticsWindow(params) {
  const { preset, from: fromParam, to: toParam } = params;
  if (fromParam && toParam) {
    const custom = parseCustomRange(fromParam, toParam);
    if (custom.error) return { error: custom.error };
    const { from, toExclusive } = custom;
    return {
      error: null,
      range: { isAllTime: false, from, toExclusive },
      presetLabel: `Custom (${pickTruncForCustomRange(from, toExclusive)} buckets, UTC)`,
      preset: null,
      trunc: pickTruncForCustomRange(from, toExclusive),
    };
  }
  if (!preset) {
    return { error: 'Query parameter preset is required unless from and to are both provided' };
  }
  let r;
  try {
    r = resolvePresetRange(preset);
  } catch {
    return { error: 'Invalid preset' };
  }
  return {
    error: null,
    range: {
      isAllTime: Boolean(r.isAllTime),
      from: r.from,
      toExclusive: r.toExclusive,
    },
    presetLabel: r.label,
    preset,
    trunc: r.trunc,
  };
}

function rangeMetaPayload(range) {
  // `region` is the applied region filter: null = combined view across all regions.
  const region = range.regionCode || null;
  if (range.isAllTime) {
    return {
      allTime: true,
      from: null,
      toExclusive: null,
      region,
      timezoneNote: 'No date filter â€” entire order history.',
    };
  }
  return {
    allTime: false,
    from: range.from.toISOString(),
    toExclusive: range.toExclusive.toISOString(),
    region,
    timezoneNote: 'All boundaries use UTC. Align client labels to your store timezone if needed.',
  };
}

async function getRevenueAnalytics(params) {
  const w = resolveAnalyticsWindow(params);
  if (w.error) return { error: w.error };
  await attachRegionFilter(w.range, params);

  const { range, presetLabel, preset, trunc: baseTrunc } = w;
  let trunc = baseTrunc;
  if (range.isAllTime) trunc = 'month';

  const [summary, seriesRows, statusRows, settingsRow] = await Promise.all([
    fetchSummary(range),
    fetchSeries(range, trunc),
    fetchStatusBreakdown(range),
    prisma.settings.findUnique({
      where: { id: 'default' },
      select: { currency: true },
    }),
  ]);

  const series = range.isAllTime
    ? (seriesRows || []).map(formatSeriesRow)
    : seriesFromDb(seriesRows, range.from, range.toExclusive, trunc);

  const byStatus = (statusRows || []).map((s) => ({
    status: s.status,
    orderCount: num(s.count),
    revenue: num(s.revenue),
  }));

  return {
    preset: preset || null,
    presetLabel,
    currency: range.currency ?? settingsRow?.currency ?? 'AED',
    range: rangeMetaPayload(range),
    bucket: trunc,
    summary,
    series,
    byStatus,
  };
}

async function getKpiAnalytics(params) {
  const w = resolveAnalyticsWindow(params);
  if (w.error) return { error: w.error };
  await attachRegionFilter(w.range, params);

  const [kpiRows, unitsRows, settingsRow] = await Promise.all([
    fetchKpiAggregate(w.range),
    fetchUnitsSoldNet(w.range),
    prisma.settings.findUnique({
      where: { id: 'default' },
      select: { currency: true },
    }),
  ]);

  const r = kpiRows[0] || {};
  const netOrderCount = num(r.netOrderCount);
  const netRevenue = num(r.netRevenue);
  const unitsSold = Number((unitsRows[0] || {}).unitsSold ?? 0);

  return {
    preset: w.preset,
    presetLabel: w.presetLabel,
    currency: w.range.currency ?? settingsRow?.currency ?? 'AED',
    range: rangeMetaPayload(w.range),
    totals: {
      totalOrdersAllStatuses: num(r.totalOrdersAllStatuses),
      grossRevenueAllStatuses: num(r.grossRevenueAllStatuses),
      netSalesCount: netOrderCount,
      netRevenue,
      averageOrderValue:
        netOrderCount > 0 ? Math.round((netRevenue / netOrderCount) * 100) / 100 : 0,
      unitsSold: Number.isFinite(unitsSold) ? unitsSold : 0,
      distinctCustomers: num(r.distinctCustomers),
    },
    cancelled: {
      orderCount: num(r.cancelledCount),
      revenue: num(r.cancelledRevenue),
    },
    byStatus: {
      PENDING: { orderCount: num(r.pendingCount), revenue: num(r.pendingRevenue) },
      CONFIRMED: { orderCount: num(r.confirmedCount), revenue: num(r.confirmedRevenue) },
      PROCESSING: { orderCount: num(r.processingCount), revenue: num(r.processingRevenue) },
      SHIPPED: { orderCount: num(r.shippedCount), revenue: num(r.shippedRevenue) },
      DELIVERED: { orderCount: num(r.deliveredCount), revenue: num(r.deliveredRevenue) },
    },
  };
}

async function getCategorySalesAnalytics(params) {
  const w = resolveAnalyticsWindow(params);
  if (w.error) return { error: w.error };
  await attachRegionFilter(w.range, params);

  const [rows, settingsRow] = await Promise.all([
    fetchCategorySales(w.range),
    prisma.settings.findUnique({
      where: { id: 'default' },
      select: { currency: true },
    }),
  ]);

  const list = (rows || []).map((row) => ({
    categoryId: row.categoryId && String(row.categoryId).length > 0 ? row.categoryId : null,
    categoryTitle: row.categoryTitle || 'Uncategorized',
    orderCount: num(row.orderCount),
    revenue: num(row.revenue),
    unitsSold: num(row.unitsSold),
    lineItemCount: num(row.lineItemCount),
  }));

  const totalNetRevenue = list.reduce((sum, x) => sum + x.revenue, 0);
  const categories = list.map((x, i) => ({
    rank: i + 1,
    categoryId: x.categoryId,
    categoryTitle: x.categoryTitle,
    orderCount: x.orderCount,
    revenue: Math.round(x.revenue * 100) / 100,
    unitsSold: x.unitsSold,
    lineItemCount: x.lineItemCount,
    revenueSharePercent:
      totalNetRevenue > 0 ? Math.round((x.revenue / totalNetRevenue) * 10000) / 100 : 0,
  }));

  return {
    preset: w.preset,
    presetLabel: w.presetLabel,
    currency: w.range.currency ?? settingsRow?.currency ?? 'AED',
    range: rangeMetaPayload(w.range),
    note:
      'Revenue is the sum of line totals (quantity Ã— captured unit price) on **non-cancelled** orders only. Compare categories for â€œwhich sold moreâ€ in the selected window.',
    totalNetLineRevenue: Math.round(totalNetRevenue * 100) / 100,
    categories,
  };
}

/**
 * Net revenue/quantity by product (excludes cancelled orders) â€” the same
 * grouping convention as fetchCategorySales, one level down to product. Used
 * to derive best/least-selling product rankings for the Analytics Export.
 */
async function fetchProductSales(range) {
  return prisma.$queryRaw`
    SELECT
      p.id AS "productId",
      p.title AS "productTitle",
      COUNT(DISTINCT o.id)::int AS "orderCount",
      COALESCE(SUM(oi.quantity * oi.price), 0) AS "revenue",
      COALESCE(SUM(oi.quantity), 0)::bigint AS "unitsSold"
    FROM "Order" o
    INNER JOIN "OrderItem" oi ON oi."orderId" = o.id
    INNER JOIN "Product" p ON p.id = oi."productId"
    ${buildOrderWhere(range, { alias: 'o', extra: [Prisma.sql`o.status <> 'CANCELLED'`] })}
    GROUP BY p.id, p.title
    ORDER BY COALESCE(SUM(oi.quantity * oi.price), 0) DESC NULLS LAST
  `;
}

/**
 * Best/least selling products over a date range. Mirrors getCategorySalesAnalytics's
 * shape/conventions (same range resolution, same "excludes cancelled" rule).
 */
async function getProductSalesAnalytics(params) {
  const w = resolveAnalyticsWindow(params);
  if (w.error) return { error: w.error };
  await attachRegionFilter(w.range, params);

  const limit = Math.min(50, Math.max(1, parseInt(params?.limit, 10) || 10));
  const rows = await fetchProductSales(w.range);
  const list = (rows || []).map((row) => ({
    productId: row.productId,
    productTitle: row.productTitle || '(deleted product)',
    orderCount: num(row.orderCount),
    revenue: Math.round(num(row.revenue) * 100) / 100,
    unitsSold: num(row.unitsSold),
  }));

  return {
    preset: w.preset,
    presetLabel: w.presetLabel,
    range: rangeMetaPayload(w.range),
    note: 'Revenue is the sum of line totals on non-cancelled orders only, same rule as category sales.',
    bestSellers: list.slice(0, limit),
    leastSellers: [...list].reverse().slice(0, limit),
  };
}

/**
 * Live catalog snapshot (no date range) â€” total sellable stock, low-stock and
 * out-of-stock published products. Reuses the exact LOW_STOCK_THRESHOLD
 * convention from report.service.buildStockReport (the daily digest email) so
 * "low stock" means the same thing everywhere in the system.
 */
async function getInventoryAnalytics() {
  const threshold = Math.max(0, parseInt(process.env.LOW_STOCK_THRESHOLD || '5', 10));

  const [totalRow, lowStock, outOfStock] = await Promise.all([
    prisma.product.aggregate({
      where: { status: 'PUBLISHED' },
      _sum: { quantity: true },
      _count: { _all: true },
    }),
    prisma.product.findMany({
      where: { status: 'PUBLISHED', quantity: { gt: 0, lte: threshold } },
      select: { id: true, title: true, quantity: true },
      orderBy: { quantity: 'asc' },
      take: 200,
    }),
    prisma.product.findMany({
      where: { status: 'PUBLISHED', quantity: 0 },
      select: { id: true, title: true },
      take: 200,
    }),
  ]);

  return {
    totalPublishedProducts: totalRow._count._all,
    totalInventoryCount: totalRow._sum.quantity ?? 0,
    lowStockThreshold: threshold,
    lowStockProducts: lowStock,
    outOfStockProducts: outOfStock,
  };
}

/**
 * Extended order KPIs over the range for the Analytics EXPORT (not shown on the
 * live dashboard): highest/lowest order value, avg items per order, paid vs
 * unpaid, COD vs online, unique + repeat customers, cancelled %. SQL aggregates
 * (the range can be all_time / huge, so no in-memory scan). Uses the same
 * buildOrderWhere scoping every other analytics query uses.
 */
async function getOrderInsights(params) {
  const w = resolveAnalyticsWindow(params);
  if (w.error) return { error: w.error };
  await attachRegionFilter(w.range, params);
  const range = w.range;

  const [totalsRows, itemsRows, custRows] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        MAX("totalAmount") FILTER (WHERE status <> 'CANCELLED') AS "highest",
        MIN("totalAmount") FILTER (WHERE status <> 'CANCELLED') AS "lowest",
        COUNT(*) FILTER (WHERE "paymentStatus" = 'PAID')::int AS "paid",
        COUNT(*) FILTER (WHERE "paymentStatus" = 'UNPAID')::int AS "unpaid",
        COUNT(*) FILTER (WHERE "paymentStatus" = 'FAILED')::int AS "failed",
        COUNT(*) FILTER (WHERE "paymentMethod" = 'COD')::int AS "cod",
        COUNT(*) FILTER (WHERE "paymentMethod" = 'MYFATOORAH')::int AS "online",
        COUNT(*)::int AS "totalAll",
        COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS "cancelled"
      FROM "Order"
      ${buildOrderWhere(range)}
    `,
    prisma.$queryRaw`
      SELECT COALESCE(SUM(oi.quantity), 0)::bigint AS "units", COUNT(DISTINCT o.id)::int AS "orders"
      FROM "Order" o
      INNER JOIN "OrderItem" oi ON oi."orderId" = o.id
      ${buildOrderWhere(range, { alias: 'o', extra: [Prisma.sql`o.status <> 'CANCELLED'`] })}
    `,
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS "unique", COUNT(*) FILTER (WHERE c > 1)::int AS "repeat"
      FROM (
        SELECT COALESCE("userId", "guestEmail", "guestPhone") AS k, COUNT(*) AS c
        FROM "Order"
        ${buildOrderWhere(range, { extra: [Prisma.sql`status <> 'CANCELLED'`, Prisma.sql`COALESCE("userId", "guestEmail", "guestPhone") IS NOT NULL`] })}
        GROUP BY 1
      ) t
    `,
  ]);

  const t = totalsRows[0] || {};
  const items = itemsRows[0] || {};
  const cust = custRows[0] || {};
  const orders = Number(items.orders) || 0;
  const units = Number(items.units) || 0;
  const totalAll = num(t.totalAll);

  return {
    highestOrderValue: num(t.highest),
    lowestOrderValue: num(t.lowest),
    averageItemsPerOrder: orders > 0 ? Math.round((units / orders) * 100) / 100 : 0,
    paidOrders: num(t.paid),
    unpaidOrders: num(t.unpaid),
    failedOrders: num(t.failed),
    codOrders: num(t.cod),
    onlineOrders: num(t.online),
    uniqueCustomers: num(cust.unique),
    repeatCustomers: num(cust.repeat),
    cancelledOrders: num(t.cancelled),
    cancelledOrderPercentage: totalAll > 0 ? Math.round((num(t.cancelled) / totalAll) * 10000) / 100 : 0,
  };
}

function listPresetDefinitions() {
  return Object.entries(PRESETS).map(([key, v]) => ({
    key,
    label: v.label,
    bucket: v.trunc,
  }));
}

module.exports = {
  getRevenueAnalytics,
  getKpiAnalytics,
  getCategorySalesAnalytics,
  getDailySalesAnalytics,
  getProductSalesAnalytics,
  getInventoryAnalytics,
  getOrderInsights,
  PRESETS: Object.keys(PRESETS),
  listPresetDefinitions,
};
