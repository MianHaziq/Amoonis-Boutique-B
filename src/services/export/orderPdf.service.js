/**
 * Order Export — PDF renderer. Landscape, branded header/footer on every page,
 * KPI cards + business-insights table + order-level table (full per-line-item
 * detail lives in the Excel export) + financial summary. Streams to response.
 * All styling comes from pdfTable.util.js / exportTheme.js.
 */

const PDFDocument = require('pdfkit');
const {
  money,
  drawTable,
  drawStatCardRow,
  drawReportHeader,
  addPageFooters,
  COLORS,
  FONTS,
} = require('./pdfTable.util');
const { getBranding } = require('./branding.util');

/**
 * @param {import('express').Response} res
 * @param {{ summary, orderRows, filtersApplied }} data
 * @param {string} filename
 */
async function renderOrdersPdf(res, data, filename) {
  const { summary, orderRows, filtersApplied } = data;
  const { siteName, logo, logoSvg } = await getBranding();
  // Single-currency result (the common case): plain top-line figures, same as
  // before. A mixed result (e.g. "All regions" spanning AED + SAR — the export
  // dialog's default) never blends amounts across currencies — see the
  // "Revenue By Currency" table below instead of a single misleading number.
  const singleCurrency = summary.currencyBreakdown.length === 1 ? summary.currencyBreakdown[0] : null;
  const currency = singleCurrency?.currency || '';

  const doc = new PDFDocument({ margin: 36, bufferPages: true, layout: 'landscape', size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  await drawReportHeader(doc, {
    logoSvg,
    logoBuffer: logo?.buffer || null,
    siteName,
    title: 'Orders Report',
    generatedAt: new Date().toLocaleString('en-GB', { timeZone: 'UTC' }) + ' UTC',
    filterLines: [
      `Date range: ${filtersApplied.dateFrom} to ${filtersApplied.dateTo}`,
      `Order status: ${filtersApplied.status} · Payment status: ${filtersApplied.paymentStatus} · Region: ${filtersApplied.region}`,
    ],
  });

  drawStatCardRow(doc, [
    { label: 'Total Orders', value: String(summary.totalOrders) },
    {
      label: 'Total Revenue',
      value: singleCurrency ? money(singleCurrency.totalRevenue, currency) : 'See breakdown below',
    },
    {
      label: 'Average Order Value',
      value: singleCurrency ? money(singleCurrency.averageOrderValue, currency) : '—',
    },
    { label: 'Total Quantity Sold', value: String(summary.totalQuantitySold) },
  ]);

  // Business insights (the extended KPIs) as a compact two-column table.
  doc.fillColor(COLORS.INK_900).font(FONTS.bold).fontSize(13).text('Business Insights', doc.page.margins.left, doc.y + 4);
  doc.moveDown(0.4);
  drawTable(
    doc,
    [
      { key: 'a', label: 'Metric', width: 200 },
      { key: 'av', label: 'Value', width: 170, align: 'right' },
      { key: 'b', label: 'Metric', width: 200 },
      { key: 'bv', label: 'Value', width: 170, align: 'right' },
    ],
    [
      {
        a: 'Highest Order Value',
        av: singleCurrency ? money(singleCurrency.highestOrderValue, currency) : '—',
        b: 'Unique Customers',
        bv: String(summary.uniqueCustomers),
      },
      {
        a: 'Lowest Order Value',
        av: singleCurrency ? money(singleCurrency.lowestOrderValue, currency) : '—',
        b: 'Repeat Customers',
        bv: String(summary.repeatCustomers),
      },
      { a: 'Average Items / Order', av: String(summary.averageItemsPerOrder), b: 'Cancelled Orders', bv: String(summary.cancelledOrders) },
      { a: 'Paid vs Unpaid', av: `${summary.paidOrders} / ${summary.unpaidOrders}`, b: 'Cancelled %', bv: `${summary.cancelledOrderPercentage}%` },
      { a: 'COD vs Online', av: `${summary.codOrders} / ${summary.onlineOrders}`, b: '', bv: '' },
    ]
  );

  // Revenue-by-currency table — always shown when there's more than one
  // currency in the result set (never blended into a single misleading number).
  if (!singleCurrency) {
    doc.fillColor(COLORS.INK_900).font(FONTS.bold).fontSize(13).text('Revenue By Currency', doc.page.margins.left, doc.y + 10);
    doc.moveDown(0.4);
    drawTable(
      doc,
      [
        { key: 'currency', label: 'Currency', width: 90 },
        { key: 'orders', label: 'Orders', width: 90, align: 'right' },
        { key: 'revenue', label: 'Total Revenue', width: 140, align: 'right' },
        { key: 'avg', label: 'Average', width: 130, align: 'right' },
        { key: 'high', label: 'Highest', width: 130, align: 'right' },
        { key: 'low', label: 'Lowest', width: 130, align: 'right' },
      ],
      summary.currencyBreakdown.map((b) => ({
        currency: b.currency,
        orders: String(b.totalOrders),
        revenue: money(b.totalRevenue, b.currency),
        avg: money(b.averageOrderValue, b.currency),
        high: money(b.highestOrderValue, b.currency),
        low: money(b.lowestOrderValue, b.currency),
      }))
    );
  }

  doc.fillColor(COLORS.INK_900).font(FONTS.bold).fontSize(13).text('Orders', doc.page.margins.left, doc.y + 10);
  doc.moveDown(0.4);
  const columns = [
    { key: 'orderNumber', label: 'Order #', width: 55 },
    { key: 'date', label: 'Date', width: 70 },
    { key: 'customer', label: 'Customer', width: 130 },
    { key: 'region', label: 'Region', width: 55 },
    { key: 'city', label: 'City', width: 70 },
    { key: 'payment', label: 'Payment', width: 100 },
    { key: 'status', label: 'Status', width: 80 },
    { key: 'items', label: 'Items', width: 40, align: 'right' },
    { key: 'total', label: 'Total', width: 90, align: 'right' },
  ];
  const rows = orderRows.map((o) => ({
    orderNumber: `#${o.orderNumber}`,
    date: new Date(o.createdAt).toLocaleDateString('en-GB'),
    customer: o.customerName + (o.isGuest ? ' (Guest)' : ''),
    region: o.region,
    city: o.city,
    payment: `${o.paymentMethod} / ${o.paymentStatus}`,
    status: o.status,
    items: String(o.itemCount),
    total: money(o.totalAmount, o.currency),
  }));
  drawTable(doc, columns, rows, { statusKey: 'status' });

  // Financial summary section — same "no cross-currency blending" rule as
  // above: only rendered when the whole result set shares one currency.
  if (singleCurrency) {
    const totalDiscount = orderRows.reduce((s, o) => s + o.discountAmount, 0);
    const totalTax = orderRows.reduce((s, o) => s + o.taxAmount, 0);
    const totalDelivery = orderRows.reduce((s, o) => s + o.deliveryCharges, 0);
    if (doc.y > doc.page.height - doc.page.margins.bottom - 140) doc.addPage();
    doc.fillColor(COLORS.INK_900).font(FONTS.bold).fontSize(13).text('Financial Summary', doc.page.margins.left, doc.y + 10);
    doc.moveDown(0.5);
    drawTable(
      doc,
      [
        { key: 'label', label: 'Item', width: 220 },
        { key: 'value', label: 'Amount', width: 150, align: 'right' },
      ],
      [
        { label: 'Gross Revenue (before discounts)', value: money(singleCurrency.totalRevenue + totalDiscount, currency) },
        { label: 'Total Discounts Given', value: `− ${money(totalDiscount, currency)}` },
        { label: 'Total Delivery Charges', value: money(totalDelivery, currency) },
        { label: 'Total Tax', value: money(totalTax, currency) },
        { label: 'Net Revenue', value: money(singleCurrency.totalRevenue, currency) },
      ]
    );
  }

  addPageFooters(doc, { siteName });
  doc.end();
}

module.exports = { renderOrdersPdf };
