/**
 * inventory.low-stock — alert staff when published products run low.
 *
 * Emails a digest of products at/under LOW_STOCK_THRESHOLD to CONTACT_EMAIL (via the
 * email.send job, so it inherits retries). Zero-stock items are included — those are the
 * urgent ones. Runs hourly; silent when nothing is low.
 */

const prisma = require('../../config/db');
const { enqueue } = require('../queue');
const { QUEUES } = require('../queues');

async function handle() {
  const threshold = Math.max(0, parseInt(process.env.LOW_STOCK_THRESHOLD || '5', 10));

  const products = await prisma.product.findMany({
    where: { status: 'PUBLISHED', quantity: { lte: threshold } },
    select: { id: true, title: true, quantity: true },
    orderBy: { quantity: 'asc' },
    take: 200,
  });

  if (products.length === 0) return { lowStock: 0 };

  const adminEmail = process.env.CONTACT_EMAIL || process.env.FROM_EMAIL;
  if (adminEmail) {
    const rows = products
      .map((p) => `<tr><td style="padding:4px 12px 4px 0;">${p.title}</td><td style="padding:4px 0;text-align:right;color:${p.quantity === 0 ? '#dc2626' : '#b45309'};"><strong>${p.quantity}</strong></td></tr>`)
      .join('');
    const html = `
      <h2 style="font-family:Arial,sans-serif;">Low stock alert (${products.length})</h2>
      <p style="font-family:Arial,sans-serif;color:#4b5563;">Products at or below ${threshold} units:</p>
      <table style="font-family:Arial,sans-serif;border-collapse:collapse;">${rows}</table>`;
    await enqueue(QUEUES.EMAIL_SEND, {
      to: adminEmail,
      subject: `Amoon Bloom — ${products.length} product(s) low on stock`,
      html,
    });
  } else {
    console.warn('[jobs] inventory.low-stock: no CONTACT_EMAIL/FROM_EMAIL set; skipping alert email');
  }

  console.log(`[jobs] inventory.low-stock count=${products.length} threshold=${threshold}`);
  return { lowStock: products.length };
}

module.exports = {
  queue: QUEUES.INVENTORY_LOW_STOCK,
  handler: handle,
  cron: process.env.LOW_STOCK_CRON || '0 * * * *', // hourly
  options: { retryLimit: 0 },
};
