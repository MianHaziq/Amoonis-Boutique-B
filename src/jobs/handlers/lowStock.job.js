/**
 * inventory.low-stock — ONE daily digest of products at/under LOW_STOCK_THRESHOLD,
 * emailed to every active ADMIN (zero-stock items flagged as the urgent ones).
 *
 * Runs once a day (was hourly + one email per run, which spammed inboxes — see the
 * Resend log). Silent when nothing is low. Each admin gets their own email.send job so
 * one bad address doesn't block the others, and each inherits the email retry policy.
 */

const { enqueue } = require('../queue');
const { QUEUES } = require('../queues');
const reportService = require('../../services/report.service');
const templates = require('../../emails/templates');

async function handle() {
  const { threshold, products } = await reportService.buildStockReport();
  if (products.length === 0) return { lowStock: 0 };

  const recipients = await reportService.getAdminRecipients();
  if (recipients.length === 0) {
    console.warn('[jobs] inventory.low-stock: no admin recipients/CONTACT_EMAIL set; skipping');
    return { lowStock: products.length, emailed: 0 };
  }

  const html = templates.renderStockReport({ threshold, products });
  const outOfStock = products.filter((p) => p.quantity === 0).length;
  const subject = `Amoon Bloom — daily stock report (${products.length} low${outOfStock ? `, ${outOfStock} out` : ''})`;

  await Promise.all(
    recipients.map((to) => enqueue(QUEUES.EMAIL_SEND, { to, subject, html }))
  );

  console.log(`[jobs] inventory.low-stock count=${products.length} threshold=${threshold} emailed=${recipients.length}`);
  return { lowStock: products.length, emailed: recipients.length };
}

module.exports = {
  queue: QUEUES.INVENTORY_LOW_STOCK,
  handler: handle,
  cron: process.env.LOW_STOCK_CRON || '0 8 * * *', // daily 08:00 (JOBS_TIMEZONE, default Asia/Dubai)
  options: { retryLimit: 0 },
};
