/**
 * Data-gathering layer for the Order Export feature (Excel + PDF). Deliberately
 * separate from order.service.js's paginated admin list — this pulls the FULL
 * filtered result set (no pagination) and shapes it once into flat rows that
 * both renderers (orderExcel.service.js / orderPdf.service.js) consume as-is,
 * so filtering/shaping logic isn't duplicated per format.
 */

const prisma = require('../../config/db');
const regionService = require('../region.service');

// Hard cap protecting memory/time for the synchronous (streamed) export path.
// Exceeding it returns a friendly error asking the admin to narrow the range —
// this is the explicit trade-off of choosing synchronous delivery for now
// (see the Order Export plan: async/job-queue delivery is a future phase).
const MAX_EXPORT_ROWS = 10000;

const VALID_STATUSES = ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
const VALID_PAYMENT_STATUSES = ['UNPAID', 'PAID', 'FAILED'];

function decimalToNumber(v) {
  return v == null ? 0 : Number(v);
}

function formatShippingAddress(order) {
  const parts = [
    order.shippingArea,
    order.shippingZoneName,
    order.shippingStreetAddress,
    order.shippingApartment,
    order.shippingCity,
    order.shippingState,
    order.shippingPostalCode,
    order.shippingCountry,
  ].filter(Boolean);
  return parts.join(', ');
}

function customerName(order) {
  return order.userId ? order.user?.fullName || order.shippingFullName || '' : order.guestName || order.shippingFullName || '';
}

function customerPhone(order) {
  return order.userId ? order.shippingPhone || '' : order.guestPhone || order.shippingPhone || '';
}

function customerEmail(order) {
  return order.userId ? order.user?.email || '' : order.guestEmail || '';
}

function formatVariant(selectedOptions) {
  if (!selectedOptions || typeof selectedOptions !== 'object') return '';
  return Object.entries(selectedOptions)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
}

/**
 * @param {{ dateFrom: string, dateTo: string, status?: string, paymentStatus?: string, regionCode?: string }} filters
 * @returns {Promise<{ error: string } | { error: null, summary: object, orderRows: object[], itemRows: object[], filtersApplied: object }>}
 */
