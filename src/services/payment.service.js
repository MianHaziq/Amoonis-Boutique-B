/**
 * MyFatoorah payment integration (Apple Pay + cards via the hosted payment page).
 *
 * Flow:
 *   1. createPaymentInvoice(order, customer) → calls MyFatoorah SendPayment, returns
 *      the hosted page URL (where Apple Pay / card entry happens) + the InvoiceId.
 *   2. verifyPayment(paymentId) → calls MyFatoorah GetPaymentStatus to confirm the
 *      payment server-side. We NEVER trust the browser redirect alone — this is the
 *      authoritative check before marking an order paid.
 *
 * Config comes from env (see .env): MYFATOORAH_API_KEY, MYFATOORAH_BASE_URL,
 * MYFATOORAH_CALLBACK_URL, MYFATOORAH_ERROR_URL.
 */

const API_KEY = process.env.MYFATOORAH_API_KEY || '';
const BASE_URL = (process.env.MYFATOORAH_BASE_URL || 'https://apitest.myfatoorah.com').replace(/\/+$/, '');
const CALLBACK_URL = process.env.MYFATOORAH_CALLBACK_URL || '';
const ERROR_URL = process.env.MYFATOORAH_ERROR_URL || '';
const CURRENCY = process.env.MYFATOORAH_CURRENCY || 'AED';
const TIMEOUT_MS = Math.max(3000, parseInt(process.env.MYFATOORAH_TIMEOUT_MS || '15000', 10));

function isConfigured() {
  return Boolean(API_KEY);
}

function gatewayError(message, { retryable = false } = {}) {
  const err = new Error(message);
  err.code = 'PAYMENT_GATEWAY_ERROR';
  err.retryable = retryable;
  return err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One HTTP round-trip to MyFatoorah's JSON API. Throws a tagged Error on network
 * failure, HTTP 5xx, non-JSON, or IsSuccess=false. Network/5xx errors are marked
 * `retryable` so idempotent reads (GetPaymentStatus) can be retried safely.
 */
async function callOnce(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    // Network failure / timeout — transient, safe to retry on idempotent calls.
    throw gatewayError(`MyFatoorah request failed: ${e.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 500) {
    throw gatewayError(`MyFatoorah returned HTTP ${res.status}`, { retryable: true });
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw gatewayError('MyFatoorah returned a non-JSON response', { retryable: res.status >= 500 });
  }

  // MyFatoorah wraps results as { IsSuccess, Message, ValidationErrors, Data }.
  if (!json || json.IsSuccess !== true) {
    const detail =
      json?.Message ||
      (Array.isArray(json?.ValidationErrors)
        ? json.ValidationErrors.map((v) => v.Error).join('; ')
        : 'Unknown error');
    throw gatewayError(`MyFatoorah error: ${detail}`);
  }

  return json.Data;
}

/**
 * callOnce + optional retry with backoff for transient (retryable) failures.
 * `retries` should be > 0 ONLY for idempotent calls (GetPaymentStatus) — never for
 * SendPayment, where a retried network failure could create a duplicate invoice.
 */
async function callMyFatoorah(path, body, { retries = 0 } = {}) {
  if (!isConfigured()) {
    const err = new Error('MyFatoorah is not configured (MYFATOORAH_API_KEY missing)');
    err.code = 'PAYMENT_NOT_CONFIGURED';
    throw err;
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await callOnce(path, body);
    } catch (e) {
      lastErr = e;
      if (!e.retryable || attempt === retries) throw e;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * Create a payment for an order. Returns { invoiceId, paymentUrl }.
 * paymentUrl is the hosted page — open it in the app; Apple Pay shows on iOS,
 * card entry everywhere. order.id is passed as CustomerReference so the callback
 * (and GetPaymentStatus) can be tied back to the right order.
 */
async function createPaymentInvoice(order, customer = {}) {
  // MyFatoorah validates CustomerMobile against the account's country, so a number
  // from another country (e.g. a UAE number on the Kuwait sandbox) triggers
  // "Invalid data". The mobile is only metadata here (NotificationOption=LNK means
  // no SMS), so we send it best-effort and retry without it if the gateway rejects.
  const rawMobile = customer.phone || order.shippingPhone || '';
  const mobileDigits = String(rawMobile).replace(/\D/g, '');

  const baseBody = {
    CustomerName: customer.name || order.shippingFullName || 'Customer',
    CustomerEmail: customer.email || undefined,
    InvoiceValue: Number(order.totalAmount),
    DisplayCurrencyIso: CURRENCY,
    CallBackUrl: CALLBACK_URL,
    ErrorUrl: ERROR_URL || CALLBACK_URL,
    CustomerReference: order.id,
    NotificationOption: 'LNK', // return a link instead of sending SMS/email
    Language: 'en',
  };

  let data;
  try {
    data = await callMyFatoorah('/v2/SendPayment', {
      ...baseBody,
      ...(mobileDigits ? { CustomerMobile: mobileDigits } : {}),
    });
  } catch (e) {
    // Retry once without the mobile — a bad/foreign number must not block payment.
    if (mobileDigits && e.code === 'PAYMENT_GATEWAY_ERROR') {
      console.warn(`[payment] SendPayment rejected with mobile for order ${order.id}; retrying without it`);
      data = await callMyFatoorah('/v2/SendPayment', baseBody);
    } else {
      throw e;
    }
  }

  return {
    invoiceId: data.InvoiceId != null ? String(data.InvoiceId) : null,
    paymentUrl: data.InvoiceURL,
  };
}

/**
 * Confirm a payment with MyFatoorah (the authoritative server-side check). `key` is
 * the PaymentId from the callback URL, or the InvoiceId from a webhook — `keyType`
 * selects which. Idempotent read, so we retry transient failures. Returns a
 * normalized result the order layer can trust.
 */
async function verifyPayment(key, keyType = 'PaymentId') {
  const data = await callMyFatoorah(
    '/v2/GetPaymentStatus',
    { Key: String(key), KeyType: keyType },
    { retries: 2 }
  );

  const status = data.InvoiceStatus; // 'Paid' | 'Failed' | 'Pending' | 'Expired' | ...
  const txns = Array.isArray(data.InvoiceTransactions) ? data.InvoiceTransactions : [];
  // Prefer the successful transaction's id when present.
  const paidTxn = txns.find((t) => t.TransactionStatus === 'Succss' || t.TransactionStatus === 'Success') || txns[0] || null;

  return {
    isPaid: status === 'Paid',
    status,
    invoiceId: data.InvoiceId != null ? String(data.InvoiceId) : null,
    invoiceValue: data.InvoiceValue != null ? Number(data.InvoiceValue) : null,
    orderId: data.CustomerReference || null, // we set this to order.id at creation
    transactionId: paidTxn?.TransactionId != null ? String(paidTxn.TransactionId) : null,
  };
}

/**
 * Optional webhook signature check. MyFatoorah signs the webhook body with an
 * account secret (HMAC-SHA256, base64) sent in the `myfatoorah-signature` header.
 * If MYFATOORAH_WEBHOOK_SECRET is unset we skip this — the webhook handler still
 * re-verifies every event via GetPaymentStatus, so a forged event can't mark an
 * order paid; the signature is defense-in-depth.
 */
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.MYFATOORAH_WEBHOOK_SECRET || '';
  if (!secret) return true; // not configured → rely on GetPaymentStatus re-verification
  if (!signature) return false;
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

module.exports = {
  isConfigured,
  createPaymentInvoice,
  verifyPayment,
  verifyWebhookSignature,
};
