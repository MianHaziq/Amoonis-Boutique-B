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
  const currency = orderRows[0]?.currency || 'AED';

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
    { metric: `Total Revenue (${currency})`, value: summary.totalRevenue, fmt: C },
    { metric: `Average Order Value (${currency})`, value: summary.averageOrderValue, fmt: C },
    { metric: 'Total Quantity Sold', value: summary.totalQuantitySold, fmt: I },
    { metric: `Highest Order Value (${currency})`, value: summary.highestOrderValue, fmt: C },
    { metric: `Lowest Order Value (${currency})`, value: summary.lowestOrderValue, fmt: C },
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

  // --- Orders sheet ---
  const ordersSheet = workbook.addWorksheet('Orders');
  const orderColumns = [
    { key: 'orderNumber', header: 'Order #', width: 12 },
    { key: 'createdAt', header: 'Date & Time', numFmt: DATE_FMT, width: 20 },
    { key: 'customerName', header: 'Customer Name' },
    { key: 'customerPhone', header: 'Phone' },
    { key: 'customerEmail', header: 'Email' },
    { key: 'city', header: 'City' },
    { key: 'shippingAddress', header: 'Shipping Address', width: 40 },
    { key: 'paymentMethod', header: 'Payment Method' },
    { key: 'paymentStatus', header: 'Payment Status' },
    { key: 'status', header: 'Order Status' },
    { key: 'currency', header: 'Currency', width: 10 },
    { key: 'deliveryCharges', header: 'Delivery Charges', numFmt: CURRENCY_FMT },
    { key: 'discountAmount', header: 'Discount', numFmt: CURRENCY_FMT },
    { key: 'taxAmount', header: 'Tax', numFmt: CURRENCY_FMT },
    { key: 'totalAmount', header: 'Total Amount', numFmt: CURRENCY_FMT },
    { key: 'itemCount', header: 'Item Count', numFmt: INTEGER_FMT, width: 10 },
  ];
  const orderRange = writeStyledTable(ordersSheet, orderColumns, orderRows, { freeze: true });
  // Conditional formatting: colour the Payment Status (col 9) and Order Status
  // (col 10) cells by tone (PAID/DELIVERED green, PENDING/UNPAID yellow, …).
  applyStatusColors(ordersSheet, orderRange, 9);
  applyStatusColors(ordersSheet, orderRange, 10);
  addSumFormulaRow(
    ordersSheet,
    orderColumns,
    orderRange,
    ['deliveryCharges', 'discountAmount', 'taxAmount', 'totalAmount'],
    'orderNumber'
  );

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
  addSumFormulaRow(itemsSheet, itemColumns, itemRange, ['lineTotal'], 'orderNumber');

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

module.exports = { renderOrdersExcel };
