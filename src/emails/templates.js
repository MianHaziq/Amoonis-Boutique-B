/**
 * Branded HTML email templates (Amoon Bloom). Pure rendering — no DB, no transport.
 * Job handlers load the data and pass plain objects in; email.service.deliver() sends
 * the returned HTML. Keeping rendering here (not inline in handlers) means one place owns
 * the look, and the same layout wraps order confirmations and admin reports.
 *
 * Inline styles only — email clients ignore <style>/external CSS.
 */

const BRAND = 'Amoon Bloom';
const INK = '#1f2937';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';

function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(amount, currency = 'AED') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

/** Shared shell: dark brand header + white card. `subtitle` is optional. */
function layout(title, bodyHtml, subtitle) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f5f5f5;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
    <div style="background:#111;padding:24px 32px;text-align:center;">
      <h1 style="margin:0;color:#fff;font-size:22px;letter-spacing:.5px;">${esc(BRAND)}</h1>
      ${subtitle ? `<p style="margin:6px 0 0;color:rgba(255,255,255,.7);font-size:13px;">${esc(subtitle)}</p>` : ''}
    </div>
    <div style="padding:32px;color:${INK};font-size:15px;line-height:1.6;">
      ${bodyHtml}
    </div>
    <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid ${BORDER};">
      <p style="margin:0;color:${MUTED};font-size:12px;text-align:center;">Sent by ${esc(BRAND)}.</p>
    </div>
  </div>
</body></html>`;
}

/** Coloured pill for an order/payment status. */
function statusPill(text, kind = 'neutral') {
  const palette = {
    good: ['#065f46', '#d1fae5'],
    warn: ['#92400e', '#fef3c7'],
    bad: ['#991b1b', '#fee2e2'],
    neutral: ['#374151', '#f3f4f6'],
  };
  const [fg, bg] = palette[kind] || palette.neutral;
  return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${bg};color:${fg};font-size:12px;font-weight:600;">${esc(text)}</span>`;
}

function paymentStatusKind(s) {
  if (s === 'PAID') return 'good';
  if (s === 'FAILED') return 'bad';
  return 'warn'; // UNPAID
}

/* ----------------------------- Order confirmation ----------------------------- */

/**
 * @param {object} order - Prisma Order with `items` (productTitle, quantity, price),
 *   shipping snapshot fields, paymentStatus, paymentMethod, totalAmount, discountAmount,
 *   appliedPromoCode, createdAt. `currency` resolved by the caller.
 */
