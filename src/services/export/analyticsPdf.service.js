/**
 * Analytics Export — PDF renderer. Landscape, KPI cards + hand-drawn charts
 * (pdfkit vector primitives, no canvas/image dependency — mirrors the
 * frontend's own no-library div-based bar chart) + summary tables. Streams
 * directly to the response.
 */

const PDFDocument = require('pdfkit');
const {
  money,
  drawTable,
  drawStatCardRow,
  drawBarChart,
  drawReportHeader,
  addPageFooters,
  COLORS,
  FONTS,
} = require('./pdfTable.util');
const { getBranding } = require('./branding.util');

function sectionHeading(doc, text) {
  if (doc.y > doc.page.height - doc.page.margins.bottom - 100) doc.addPage();
  doc.fillColor(COLORS.INK_900).font(FONTS.bold).fontSize(13).text(text, doc.page.margins.left, doc.y + 10);
  doc.moveDown(0.4);
}

async function renderAnalyticsPdf(res, data, filename) {
  const { presetLabel, currency, kpi, orderInsights, category, dailySales, products, inventory, orderStatusCounts } = data;
  const { siteName, logo, logoSvg } = await getBranding();

  const doc = new PDFDocument({ margin: 36, bufferPages: true, layout: 'landscape', size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  await drawReportHeader(doc, {
    logoSvg,
    logoBuffer: logo?.buffer || null,
    siteName,
    title: 'Analytics Report',
    generatedAt: new Date().toLocaleString('en-GB', { timeZone: 'UTC' }) + ' UTC',
    filterLines: [`Range: ${presetLabel} · Currency: ${currency}`],
  });

  drawStatCardRow(doc, [
    { label: 'Total Orders', value: String(kpi.totals.totalOrdersAllStatuses) },
    { label: 'Net Revenue', value: money(kpi.totals.netRevenue, currency) },
    { label: 'Average Order Value', value: money(kpi.totals.averageOrderValue, currency) },
    { label: 'Units Sold', value: String(kpi.totals.unitsSold) },
  ]);

  // Business insights (extended KPIs from getOrderInsights).
  sectionHeading(doc, 'Business Insights');
  drawTable(
    doc,
    [
      { key: 'a', label: 'Metric', width: 200 },
      { key: 'av', label: 'Value', width: 170, align: 'right' },
      { key: 'b', label: 'Metric', width: 200 },
      { key: 'bv', label: 'Value', width: 170, align: 'right' },
    ],
    [
      { a: 'Highest Order Value', av: money(orderInsights.highestOrderValue, currency), b: 'Unique Customers', bv: String(orderInsights.uniqueCustomers) },
      { a: 'Lowest Order Value', av: money(orderInsights.lowestOrderValue, currency), b: 'Repeat Customers', bv: String(orderInsights.repeatCustomers) },
      { a: 'Average Items / Order', av: String(orderInsights.averageItemsPerOrder), b: 'Cancelled Orders', bv: String(orderInsights.cancelledOrders) },
      { a: 'Paid vs Unpaid', av: `${orderInsights.paidOrders} / ${orderInsights.unpaidOrders}`, b: 'Cancelled %', bv: `${orderInsights.cancelledOrderPercentage}%` },
      { a: 'COD vs Online', av: `${orderInsights.codOrders} / ${orderInsights.onlineOrders}`, b: '', bv: '' },
    ]
  );

  // Revenue-over-time chart — capped to the most recent 30 points so bar
  // labels stay legible on one page.
  if (dailySales.length > 0) {
    const points = dailySales.slice(-30).map((p) => ({
      label: (p.date || p.month || '').slice(5),
      value: p.netRevenue,
    }));
    drawBarChart(doc, { title: 'Revenue over time', points, valueFormatter: (v) => money(v, currency) });
  }

  // Category revenue chart.
  if (category.categories.length > 0) {
    const points = category.categories.slice(0, 10).map((c) => ({ label: c.categoryTitle, value: c.revenue }));
    drawBarChart(doc, { title: 'Revenue by category', points, valueFormatter: (v) => money(v, currency) });
  }

  sectionHeading(doc, 'Category Breakdown');
  drawTable(
    doc,
    [
      { key: 'rank', label: '#', width: 40 },
      { key: 'category', label: 'Category', width: 200 },
      { key: 'orders', label: 'Orders', width: 80, align: 'right' },
      { key: 'units', label: 'Units', width: 80, align: 'right' },
      { key: 'revenue', label: 'Revenue', width: 110, align: 'right' },
      { key: 'share', label: 'Share %', width: 90, align: 'right' },
    ],
    category.categories.map((c) => ({
      rank: c.rank,
      category: c.categoryTitle,
      orders: String(c.orderCount),
      units: String(c.unitsSold),
      revenue: money(c.revenue, currency),
      share: `${c.revenueSharePercent}%`,
    }))
  );

  sectionHeading(doc, 'Best Selling Products');
  drawTable(
    doc,
    [
      { key: 'product', label: 'Product', width: 260 },
      { key: 'orders', label: 'Orders', width: 90, align: 'right' },
      { key: 'units', label: 'Units Sold', width: 100, align: 'right' },
      { key: 'revenue', label: 'Revenue', width: 130, align: 'right' },
    ],
    products.bestSellers.map((p) => ({
      product: p.productTitle,
      orders: String(p.orderCount),
      units: String(p.unitsSold),
      revenue: money(p.revenue, currency),
    }))
  );

  sectionHeading(doc, 'Least Selling Products');
  drawTable(
    doc,
    [
      { key: 'product', label: 'Product', width: 260 },
      { key: 'orders', label: 'Orders', width: 90, align: 'right' },
      { key: 'units', label: 'Units Sold', width: 100, align: 'right' },
      { key: 'revenue', label: 'Revenue', width: 130, align: 'right' },
    ],
    products.leastSellers.map((p) => ({
      product: p.productTitle,
      orders: String(p.orderCount),
      units: String(p.unitsSold),
      revenue: money(p.revenue, currency),
    }))
  );

  sectionHeading(doc, `Inventory (${inventory.totalPublishedProducts} published products, ${inventory.totalInventoryCount} units in stock)`);
  drawTable(
    doc,
    [
      { key: 'product', label: 'Low Stock Product', width: 260 },
      { key: 'quantity', label: 'Remaining', width: 100, align: 'right' },
    ],
    inventory.lowStockProducts.map((p) => ({ product: p.title, quantity: String(p.quantity) }))
  );
  if (inventory.outOfStockProducts.length > 0) {
    doc.moveDown(0.5);
    doc.fillColor(COLORS.INK_500).font('Helvetica').fontSize(9).text(
      `Out of stock (${inventory.outOfStockProducts.length}): ${inventory.outOfStockProducts.map((p) => p.title).join(', ')}`,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
    );
    doc.moveDown(0.5);
  }

  sectionHeading(doc, 'Orders by Status');
  const statusRows = Object.entries(orderStatusCounts).map(([status, v]) => ({
    status,
    orders: String(v.orderCount),
    revenue: money(v.revenue, currency),
  }));
  statusRows.push({ status: 'RETURNED', orders: 'Not tracked', revenue: '—' });
  drawTable(
    doc,
    [
      { key: 'status', label: 'Status', width: 150 },
      { key: 'orders', label: 'Orders', width: 120, align: 'right' },
      { key: 'revenue', label: 'Revenue', width: 130, align: 'right' },
    ],
    statusRows,
    { statusKey: 'status' }
  );

  addPageFooters(doc, { siteName });
  doc.end();
}

module.exports = { renderAnalyticsPdf };
