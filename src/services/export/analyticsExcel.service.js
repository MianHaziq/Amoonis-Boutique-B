/**
 * Analytics Export — Excel (.xlsx) renderer. Streams directly to the response.
 */

const ExcelJS = require('exceljs');
const {
  writeTitleBlock,
  writeStyledTable,
  addSumFormulaRow,
  applyStatusColors,
  applyValueFormats,
  CURRENCY_FMT,
  INTEGER_FMT,
  PERCENT_FMT,
  DECIMAL_FMT,
} = require('./excelStyle.util');
const { getBranding } = require('./branding.util');

async function renderAnalyticsExcel(res, data, filename) {
  const { presetLabel, currency, kpi, orderInsights, category, dailySales, weeklySales, monthlySales, products, inventory, orderStatusCounts } = data;
  const { siteName, logo } = await getBranding();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = siteName;
  workbook.created = new Date();

  // --- Summary sheet (branded title band + full KPI table) ---
  const summarySheet = workbook.addWorksheet('Summary');
  const summaryStart = writeTitleBlock(workbook, summarySheet, {
    siteName,
    title: 'Analytics Export',
    generatedAt: new Date().toISOString(),
    currency,
    filterLines: [`Range: ${presetLabel}`],
    logo,
    columnSpan: 2,
  });
  const C = CURRENCY_FMT;
  const I = INTEGER_FMT;
  const summaryMetrics = [
    { metric: 'Total Orders (all statuses)', value: kpi.totals.totalOrdersAllStatuses, fmt: I },
    { metric: `Net Revenue (${currency})`, value: kpi.totals.netRevenue, fmt: C },
    { metric: `Average Order Value (${currency})`, value: kpi.totals.averageOrderValue, fmt: C },
    { metric: 'Units Sold', value: kpi.totals.unitsSold, fmt: I },
    { metric: 'Distinct Customers', value: kpi.totals.distinctCustomers, fmt: I },
    { metric: `Highest Order Value (${currency})`, value: orderInsights.highestOrderValue, fmt: C },
    { metric: `Lowest Order Value (${currency})`, value: orderInsights.lowestOrderValue, fmt: C },
    { metric: 'Average Items Per Order', value: orderInsights.averageItemsPerOrder, fmt: DECIMAL_FMT },
    { metric: 'Paid Orders', value: orderInsights.paidOrders, fmt: I },
    { metric: 'Unpaid Orders', value: orderInsights.unpaidOrders, fmt: I },
    { metric: 'COD Orders', value: orderInsights.codOrders, fmt: I },
    { metric: 'Online Payment Orders', value: orderInsights.onlineOrders, fmt: I },
    { metric: 'Repeat Customers', value: orderInsights.repeatCustomers, fmt: I },
    { metric: 'Cancelled Orders', value: kpi.cancelled.orderCount, fmt: I },
    { metric: `Cancelled Revenue (${currency})`, value: kpi.cancelled.revenue, fmt: C },
    { metric: 'Cancelled Order %', value: orderInsights.cancelledOrderPercentage, fmt: PERCENT_FMT },
    { metric: 'Refunded Orders', value: orderInsights.refundedOrders, fmt: I },
    { metric: 'Refunded Order %', value: orderInsights.refundedOrderPercentage, fmt: PERCENT_FMT },
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

  // --- Revenue sheet: daily, weekly, monthly side by side as separate tables ---
  const revenueSheet = workbook.addWorksheet('Revenue');
  revenueSheet.addRow(['Daily Revenue']).font = { bold: true, size: 12 };
  const dailyRange = writeStyledTable(
    revenueSheet,
    [
      { key: 'date', header: 'Date', width: 14 },
      { key: 'netOrderCount', header: 'Orders', width: 10 },
      { key: 'netRevenue', header: 'Revenue', numFmt: CURRENCY_FMT },
    ],
    dailySales
  );
  addSumFormulaRow(revenueSheet, [
    { key: 'date', header: 'Date' }, { key: 'netOrderCount', header: 'Orders' }, { key: 'netRevenue', header: 'Revenue', numFmt: CURRENCY_FMT },
  ], dailyRange, ['netOrderCount', 'netRevenue'], 'date');

  revenueSheet.addRow([]);
  revenueSheet.addRow(['Weekly Revenue']).font = { bold: true, size: 12 };
  writeStyledTable(
    revenueSheet,
    [
      { key: 'weekStart', header: 'Week Starting', width: 16 },
      { key: 'netOrderCount', header: 'Orders', width: 10 },
      { key: 'netRevenue', header: 'Revenue', numFmt: CURRENCY_FMT },
    ],
    weeklySales
  );

  revenueSheet.addRow([]);
  revenueSheet.addRow(['Monthly Revenue']).font = { bold: true, size: 12 };
  writeStyledTable(
    revenueSheet,
    [
      { key: 'month', header: 'Month', width: 14 },
      { key: 'netOrderCount', header: 'Orders', width: 10 },
      { key: 'netRevenue', header: 'Revenue', numFmt: CURRENCY_FMT },
    ],
    monthlySales
  );

  // --- Sales by Day sheet (full detail, mirrors the dashboard's own view) ---
  const salesByDaySheet = workbook.addWorksheet('Sales by Day');
  writeStyledTable(
    salesByDaySheet,
    [
      { key: 'date', header: 'Date', width: 14 },
      { key: 'netOrderCount', header: 'Orders', width: 10 },
      { key: 'netRevenue', header: 'Revenue', numFmt: CURRENCY_FMT },
      { key: 'cancelledOrderCount', header: 'Cancelled Orders', width: 14 },
      { key: 'cancelledRevenue', header: 'Cancelled Revenue', numFmt: CURRENCY_FMT },
    ],
    dailySales
  );

  // --- Categories sheet ---
  const categoriesSheet = workbook.addWorksheet('Categories');
  writeStyledTable(
    categoriesSheet,
    [
      { key: 'rank', header: 'Rank', width: 8 },
      { key: 'categoryTitle', header: 'Category', width: 24 },
      { key: 'orderCount', header: 'Orders', width: 10 },
      { key: 'unitsSold', header: 'Units Sold', width: 12 },
      { key: 'revenue', header: 'Revenue', numFmt: CURRENCY_FMT },
      { key: 'revenueSharePercent', header: 'Revenue Share %', width: 14 },
    ],
    category.categories
  );

  // --- Products sheet: best + least sellers ---
  const productsSheet = workbook.addWorksheet('Products');
  productsSheet.addRow(['Best Selling Products']).font = { bold: true, size: 12 };
  const productColumns = [
    { key: 'productTitle', header: 'Product', width: 30 },
    { key: 'orderCount', header: 'Orders', width: 10 },
    { key: 'unitsSold', header: 'Units Sold', width: 12 },
    { key: 'revenue', header: 'Revenue', numFmt: CURRENCY_FMT },
  ];
  writeStyledTable(productsSheet, productColumns, products.bestSellers);
  productsSheet.addRow([]);
  productsSheet.addRow(['Least Selling Products']).font = { bold: true, size: 12 };
  writeStyledTable(productsSheet, productColumns, products.leastSellers);

  // --- Inventory sheet ---
  const inventorySheet = workbook.addWorksheet('Inventory');
  inventorySheet.addRow(['Inventory Summary']).font = { bold: true, size: 12 };
  inventorySheet.addRow(['Total Published Products', inventory.totalPublishedProducts]);
  inventorySheet.addRow(['Total Inventory Count', inventory.totalInventoryCount]);
  inventorySheet.addRow(['Low Stock Threshold', inventory.lowStockThreshold]);
  inventorySheet.addRow([]);
  inventorySheet.addRow(['Low Stock Products']).font = { bold: true, size: 12 };
  writeStyledTable(
    inventorySheet,
    [
      { key: 'title', header: 'Product', width: 30 },
      { key: 'quantity', header: 'Quantity Remaining', width: 18 },
    ],
    inventory.lowStockProducts
  );
  inventorySheet.addRow([]);
  inventorySheet.addRow(['Out of Stock Products']).font = { bold: true, size: 12 };
  writeStyledTable(
    inventorySheet,
    [{ key: 'title', header: 'Product', width: 30 }],
    inventory.outOfStockProducts
  );

  // --- Orders by Status sheet ---
  const statusSheet = workbook.addWorksheet('Orders by Status');
  const statusRows = Object.entries(orderStatusCounts).map(([status, v]) => ({
    status,
    orderCount: v.orderCount,
    revenue: v.revenue,
  }));
  const statusRange = writeStyledTable(
    statusSheet,
    [
      { key: 'status', header: 'Status', width: 22 },
      { key: 'orderCount', header: 'Order Count', width: 12 },
      { key: 'revenue', header: 'Revenue', numFmt: CURRENCY_FMT },
    ],
    statusRows
  );
  applyStatusColors(statusSheet, statusRange, 1); // colour the Status column by tone

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

module.exports = { renderAnalyticsExcel };