function renderOrderConfirmation(order) {
  const currency = order.currency || 'AED';
  const items = Array.isArray(order.items) ? order.items : [];

  const itemRows = items
    .map((it) => {
      const title = it.productTitle || it.product?.title || 'Item';
      const qty = it.quantity ?? 1;
      const line = Number(it.price) * qty;
      return `<tr>
        <td style="padding:10px 12px 10px 0;border-bottom:1px solid ${BORDER};">${esc(title)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid ${BORDER};text-align:center;color:${MUTED};">${esc(qty)}</td>
        <td style="padding:10px 0 10px 8px;border-bottom:1px solid ${BORDER};text-align:right;white-space:nowrap;">${esc(money(line, currency))}</td>
      </tr>`;
    })
    .join('');

  const subtotal = items.reduce((s, it) => s + Number(it.price) * (it.quantity ?? 1), 0);
  const discount = Number(order.discountAmount) || 0;

  const totalsRows = [
    `<tr><td style="padding:6px 0;color:${MUTED};">Subtotal</td><td></td><td style="padding:6px 0;text-align:right;">${esc(money(subtotal, currency))}</td></tr>`,
    discount > 0
      ? `<tr><td style="padding:6px 0;color:${MUTED};">Discount${order.appliedPromoCode ? ` (${esc(order.appliedPromoCode)})` : ''}</td><td></td><td style="padding:6px 0;text-align:right;color:#065f46;">-${esc(money(discount, currency))}</td></tr>`
      : '',
    `<tr><td style="padding:10px 0 0;font-weight:700;font-size:16px;">Total</td><td></td><td style="padding:10px 0 0;text-align:right;font-weight:700;font-size:16px;">${esc(money(order.totalAmount, currency))}</td></tr>`,
  ].join('');

  const ship = [
    order.shippingFullName,
    order.shippingPhone,
    [order.shippingStreetAddress, order.shippingApartment].filter(Boolean).join(', '),
    [order.shippingCity, order.shippingState, order.shippingPostalCode].filter(Boolean).join(', '),
    order.shippingCountry,
  ].filter(Boolean);

  const paymentMethodLabel = order.paymentMethod === 'MYFATOORAH' ? 'Card (online)' : 'Cash on delivery';

  const body = `
    <h2 style="margin:0 0 6px;font-size:20px;">Your order is placed successfully 🎉</h2>
    <p style="margin:0 0 20px;color:${MUTED};">Thank you! We've received order <strong>#${esc(order.orderNumber)}</strong> and it's being prepared. You can track it any time in the app.</p>

    <table style="width:100%;border-collapse:collapse;margin:0 0 8px;">
      <thead><tr>
        <th style="text-align:left;padding:0 12px 8px 0;font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.4px;">Product</th>
        <th style="text-align:center;padding:0 8px 8px;font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.4px;">Qty</th>
        <th style="text-align:right;padding:0 0 8px 8px;font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.4px;">Price</th>
      </tr></thead>
      <tbody>${itemRows || `<tr><td colspan="3" style="padding:10px 0;color:${MUTED};">Order details available in the app.</td></tr>`}</tbody>
    </table>

    <table style="width:100%;border-collapse:collapse;margin:0 0 24px;">${totalsRows}</table>

    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="vertical-align:top;width:50%;padding-right:12px;">
          <p style="margin:0 0 6px;font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.4px;">Payment</p>
          <p style="margin:0 0 4px;">${esc(paymentMethodLabel)}</p>
          <p style="margin:0;">${statusPill(order.paymentStatus || 'UNPAID', paymentStatusKind(order.paymentStatus))}</p>
        </td>
        <td style="vertical-align:top;width:50%;">
          <p style="margin:0 0 6px;font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.4px;">Delivery to</p>
          ${ship.length ? ship.map((l) => `<p style="margin:0 0 2px;">${esc(l)}</p>`).join('') : `<p style="margin:0;color:${MUTED};">—</p>`}
        </td>
      </tr>
    </table>`;

  return layout('Order confirmation', body, `Order #${order.orderNumber}`);
}

/* -------------------------------- Sales report -------------------------------- */

