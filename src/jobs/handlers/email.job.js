/**
 * email.send — deliver one transactional email (Resend, SMTP fallback).
 *
 * Data shapes:
 *   { to, subject, html }                              — generic (password reset, reports…)
 *   { template: 'order-confirmation', orderId, to }    — order loaded + rendered here
 *
 * For order confirmations we load the order FROM THE DB here (single source of truth)
 * rather than trusting a caller-built object, so the rich template (items, shipping,
 * payment status) can't drift between the COD and online-payment call sites.
 *
 * Throwing propagates the failure to pg-boss, which retries with backoff. The whole
 * point of moving email off the request path is that a slow/failing SMTP server no
 * longer blocks the HTTP response, and a transient failure is retried automatically.
 */

const prisma = require('../../config/db');
const emailService = require('../../services/email.service');
const templates = require('../../emails/templates');
const { QUEUES } = require('../queues');

async function buildOrderConfirmation(orderId) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: { select: { productTitle: true, quantity: true, price: true } },
    },
  });
  if (!order) return null;

  // No currency column on Order — use the store's configured currency (same source the
  // analytics/category endpoints use), defaulting to AED.
  const settings = await prisma.settings
    .findUnique({ where: { id: 'default' }, select: { currency: true } })
    .catch(() => null);
  order.currency = settings?.currency || 'AED';

  return {
    subject: `Your Amoon Bloom order #${order.orderNumber} is placed`,
    html: templates.renderOrderConfirmation(order),
  };
}

async function handle(data) {
  let { to, subject, html, template, orderId } = data;

  if (template === 'order-confirmation') {
    if (!orderId) {
      console.warn('[jobs] email.send order-confirmation skipped — missing orderId');
      return;
    }
    const built = await buildOrderConfirmation(orderId);
    if (!built) {
      console.warn(`[jobs] email.send order-confirmation skipped — order ${orderId} not found`);
      return;
    }
    subject = built.subject;
    html = built.html;
  }

  if (!to || !subject || !html) {
    console.warn('[jobs] email.send skipped — missing to/subject/html');
    return;
  }

  await emailService.deliver(to, subject, html);
}

module.exports = {
  queue: QUEUES.EMAIL_SEND,
  handler: handle,
  // JOB-2: a transactional email (password reset, order confirmation) that exhausts its
  // retries is routed to the dead-letter queue instead of being purged with only a log line.
  options: { retryLimit: 5, retryDelay: 30, retryBackoff: true, deadLetter: QUEUES.DEAD_LETTER },
};
