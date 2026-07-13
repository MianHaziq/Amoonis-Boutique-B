/**
 * Order Export — CSV renderer. Reuses the SAME shaped dataset as the Excel/PDF
 * renderers (from orderExport.service.getOrdersForExport) — no duplicated
 * business logic. Emits a multi-section CSV (Summary + Orders + Order Items)
 * so nothing the workbook carries is lost in the CSV.
 */

const { buildCsv, keyValueSection } = require('./csv.util');

/**
 * @param {import('express').Response} res
 * @param {{ summary, orderRows, itemRows, filtersApplied }} data
 * @param {string} filename
 */
function renderOrdersCsv(res, data, filename) {
  const { summary, orderRows, itemRows, filtersApplied } = data;

  const csv = buildCsv([
    keyValueSection('Amoonis Boutique — Orders Export', [
      ['Generated', new Date().toISOString()],
      ['Date range', `${filtersApplied.dateFrom} to ${filtersApplied.dateTo}`],
      ['Order status', filtersApplied.status],
      ['Payment status', filtersApplied.paymentStatus],
      ['Region', filtersApplied.region],
      ['Total Orders', summary.totalOrders],
      ['Total Revenue', summary.totalRevenue],
      ['Average Order Value', summary.averageOrderValue],
      ['Total Quantity Sold', summary.totalQuantitySold],
      ['Highest Order Value', summary.highestOrderValue],
      ['Lowest Order Value', summary.lowestOrderValue],
      ['Average Items Per Order', summary.averageItemsPerOrder],
      ['Paid Orders', summary.paidOrders],
      ['Unpaid Orders', summary.unpaidOrders],
      ['COD Orders', summary.codOrders],
      ['Online Orders', summary.onlineOrders],
      ['Unique Customers', summary.uniqueCustomers],
      ['Repeat Customers', summary.repeatCustomers],
      ['Cancelled Orders', summary.cancelledOrders],
      ['Cancelled %', summary.cancelledOrderPercentage],
    ]),
    {
      title: 'Orders',
      columns: [
        { key: 'orderNumber', header: 'Order #' },
        { key: 'createdAt', header: 'Date & Time' },
        { key: 'customerName', header: 'Customer Name' },
        { key: 'customerPhone', header: 'Phone' },
        { key: 'customerEmail', header: 'Email' },
        { key: 'city', header: 'City' },
        { key: 'shippingAddress', header: 'Shipping Address' },
        { key: 'paymentMethod', header: 'Payment Method' },
        { key: 'paymentStatus', header: 'Payment Status' },
        { key: 'status', header: 'Order Status' },
        { key: 'currency', header: 'Currency' },
        { key: 'deliveryCharges', header: 'Delivery Charges' },
        { key: 'discountAmount', header: 'Discount' },
        { key: 'taxAmount', header: 'Tax' },
        { key: 'totalAmount', header: 'Total Amount' },
        { key: 'itemCount', header: 'Item Count' },
      ],
      rows: orderRows.map((r) => ({
        ...r,
        createdAt: new Date(r.createdAt).toISOString(),
      })),
    },
    {
      title: 'Order Items',
      columns: [
        { key: 'orderNumber', header: 'Order #' },
        { key: 'productName', header: 'Product Name' },
        { key: 'sku', header: 'SKU' },
        { key: 'variant', header: 'Variant' },
        { key: 'quantity', header: 'Quantity' },
        { key: 'currency', header: 'Currency' },
        { key: 'unitPrice', header: 'Unit Price' },
        { key: 'lineTotal', header: 'Line Total' },
      ],
      rows: itemRows,
    },
  ]);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

module.exports = { renderOrdersCsv };
