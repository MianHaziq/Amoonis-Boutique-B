/**
 * Branded HTML email templates (Amoon Bloom). Pure rendering — no DB, no transport.
 * Job handlers load the data and pass plain objects in; email.service.deliver() sends
 * the returned HTML. Keeping rendering here (not inline in handlers) means one place owns
 * the look, and the same layout wraps order confirmations, status updates, and admin reports.
 *
 * Inline styles only — email clients ignore <style>/external CSS.
 */

const BRAND = 'Amoon Bloom';
const LEGAL_ENTITY = 'AMOON BLOOM Trading L.L.C S.O.C™';
const SUPPORT_EMAIL = 'management@amoonbloom.com';
// Hosted on the same Bunny CDN used for product/banner images — see
// src/emails/assets/logo-email.png (rasterized from the storefront's logo.svg;
// email clients, especially desktop Outlook, don't reliably render inline SVG).
const LOGO_URL = 'https://ammon-pull-zone.b-cdn.net/email-assets/amoon-bloom-logo.png';

const INK = '#1f2937';
const MUTED = '#6b7280';
const BORDER = '#e9dfe3';
const CREAM = '#f7f6f3';
const BLOOM = '#d4316d';
const BLOOM_DARK = '#b32257';
const BLOOM_TINT = '#fdf2f6';

function frontendUrl() {
  return (process.env.FRONTEND_URL || 'https://amoonis-boutique.com').replace(/\/+$/, '');
}

function orderTrackUrl(orderId) {
  return `${frontendUrl()}/order/status?id=${encodeURIComponent(orderId)}`;
}

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

function formatDate(d) {
  try {
    return new Date(d).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return '';
  }
}

/** Shared shell: branded logo header + white card + contact footer. `subtitle` is optional. */
function layout(title, bodyHtml, subtitle) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${esc(title)}</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:${CREAM};padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(31,23,23,.06);border:1px solid ${BORDER};">
    <div style="background:linear-gradient(135deg,${BLOOM_TINT} 0%,#fefaf8 100%);padding:28px 32px;text-align:center;border-bottom:3px solid ${BLOOM};">
      <img src="${LOGO_URL}" alt="${esc(BRAND)}" width="150" style="display:inline-block;height:auto;max-width:150px;border:0;">
      ${subtitle ? `<p style="margin:14px 0 0;color:${MUTED};font-size:13px;letter-spacing:.2px;">${esc(subtitle)}</p>` : ''}
    </div>
    <div style="padding:32px;color:${INK};font-size:15px;line-height:1.6;">
      ${bodyHtml}
    </div>
    <div style="padding:20px 32px;background:${CREAM};border-top:1px solid ${BORDER};text-align:center;">
      <p style="margin:0 0 4px;color:${INK};font-size:12px;font-weight:600;">${esc(LEGAL_ENTITY)}</p>
      <p style="margin:0;color:${MUTED};font-size:12px;">Questions about your order? <a href="mailto:${SUPPORT_EMAIL}" style="color:${BLOOM_DARK};text-decoration:none;font-weight:600;">${SUPPORT_EMAIL}</a></p>
    </div>
  </div>
