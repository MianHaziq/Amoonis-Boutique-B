/**
 * Order Export — Excel (.xlsx) renderer. Streams directly to the response.
 * Styling comes entirely from excelStyle.util.js / exportTheme.js.
 */

const ExcelJS = require('exceljs');
const {
  writeTitleBlock,
  writeStyledTable,
  addSumFormulaRow,
  applyStatusColors,
  applyValueFormats,
  CURRENCY_FMT,
  DATE_FMT,
  INTEGER_FMT,
  PERCENT_FMT,
  DECIMAL_FMT,
} = require('./excelStyle.util');
const { getBranding } = require('./branding.util');

/**
 * @param {import('express').Response} res
 * @param {{ summary, orderRows, itemRows, filtersApplied }} data
 * @param {string} filename
 */
async function renderOrdersExcel(res, data, filename) {
  const { summary, orderRows, itemRows, filtersApplied } = data;
  const { siteName, logo } = await getBranding();
  // Single-currency result (the common case — most exports are filtered to one
  // region): show the plain top-line figures, same layout as before. A mixed
  // result (e.g. "All regions" spanning AED + SAR, the export dialog's
  // default) never blends amounts across currencies — see the "Revenue By
  // Currency" table below instead, and orderExport.service.js's currencyBreakdown.
  const singleCurrency = summary.currencyBreakdown.length === 1 ? summary.currencyBreakdown[0] : null;
  const currency = singleCurrency?.currency || '';

  const workbook = new ExcelJS.Workbook();
  workbook.creator = siteName;
  workbook.created = new Date();

  // --- Summary sheet (branded title band + KPI table) ---
  const summarySheet = workbook.addWorksheet('Summary');
  const summaryStart = writeTitleBlock(workbook, summarySheet, {
    siteName,
    title: 'Orders Export',
    generatedAt: new Date().toISOString(),
    currency,
    filterLines: [
      `Date range: ${filtersApplied.dateFrom} to ${filtersApplied.dateTo}`,
      `Order status: ${filtersApplied.status} · Payment status: ${filtersApplied.paymentStatus} · Region: ${filtersApplied.region}`,
    ],
    logo,
    columnSpan: 2,
  });
  const C = CURRENCY_FMT;
  const I = INTEGER_FMT;
  const summaryMetrics = [
    { metric: 'Total Orders', value: summary.totalOrders, fmt: I },
    ...(singleCurrency
      ? [
          { metric: `Total Revenue (${currency})`, value: singleCurrency.totalRevenue, fmt: C },
          { metric: `Average Order Value (${currency})`, value: singleCurrency.averageOrderValue, fmt: C },
        ]
      : []),
    { metric: 'Total Quantity Sold', value: summary.totalQuantitySold, fmt: I },
    ...(singleCurrency
      ? [
          { metric: `Highest Order Value (${currency})`, value: singleCurrency.highestOrderValue, fmt: C },
          { metric: `Lowest Order Value (${currency})`, value: singleCurrency.lowestOrderValue, fmt: C },
        ]
      : []),
    { metric: 'Average Items Per Order', value: summary.averageItemsPerOrder, fmt: DECIMAL_FMT },
    { metric: 'Paid Orders', value: summary.paidOrders, fmt: I },
    { metric: 'Unpaid Orders', value: summary.unpaidOrders, fmt: I },
    { metric: 'COD Orders', value: summary.codOrders, fmt: I },
    { metric: 'Online Payment Orders', value: summary.onlineOrders, fmt: I },
    { metric: 'Unique Customers', value: summary.uniqueCustomers, fmt: I },
    { metric: 'Repeat Customers', value: summary.repeatCustomers, fmt: I },
    { metric: 'Cancelled Orders', value: summary.cancelledOrders, fmt: I },
    { metric: 'Cancelled Order %', value: summary.cancelledOrderPercentage, fmt: PERCENT_FMT },
  ];
  const summaryRange = writeStyledTable(
    summarySheet,
    [
      { key: 'metric', header: 'Metric', width: 32 },
      { key: 'value', header: 'Value', width: 22 },
    ],
    summaryMetrics.map(({ metric, value }) => ({ metric, value })),
    { startRow: summaryStart, freeze: true }
  );
  applyValueFormats(summarySheet, summaryRange, 2, summaryMetrics.map((m) => m.fmt));

  // Revenue-by-currency table — always shown when there's more than one
  // currency in the result set (never blended into a single misleading number).
  if (!singleCurrency) {
    const breakdownStart = summaryRange.lastDataRow + 2;
    summarySheet.getCell(`A${breakdownStart - 1}`).value = 'Revenue By Currency';
    summarySheet.getCell(`A${breakdownStart - 1}`).font = { bold: true };
    const breakdownColumns = [
      { key: 'currency', header: 'Currency', width: 12 },
      { key: 'totalOrders', header: 'Orders', numFmt: I, width: 12 },
      { key: 'totalRevenue', header: 'Total Revenue', numFmt: C },
      { key: 'averageOrderValue', header: 'Average Order Value', numFmt: C },
      { key: 'highestOrderValue', header: 'Highest Order Value', numFmt: C },
      { key: 'lowestOrderValue', header: 'Lowest Order Value', numFmt: C },
    ];
    writeStyledTable(summarySheet, breakdownColumns, summary.currencyBreakdown, { startRow: breakdownStart });
  }

  // --- Orders sheet ---
  const ordersSheet = workbook.addWorksheet('Orders');
  const orderColumns = [
    { key: 'orderNumber', header: 'Order #', width: 12 },
    { key: 'createdAt', header: 'Date & Time', numFmt: DATE_FMT, width: 20 },
    { key: 'customerName', header: 'Customer Name' },
    { key: 'customerPhone', header: 'Phone' },
    { key: 'customerEmail', header: 'Email' },
    { key: 'region', header: 'Region', width: 12 },
    { key: 'city', header: 'City' },
    { key: 'shippingAddress', header: 'Shipping Address', width: 40 },
    { key: 'paymentMethod', header: 'Payment Method' },
    { key: 'paymentStatus', header: 'Payment Status' },
    { key: 'status', header: 'Order Status' },
    { key: 'currency', header: 'Currency', width: 10 },
    { key: 'deliveryCharges', header: 'Delivery Charges', numFmt: CURRENCY_FMT },
    { key: 'discountAmount', header: 'Discount', numFmt: CURRENCY_FMT },
    { key: 'appliedPromoCode', header: 'Promo Code', width: 14 },
    { key: 'taxAmount', header: 'Tax', numFmt: CURRENCY_FMT },
    { key: 'vatRatePercent', header: 'VAT %', numFmt: PERCENT_FMT, width: 10 },
    { key: 'totalAmount', header: 'Total Amount', numFmt: CURRENCY_FMT },
    { key: 'itemCount', header: 'Item Count', numFmt: INTEGER_FMT, width: 10 },
  ];
  const orderRange = writeStyledTable(ordersSheet, orderColumns, orderRows, { freeze: true });
  // Conditional formatting: colour the Payment Status and Order Status cells by
  // tone (PAID/DELIVERED green, PENDING/UNPAID yellow, …) — column indexes
  // shifted by 1 from the previous layout since "Region" was inserted before "City".
  const paymentStatusCol = orderColumns.findIndex((c) => c.key === 'paymentStatus') + 1;
  const orderStatusCol = orderColumns.findIndex((c) => c.key === 'status') + 1;
  applyStatusColors(ordersSheet, orderRange, paymentStatusCol);
  applyStatusColors(ordersSheet, orderRange, orderStatusCol);
  // A monetary TOTAL row only makes sense when every order shares one currency —
  // summing AED and SAR amounts together would be wrong, so it's skipped for a
  // mixed-currency result (the per-currency breakdown on the Summary sheet is
  // the correct place for that figure).
  const ordersAllSameCurrency = orderRows.length > 0 && orderRows.every((r) => r.currency === orderRows[0].currency);
  if (ordersAllSameCurrency) {
    addSumFormulaRow(
      ordersSheet,
      orderColumns,
      orderRange,
      ['deliveryCharges', 'discountAmount', 'taxAmount', 'totalAmount'],
      'orderNumber'
    );
  }

  // --- Order Items sheet ---
  const itemsSheet = workbook.addWorksheet('Order Items');
  const itemColumns = [
    { key: 'orderNumber', header: 'Order #', width: 12 },
    { key: 'productName', header: 'Product Name', width: 32 },
    { key: 'sku', header: 'SKU', width: 12 },
    { key: 'variant', header: 'Variant', width: 20 },
    { key: 'quantity', header: 'Quantity', numFmt: INTEGER_FMT, width: 10 },
    { key: 'currency', header: 'Currency', width: 10 },
    { key: 'unitPrice', header: 'Unit Price', numFmt: CURRENCY_FMT },
    { key: 'lineTotal', header: 'Line Total', numFmt: CURRENCY_FMT },
  ];
  const itemRange = writeStyledTable(itemsSheet, itemColumns, itemRows, { freeze: true });
  const itemsAllSameCurrency = itemRows.length > 0 && itemRows.every((r) => r.currency === itemRows[0].currency);
  if (itemsAllSameCurrency) {
    addSumFormulaRow(itemsSheet, itemColumns, itemRange, ['lineTotal'], 'orderNumber');
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

module.exports = { renderOrdersExcel };
