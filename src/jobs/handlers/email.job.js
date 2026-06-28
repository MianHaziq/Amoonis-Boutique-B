/**
 * email.send — deliver one transactional email (Resend, SMTP fallback).
 *
 * Data shapes:
 *   { to, subject, html }                         — generic (password reset, etc.)
 *   { template: 'order-confirmation', to, order } — rendered server-side here
 *
 * Throwing propagates the failure to pg-boss, which retries with backoff. The whole
 * point of moving email off the request path is that a slow/failing SMTP server no
 * longer blocks the HTTP response, and a transient failure is retried automatically.
 */

const emailService = require('../../services/email.service');
const { QUEUES } = require('../queues');

async function handle(data) {
  let { to, subject, html, template, order } = data;

  if (template === 'order-confirmation') {
    if (!order) return;
    subject = `Your Amoon Bloom order #${order.orderNumber} is confirmed`;
    html = emailService.renderOrderConfirmation(order);
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