</body></html>`;
}

/** Centered brand-pink pill CTA button. */
function ctaButton(label, url) {
  return `<p style="margin:28px 0 0;text-align:center;">
    <a href="${esc(url)}" style="display:inline-block;padding:13px 34px;background:${BLOOM};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;border-radius:999px;">${esc(label)}</a>
  </p>`;
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

function totalsRow(label, value, valueColor) {
  return `<tr><td style="padding:6px 0;color:${MUTED};">${label}</td><td></td><td style="padding:6px 0;text-align:right;${valueColor ? `color:${valueColor};` : ''}">${value}</td></tr>`;
}

/* ----------------------------- Order confirmation ----------------------------- */

/**
 * @param {object} order - Prisma Order with `items` (productTitle, quantity, price,
 *   selectedOptions, giftCardSelected, customName, product.image), shipping snapshot
 *   fields, taxAmount/vatRatePercent/vatInclusive, shippingAmount, paymentStatus,
 *   paymentMethod, totalAmount, discountAmount, appliedPromoCode, createdAt, currency.
 */
function renderOrderConfirmation(order) {
  const currency = order.currency || 'AED';
  const items = Array.isArray(order.items) ? order.items : [];
  const name = order.shippingFullName || order.guestName || '';

  const itemRows = items
    .map((it) => {
      const title = it.productTitle || it.product?.title || 'Item';
      const image = it.product?.images?.[0]?.url;
      const qty = it.quantity ?? 1;
      const line = Number(it.price) * qty;
      const variant =
        it.selectedOptions && typeof it.selectedOptions === 'object' && !Array.isArray(it.selectedOptions)
          ? Object.entries(it.selectedOptions)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ')
          : '';
      const giftLine = [it.giftCardSelected ? 'Gift card' : null, it.customName].filter(Boolean).join(' · ');
      const thumb = image
        ? `<img src="${esc(image)}" width="48" height="48" style="display:block;border-radius:8px;object-fit:cover;border:0;" alt="">`
        : `<div style="width:48px;height:48px;border-radius:8px;background:${BLOOM_TINT};"></div>`;
      return `<tr>
        <td style="padding:12px 12px 12px 0;border-bottom:1px solid ${BORDER};vertical-align:top;">
          <table style="border-collapse:collapse;"><tr>
            <td style="width:48px;vertical-align:top;">${thumb}</td>
            <td style="padding-left:12px;vertical-align:top;">
              <p style="margin:0;font-weight:500;">${esc(title)}</p>
              ${variant ? `<p style="margin:2px 0 0;font-size:12px;color:${MUTED};">${esc(variant)}</p>` : ''}
              ${giftLine ? `<p style="margin:2px 0 0;font-size:12px;color:${BLOOM_DARK};">${esc(giftLine)}</p>` : ''}
            </td>
          </tr></table>
        </td>
        <td style="padding:12px 8px;border-bottom:1px solid ${BORDER};text-align:center;color:${MUTED};vertical-align:top;">${esc(qty)}</td>
        <td style="padding:12px 0 12px 8px;border-bottom:1px solid ${BORDER};text-align:right;white-space:nowrap;vertical-align:top;">${esc(money(line, currency))}</td>
      </tr>`;
    })
    .join('');

  const subtotal =
    order.subtotalAmount != null
      ? Number(order.subtotalAmount)
      : items.reduce((s, it) => s + Number(it.price) * (it.quantity ?? 1), 0);
  const discount = Number(order.discountAmount) || 0;
  const taxAmount = Number(order.taxAmount) || 0;
  const showVat = order.vatRatePercent != null && taxAmount > 0;
  const shippingAmount = Number(order.shippingAmount) || 0;

  const totalsRows = [
    totalsRow('Subtotal', esc(money(subtotal, currency))),
    discount > 0
      ? totalsRow(
          `Discount${order.appliedPromoCode ? ` (${esc(order.appliedPromoCode)})` : ''}`,
          `-${esc(money(discount, currency))}`,
          '#065f46'
        )
      : '',
    showVat
      ? totalsRow(
          order.vatInclusive ? `Includes VAT (${esc(Number(order.vatRatePercent))}%)` : `VAT (${esc(Number(order.vatRatePercent))}%)`,
          order.vatInclusive ? esc(money(taxAmount, currency)) : `+ ${esc(money(taxAmount, currency))}`
        )
      : '',
    totalsRow('Shipping', shippingAmount > 0 ? esc(money(shippingAmount, currency)) : 'Free'),
    `<tr><td style="padding:10px 0 0;font-weight:700;font-size:16px;">Total</td><td></td><td style="padding:10px 0 0;text-align:right;font-weight:700;font-size:16px;">${esc(money(order.totalAmount, currency))}</td></tr>`,
  ].join('');

  const ship = [
    order.shippingFullName,
    order.shippingPhone,
    [order.shippingArea, order.shippingZoneName].filter(Boolean).join(', '),
    [order.shippingStreetAddress, order.shippingApartment].filter(Boolean).join(', '),
    [order.shippingCity, order.shippingState, order.shippingPostalCode].filter(Boolean).join(', '),
    order.shippingCountry,
  ].filter(Boolean);

  const paymentMethodLabel = order.paymentMethod === 'MYFATOORAH' ? 'Card (online)' : 'Cash on delivery';

  const body = `
    ${name ? `<p style="margin:0 0 14px;color:${MUTED};">Hi ${esc(name)},</p>` : ''}
    <h2 style="margin:0 0 6px;font-size:20px;">Your order is placed successfully 🎉</h2>
    <p style="margin:0 0 20px;color:${MUTED};">Thank you! We've received order <strong>#${esc(order.orderNumber)}</strong> and it's being prepared. You can track it any time using the button below.</p>

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
    </table>
    ${ctaButton('Track your order', orderTrackUrl(order.id))}`;

  return layout('Order confirmation', body, `Order #${order.orderNumber} · ${formatDate(order.createdAt)}`);
}

/* ------------------------------- Order status update ------------------------------- */

const STATUS_META = {
  SHIPPED: {
    emoji: '📦',
    heading: 'Your order has shipped!',
    line: "Great news — it's on its way to you.",
  },
  DELIVERED: {
    emoji: '🎉',
    heading: 'Your order has been delivered!',
    line: 'We hope you love it. Thank you for shopping with us.',
  },
};

/**
 * Lighter-weight status-change email (Shipped / Delivered) — a short, celebratory
 * update rather than re-sending the full itemised receipt every time.
 * @param {object} order - Prisma Order (id, orderNumber, totalAmount, currency,
 *   shippingFullName, guestName, createdAt).
 * @param {string} status - 'SHIPPED' | 'DELIVERED'
 */
function renderOrderStatusUpdate(order, status) {
  const meta = STATUS_META[status] || {
    emoji: '📬',
    heading: 'Order update',
    line: `Your order status is now ${status.toLowerCase()}.`,
  };
  const currency = order.currency || 'AED';
  const name = order.shippingFullName || order.guestName || '';

  const body = `
    <div style="text-align:center;">
      <p style="margin:0 0 10px;font-size:40px;line-height:1;">${meta.emoji}</p>
      ${name ? `<p style="margin:0 0 4px;color:${MUTED};">Hi ${esc(name)},</p>` : ''}
      <h2 style="margin:0 0 8px;font-size:20px;">${esc(meta.heading)}</h2>
      <p style="margin:0;color:${MUTED};">${esc(meta.line)}</p>
      <p style="margin:18px 0 0;font-size:13px;color:${MUTED};">Order <strong style="color:${INK};">#${esc(order.orderNumber)}</strong> &middot; ${esc(money(order.totalAmount, currency))}</p>
    </div>
    ${ctaButton('View your order', orderTrackUrl(order.id))}`;

  return layout(meta.heading, body, `Order #${order.orderNumber}`);
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

module.exports = {
  renderOrderConfirmation,
  renderOrderStatusUpdate,
  renderSalesReport,
  renderStockReport,
  money,
};