async function getOrdersForExport(filters = {}) {
  const { dateFrom, dateTo, status, paymentStatus, regionCode } = filters;

  if (!dateFrom || !dateTo) {
    return { error: 'dateFrom and dateTo are required' };
  }
  if (status && !VALID_STATUSES.includes(status)) {
    return { error: `status must be one of ${VALID_STATUSES.join(', ')}` };
  }
  if (paymentStatus && !VALID_PAYMENT_STATUSES.includes(paymentStatus)) {
    return { error: `paymentStatus must be one of ${VALID_PAYMENT_STATUSES.join(', ')}` };
  }

  const where = {
    createdAt: { gte: new Date(dateFrom), lte: new Date(dateTo) },
    // Mirrors listStatusFilter's convention: AWAITING_PAYMENT (unpaid online
    // checkouts) are never "placed" orders and are excluded unless explicitly
    // requested via `status`.
    ...(status ? { status } : { status: { not: 'AWAITING_PAYMENT' } }),
    ...(paymentStatus ? { paymentStatus } : {}),
  };

  if (regionCode) {
    const region = await regionService.getRegionByCode(regionCode);
    where.regionId = region ? region.id : '00000000-0000-0000-0000-000000000000';
  }

  const total = await prisma.order.count({ where });
  if (total === 0) {
    return { error: 'No orders match this filter.' };
  }
  if (total > MAX_EXPORT_ROWS) {
    return { error: `Too many orders match this filter (${total}). Please narrow the date range (max ${MAX_EXPORT_ROWS}).` };
  }

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: { id: true, email: true, fullName: true } },
      region: { select: { code: true, name: true } },
      items: { orderBy: { createdAt: 'asc' } },
    },
  });

  const orderRows = [];
  const itemRows = [];
  let totalQuantitySold = 0;
  let paidOrders = 0;
  let unpaidOrders = 0;
  let codOrders = 0;
  let onlineOrders = 0;
  let cancelledOrders = 0;
  // Distinct-customer identity key: account id for authed, else guest email or
  // phone. Counts how many orders each customer placed → unique vs repeat.
  const customerOrderCounts = new Map();
  // Financial totals must NEVER be blended across currencies (AED + SAR summed
  // as raw numbers is meaningless) — the store is multi-region/multi-currency
  // (UAE→AED, Saudi→SAR), and "All regions" (spanning both) is the export
  // dialog's default filter, so this isn't a theoretical edge case. Every
  // money metric is tracked per-currency; only counts (order/item counts,
  // payment/cancellation tallies) are safe to blend across the whole result set.
  const byCurrency = new Map();
  function currencyBucket(currency) {
    if (!byCurrency.has(currency)) {
      byCurrency.set(currency, { currency, totalOrders: 0, totalRevenue: 0, highestOrderValue: null, lowestOrderValue: null });
    }
    return byCurrency.get(currency);
  }

  for (const order of orders) {
    const totalAmount = decimalToNumber(order.totalAmount);
    const discountAmount = decimalToNumber(order.discountAmount);
    const taxAmount = decimalToNumber(order.taxAmount);
    const shippingAmount = decimalToNumber(order.shippingAmount) || 0;
    const itemCount = order.items.reduce((s, i) => s + i.quantity, 0);
    const currency = order.currency || 'AED';

    const bucket = currencyBucket(currency);
    bucket.totalOrders += 1;
    bucket.totalRevenue += totalAmount;
    if (bucket.highestOrderValue == null || totalAmount > bucket.highestOrderValue) bucket.highestOrderValue = totalAmount;
    if (bucket.lowestOrderValue == null || totalAmount < bucket.lowestOrderValue) bucket.lowestOrderValue = totalAmount;

    totalQuantitySold += itemCount;
    if (order.paymentStatus === 'PAID') paidOrders += 1;
    if (order.paymentStatus === 'UNPAID') unpaidOrders += 1;
    if (order.paymentMethod === 'COD') codOrders += 1;
    else onlineOrders += 1;
    if (order.status === 'CANCELLED') cancelledOrders += 1;

    const customerKey = order.userId || order.guestEmail || order.guestPhone || null;
    if (customerKey) customerOrderCounts.set(customerKey, (customerOrderCounts.get(customerKey) || 0) + 1);

    orderRows.push({
      orderNumber: order.orderNumber,
      createdAt: order.createdAt,
      customerName: customerName(order),
      customerPhone: customerPhone(order),
      customerEmail: customerEmail(order),
      // Area replaced city as the primary location field — fall back to the
      // legacy city column for orders placed before that change.
      city: order.shippingArea || order.shippingCity || '',
      shippingAddress: formatShippingAddress(order),
      // Code, not full name (matches the admin Orders list's Region column
      // convention) — also keeps this narrow enough that the PDF's fixed-height
      // table rows never wrap, which otherwise cascades into spurious extra
      // pages (pdfkit's implicit pagination fighting drawTable's own).
      region: order.region?.code || '',
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      status: order.status,
      deliveryCharges: shippingAmount,
      discountAmount,
      appliedPromoCode: order.appliedPromoCode || '',
      taxAmount,
      vatRatePercent: order.vatRatePercent != null ? decimalToNumber(order.vatRatePercent) : '',
      totalAmount,
      currency,
      itemCount,
      isGuest: !order.userId,
    });

    for (const item of order.items) {
      itemRows.push({
        orderNumber: order.orderNumber,
        productName: item.productTitle || '(deleted product)',
        sku: '', // No SKU concept exists in the catalog.
        variant: formatVariant(item.selectedOptions),
        quantity: item.quantity,
        unitPrice: decimalToNumber(item.price),
        lineTotal: decimalToNumber(item.price) * item.quantity,
        currency,
      });
    }
  }

  const round2 = (n) => Math.round((n || 0) * 100) / 100;
  const uniqueCustomers = customerOrderCounts.size;
  const repeatCustomers = [...customerOrderCounts.values()].filter((c) => c > 1).length;

  const currencyBreakdown = [...byCurrency.values()]
    .map((b) => ({
      currency: b.currency,
      totalOrders: b.totalOrders,
      totalRevenue: round2(b.totalRevenue),
      averageOrderValue: b.totalOrders > 0 ? round2(b.totalRevenue / b.totalOrders) : 0,
      highestOrderValue: round2(b.highestOrderValue),
      lowestOrderValue: round2(b.lowestOrderValue),
    }))
    .sort((a, b) => b.totalRevenue - a.totalRevenue);

  const summary = {
    totalOrders: orders.length,
    totalQuantitySold,
    // Per-currency financial breakdown — always present, even for a single
    // currency (renderers show the plain single-currency layout when there's
    // only one entry, and a labelled per-currency table when there's more).
    currencyBreakdown,
    // Extended KPIs (computed in-memory from the full filtered set — exact, not sampled).
    averageItemsPerOrder: orders.length > 0 ? round2(totalQuantitySold / orders.length) : 0,
    paidOrders,
    unpaidOrders,
    codOrders,
    onlineOrders,
    uniqueCustomers,
    repeatCustomers,
    cancelledOrders,
    cancelledOrderPercentage: orders.length > 0 ? round2((cancelledOrders / orders.length) * 100) : 0,
  };

  // Display-friendly UTC labels for the range (raw ISO reads as clutter in a report).
  const fmtDateTime = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  };

  return {
    error: null,
    summary,
    orderRows,
    itemRows,
    filtersApplied: {
      dateFrom: fmtDateTime(dateFrom),
      dateTo: fmtDateTime(dateTo),
      status: status || 'All',
      paymentStatus: paymentStatus || 'All',
      region: regionCode || 'All',
    },
  };
}

module.exports = { getOrdersForExport, MAX_EXPORT_ROWS };