function deltaBadge(pct) {
  if (pct == null) return `<span style="color:${MUTED};font-size:12px;">— new</span>`;
  const up = pct >= 0;
  const color = up ? '#065f46' : '#991b1b';
  const arrow = up ? '▲' : '▼';
  return `<span style="color:${color};font-size:12px;font-weight:600;">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
}

function metricRow(label, value, pct) {
  return `<tr>
    <td style="padding:12px 0;border-bottom:1px solid ${BORDER};color:${MUTED};">${esc(label)}</td>
    <td style="padding:12px 0;border-bottom:1px solid ${BORDER};text-align:right;font-weight:700;font-size:16px;">${esc(value)}</td>
    <td style="padding:12px 0 12px 12px;border-bottom:1px solid ${BORDER};text-align:right;white-space:nowrap;">${deltaBadge(pct)}</td>
  </tr>`;
}

/**
 * @param {object} r - shape from report.service.buildSalesReport():
 *   { periodLabel, comparisonLabel, currency, current:{netRevenue,netSalesCount,unitsSold,
 *     averageOrderValue,distinctCustomers}, deltas:{netRevenue,netSalesCount,unitsSold,...},
 *     byStatus:{STATUS:{orderCount,revenue}}, topCategories:[{categoryTitle,revenue,unitsSold}] }
 */
function renderSalesReport(r) {
  const c = r.current || {};
  const d = r.deltas || {};
  const cur = r.currency || 'AED';

  const metrics = [
    metricRow('Net revenue', money(c.netRevenue, cur), d.netRevenue),
    metricRow('Orders (net)', String(c.netSalesCount ?? 0), d.netSalesCount),
    metricRow('Units sold', String(c.unitsSold ?? 0), d.unitsSold),
    metricRow('Avg order value', money(c.averageOrderValue, cur), d.averageOrderValue),
    metricRow('Distinct customers', String(c.distinctCustomers ?? 0), d.distinctCustomers),
  ].join('');

  const statusRows = Object.entries(r.byStatus || {})
    .filter(([, v]) => v.orderCount > 0)
    .map(
      ([status, v]) =>
        `<tr><td style="padding:6px 0;color:${MUTED};">${esc(status)}</td><td style="padding:6px 0;text-align:right;">${esc(v.orderCount)} order(s)</td><td style="padding:6px 0 6px 12px;text-align:right;">${esc(money(v.revenue, cur))}</td></tr>`
    )
    .join('');

  const topRows = (r.topCategories || [])
    .slice(0, 5)
    .map(
      (t, i) =>
        `<tr><td style="padding:6px 0;">${i + 1}. ${esc(t.categoryTitle || 'Uncategorised')}</td><td style="padding:6px 0;text-align:right;color:${MUTED};">${esc(t.unitsSold ?? 0)} unit(s)</td><td style="padding:6px 0 6px 12px;text-align:right;">${esc(money(t.revenue, cur))}</td></tr>`
    )
    .join('');

  const body = `
    <h2 style="margin:0 0 4px;font-size:20px;">${esc(r.title || 'Sales report')}</h2>
    <p style="margin:0 0 24px;color:${MUTED};">${esc(r.periodLabel)}${r.comparisonLabel ? ` &middot; vs ${esc(r.comparisonLabel)}` : ''}</p>

    <table style="width:100%;border-collapse:collapse;margin:0 0 28px;">${metrics}</table>

    ${
      statusRows
        ? `<p style="margin:0 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:${MUTED};">Orders by status</p>
           <table style="width:100%;border-collapse:collapse;margin:0 0 24px;">${statusRows}</table>`
        : ''
    }

    ${
      topRows
        ? `<p style="margin:0 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:${MUTED};">Top categories</p>
           <table style="width:100%;border-collapse:collapse;">${topRows}</table>`
        : ''
    }`;

  return layout(r.title || 'Sales report', body, r.periodLabel);
}

/* -------------------------------- Stock report -------------------------------- */

/**
 * @param {object} r - { threshold, products:[{title, quantity}] }
 */
function renderStockReport(r) {
  const products = r.products || [];
  const out = products.filter((p) => p.quantity === 0).length;

  const rows = products
    .map(
      (p) =>
        `<tr>
          <td style="padding:8px 12px 8px 0;border-bottom:1px solid ${BORDER};">${esc(p.title)}</td>
          <td style="padding:8px 0;border-bottom:1px solid ${BORDER};text-align:right;">${
            p.quantity === 0
              ? statusPill('OUT OF STOCK', 'bad')
              : `<strong style="color:#b45309;">${esc(p.quantity)}</strong>`
          }</td>
        </tr>`
    )
    .join('');

  const body = `
    <h2 style="margin:0 0 4px;font-size:20px;">Daily stock report</h2>
    <p style="margin:0 0 20px;color:${MUTED};">${products.length} product(s) at or below ${esc(r.threshold)} unit(s)${out ? ` &middot; <strong style="color:#991b1b;">${out} out of stock</strong>` : ''}.</p>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="text-align:left;padding:0 12px 8px 0;font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.4px;">Product</th>
        <th style="text-align:right;padding:0 0 8px;font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.4px;">In stock</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  return layout('Daily stock report', body);
}

module.exports = { renderOrderConfirmation, renderSalesReport, renderStockReport, money };
