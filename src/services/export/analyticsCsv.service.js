/**
 * Analytics Export — CSV renderer. Reuses the SAME payload as the Excel/PDF
 * renderers (from analyticsExport.service.getAnalyticsForExport). Emits a
 * multi-section CSV (one labelled block per analytics table) so the whole
 * dashboard fits in one importable file.
 */

const { buildCsv, keyValueSection } = require('./csv.util');

function renderAnalyticsCsv(res, data, filename) {
  const { presetLabel, currency, kpi, orderInsights, category, dailySales, weeklySales, monthlySales, products, inventory, orderStatusCounts } = data;

  const sections = [
    keyValueSection(`Amoonis Boutique — Analytics Export (${presetLabel})`, [
      ['Generated', new Date().toISOString()],
      ['Currency', currency],
      ['Total Orders (all statuses)', kpi.totals.totalOrdersAllStatuses],
      ['Net Revenue', kpi.totals.netRevenue],
      ['Average Order Value', kpi.totals.averageOrderValue],
      ['Units Sold', kpi.totals.unitsSold],
      ['Distinct Customers', kpi.totals.distinctCustomers],
      ['Highest Order Value', orderInsights.highestOrderValue],
      ['Lowest Order Value', orderInsights.lowestOrderValue],
      ['Average Items Per Order', orderInsights.averageItemsPerOrder],
      ['Paid Orders', orderInsights.paidOrders],
      ['Unpaid Orders', orderInsights.unpaidOrders],
      ['COD Orders', orderInsights.codOrders],
      ['Online Orders', orderInsights.onlineOrders],
      ['Repeat Customers', orderInsights.repeatCustomers],
      ['Cancelled Orders', orderInsights.cancelledOrders],
      ['Cancelled %', orderInsights.cancelledOrderPercentage],
      ['Refunded Orders', orderInsights.refundedOrders],
      ['Refunded %', orderInsights.refundedOrderPercentage],
    ]),
    {
      title: 'Revenue by Day',
      columns: [
        { key: 'date', header: 'Date' },
        { key: 'netOrderCount', header: 'Orders' },
        { key: 'netRevenue', header: 'Revenue' },
      ],
      rows: dailySales.map((p) => ({ date: p.date ?? p.month ?? '', netOrderCount: p.netOrderCount, netRevenue: p.netRevenue })),
    },
    {
      title: 'Revenue by Week',
      columns: [
        { key: 'weekStart', header: 'Week Starting' },
        { key: 'netOrderCount', header: 'Orders' },
        { key: 'netRevenue', header: 'Revenue' },
      ],
      rows: weeklySales,
    },
    {
      title: 'Revenue by Month',
      columns: [
        { key: 'month', header: 'Month' },
        { key: 'netOrderCount', header: 'Orders' },
        { key: 'netRevenue', header: 'Revenue' },
      ],
      rows: monthlySales,
    },
    {
      title: 'Categories',
      columns: [
        { key: 'rank', header: 'Rank' },
        { key: 'categoryTitle', header: 'Category' },
        { key: 'orderCount', header: 'Orders' },
        { key: 'unitsSold', header: 'Units Sold' },
        { key: 'revenue', header: 'Revenue' },
        { key: 'revenueSharePercent', header: 'Revenue Share %' },
      ],
      rows: category.categories,
    },
    {
      title: 'Best Selling Products',
      columns: [
        { key: 'productTitle', header: 'Product' },
        { key: 'orderCount', header: 'Orders' },
        { key: 'unitsSold', header: 'Units Sold' },
        { key: 'revenue', header: 'Revenue' },
      ],
      rows: products.bestSellers,
    },
    {
      title: 'Least Selling Products',
      columns: [
        { key: 'productTitle', header: 'Product' },
        { key: 'orderCount', header: 'Orders' },
        { key: 'unitsSold', header: 'Units Sold' },
        { key: 'revenue', header: 'Revenue' },
      ],
      rows: products.leastSellers,
    },
    {
      title: `Inventory (total in stock: ${inventory.totalInventoryCount})`,
      columns: [
        { key: 'title', header: 'Low Stock Product' },
        { key: 'quantity', header: 'Quantity Remaining' },
      ],
      rows: inventory.lowStockProducts,
    },
    {
      title: 'Out of Stock Products',
      columns: [{ key: 'title', header: 'Product' }],
      rows: inventory.outOfStockProducts,
    },
    {
      title: 'Orders by Status',
      columns: [
        { key: 'status', header: 'Status' },
        { key: 'orderCount', header: 'Order Count' },
        { key: 'revenue', header: 'Revenue' },
      ],
      rows: [
        ...Object.entries(orderStatusCounts).map(([status, v]) => ({ status, orderCount: v.orderCount, revenue: v.revenue })),
      ],
    },
  ];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buildCsv(sections));
}

module.exports = { renderAnalyticsCsv };
