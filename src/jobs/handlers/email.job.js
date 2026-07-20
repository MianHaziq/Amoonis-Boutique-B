/**
 * email.send — deliver one transactional email (Resend, SMTP fallback).
 *
 * Data shapes:
 *   { to, subject, html }                                — generic (password reset, reports…)
 *   { template: 'order-confirmation', orderId, to }       — order loaded + rendered here
 *   { template: 'order-status', orderId, status }         — Shipped/Delivered update; loads
 *                                                            the order AND resolves the
 *                                                            recipient itself (no `to` from
 *                                                            the caller — never stale/omitted)
 *
 * For order emails we load the order FROM THE DB here (single source of truth) rather than
 * trusting a caller-built object, so the rich template (items, shipping, payment status,
 * currency) can't drift between the COD and online-payment call sites.
 *
 * Throwing propagates the failure to pg-boss, which retries with backoff. The whole
 * point of moving email off the request path is that a slow/failing SMTP server no
 * longer blocks the HTTP response, and a transient failure is retried automatically.
 */

const prisma = require('../../config/db');
const emailService = require('../../services/email.service');
const templates = require('../../emails/templates');
const { QUEUES } = require('../queues');

const ORDER_ITEMS_INCLUDE = {
  select: {
    productTitle: true,
    quantity: true,
    price: true,
    selectedOptions: true,
    giftCardSelected: true,
    customName: true,
    product: {
      select: {
        title: true,
        images: { select: { url: true }, orderBy: { sortOrder: 'asc' }, take: 1 },
      },
    },
  },
};

async function loadOrder(orderId) {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: ORDER_ITEMS_INCLUDE,
      user: { select: { email: true } },
    },
  });
}

async function buildOrderConfirmation(orderId) {
  const order = await loadOrder(orderId);
  if (!order) return null;
  // `order.currency` is the region's currency snapshotted at placement time (multi-currency,
  // added alongside Region.currency) — null only for legacy pre-multi-currency orders.
  order.currency = order.currency || 'AED';
  return {
    subject: `Your Amoon Bloom order #${order.orderNumber} is placed`,
    html: templates.renderOrderConfirmation(order),
  };
}

async function buildOrderStatus(orderId, status) {
  const order = await loadOrder(orderId);
  if (!order) return null;
  const to = order.user?.email || order.guestEmail || null;
  if (!to) return null;
  order.currency = order.currency || 'AED';
  const subjectByStatus = {
    SHIPPED: `Your Amoon Bloom order #${order.orderNumber} has shipped`,
    DELIVERED: `Your Amoon Bloom order #${order.orderNumber} was delivered`,
  };
  return {
    to,
    subject: subjectByStatus[status] || `Your Amoon Bloom order #${order.orderNumber} update`,
    html: templates.renderOrderStatusUpdate(order, status),
  };
}

async function handle(data) {
  let { to, subject, html, template, orderId, status } = data;

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

  if (template === 'order-status') {
    if (!orderId || !status) {
      console.warn('[jobs] email.send order-status skipped — missing orderId/status');
      return;
    }
    const built = await buildOrderStatus(orderId, status);
    if (!built) {
      console.warn(`[jobs] email.send order-status skipped — order ${orderId} not found or has no email`);
      return;
    }
    to = built.to;
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
