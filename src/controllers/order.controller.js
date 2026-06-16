const orderService = require('../services/order.service');
const paymentService = require('../services/payment.service');
const { success, error } = require('../utils/response');

async function createOrder(req, res, next) {
  try {
    const userId = req.userId;
    const { order, error: errMsg } = await orderService.createOrder(userId, req.body, {
      regionCode: req.headers['x-region'],
    });
    if (errMsg) return error(res, errMsg, 400);
    return success(res, order, 'Order placed successfully', 201);
  } catch (err) {
    next(err);
  }
}

async function getOrderById(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const canViewAnyOrder = req.isAdmin === true || req.canViewAllOrders === true;
    const order = await orderService.getOrderById(id, canViewAnyOrder ? null : userId);
    if (!order) return error(res, 'Order not found', 404);
    return success(res, order, 'Order fetched successfully');
  } catch (err) {
    next(err);
  }
}

async function getAllOrdersAdmin(req, res, next) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const status = req.query.status || null;
    const result = await orderService.getAllOrdersAdmin(page, limit, status);
    return success(res, result.data, 'Orders fetched successfully', 200, {
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function updateOrderStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const order = await orderService.updateOrderStatus(id, status);
    if (!order) return error(res, 'Order not found or invalid status', 404);
    return success(res, order, 'Order status updated');
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'Order not found', 404);
    if (err.code === 'INSUFFICIENT_STOCK') {
      const errors = Array.isArray(err.details)
        ? err.details.map((d) => ({
            field: d.productId,
            message: `${d.title}: requested ${d.requested}, available ${d.available}`,
          }))
        : null;
      return error(res, err.message || 'Insufficient stock', 409, errors);
    }
    if (err.code === 'PRODUCT_MISSING') {
      return error(res, err.message || 'Product missing', 400, [
        { field: err.productId || 'productId', message: 'Product no longer exists for this order line' },
      ]);
    }
    next(err);
  }
}

async function getMyOrderHistory(req, res, next) {
  try {
    const userId = req.userId;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const status = req.query.status || null;
    const result = await orderService.getMyOrderHistory(userId, page, limit, status);
    return success(res, result.data, 'Order history fetched successfully', 200, {
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getAdminOrderHistory(req, res, next) {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const status = req.query.status || null;
    const userId = req.query.userId || null;
    const dateFrom = req.query.dateFrom || null;
    const dateTo = req.query.dateTo || null;
    const includeItems = req.query.includeItems === 'true' || req.query.includeItems === '1';

    if (dateFrom && Number.isNaN(Date.parse(dateFrom))) {
      return error(res, 'Invalid dateFrom; use ISO 8601 date or datetime', 400);
    }
    if (dateTo && Number.isNaN(Date.parse(dateTo))) {
      return error(res, 'Invalid dateTo; use ISO 8601 date or datetime', 400);
    }

    const result = await orderService.getAdminOrderHistory(page, limit, {
      status,
      userId,
      dateFrom,
      dateTo,
      includeItems,
    });

    return success(res, result.data, 'Order history fetched successfully', 200, {
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
      includeItems: result.meta.includeItems,
    });
  } catch (err) {
    next(err);
  }
}

async function getOrderStatusOnly(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const canViewAny = req.isAdmin === true || req.canViewAllOrders === true;
    const snapshot = await orderService.getOrderStatusOnly(id, canViewAny ? null : userId);
    if (!snapshot) return error(res, 'Order not found', 404);
    return success(res, snapshot, 'Order status fetched successfully');
  } catch (err) {
    next(err);
  }
}

// POST /orders/:id/pay — start an online (MyFatoorah) payment for the user's order.
// Returns the hosted payment URL for the app to open (Apple Pay / cards).
async function initiatePayment(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const result = await orderService.initiateOrderPayment(id, userId);
    if (result.error) {
      const status = result.error === 'Order not found' ? 404 : 400;
      return error(res, result.error, status);
    }
    return success(res, { paymentUrl: result.paymentUrl, invoiceId: result.invoiceId }, 'Payment created');
  } catch (err) {
    if (err.code === 'PAYMENT_NOT_CONFIGURED') return error(res, 'Online payment is not enabled', 503);
    if (err.code === 'PAYMENT_GATEWAY_ERROR') return error(res, err.message, 502);
    next(err);
  }
}

// POST /orders/:id/payment-session — native Apple Pay step 1.
// Returns a MyFatoorah sessionId for the mobile app to drive the native Apple Pay sheet.
async function createPaymentSession(req, res, next) {
  try {
    const result = await orderService.createPaymentSession(req.params.id, req.userId);
    if (result.error) {
      const status = result.error === 'Order not found' ? 404 : 400;
      return error(res, result.error, status);
    }
    return success(res, { sessionId: result.sessionId, countryCode: result.countryCode }, 'Payment session created');
  } catch (err) {
    if (err.code === 'PAYMENT_NOT_CONFIGURED') return error(res, 'Online payment is not enabled', 503);
    if (err.code === 'PAYMENT_GATEWAY_ERROR') return error(res, err.message, 502);
    next(err);
  }
}

// POST /orders/:id/pay-session — native Apple Pay step 2.
// Body: { sessionId }. Executes the charge server-side and places the order on success.
async function executeApplePay(req, res, next) {
  try {
    const { sessionId } = req.body || {};
    const result = await orderService.executeOrderPayment(req.params.id, req.userId, sessionId);
    if (result.error) {
      const status = result.error === 'Order not found' ? 404 : 400;
      return error(res, result.error, status);
    }
    // result.isPaid true → order placed (CONFIRMED/PAID). false → not paid (e.g. declined);
    // app should show failure / retry. paymentUrl is present only for non-direct methods.
    return success(
      res,
      { isPaid: result.isPaid, orderId: result.orderId, status: result.status, paymentUrl: result.paymentUrl || null },
      result.isPaid ? 'Payment successful' : 'Payment not completed'
    );
  } catch (err) {
    if (err.code === 'PAYMENT_NOT_CONFIGURED') return error(res, 'Online payment is not enabled', 503);
    if (err.code === 'PAYMENT_GATEWAY_ERROR') return error(res, err.message, 502);
    next(err);
  }
}

// Small self-contained HTML the browser/webview lands on after payment. The mobile
// app typically intercepts the callback URL itself; this is the human-visible fallback.
function paymentResultPage(ok, orderId) {
  const title = ok ? 'Payment successful' : 'Payment not completed';
  const color = ok ? '#16a34a' : '#dc2626';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="font-family:system-ui;text-align:center;padding:48px 20px;color:#111">
<div style="font-size:48px">${ok ? '✅' : '❌'}</div>
<h2 style="color:${color}">${title}</h2>
${orderId ? `<p style="color:#666">Order: ${orderId}</p>` : ''}
<p style="color:#666">You can return to the app.</p>
</body></html>`;
}

// Shared handler for both the success (callback) and error return URLs. We never
// trust which URL was hit — we re-verify the payment with MyFatoorah and decide
// from the real status. This is the authoritative confirmation step.
async function handlePaymentReturn(req, res) {
  const paymentId = req.query.paymentId || req.query.PaymentId || req.query.Id;
  if (!paymentId) {
    return res.status(400).type('html').send(paymentResultPage(false, null));
  }
  try {
    const result = await orderService.confirmOrderPayment(paymentId);
    return res.status(200).type('html').send(paymentResultPage(result.isPaid, result.orderId));
  } catch (err) {
    console.error('[payment] return handler error:', err.message);
    return res.status(200).type('html').send(paymentResultPage(false, null));
  }
}

// GET /orders/payment/callback — MyFatoorah's success/return URL (?paymentId=...).
const paymentCallback = handlePaymentReturn;

// GET /orders/payment/error — MyFatoorah's error/cancel URL. Still verifies, in case
// a completed payment was routed here, and marks the order FAILED otherwise.
const paymentError = handlePaymentReturn;

// POST /orders/payment/webhook — server-to-server notification from MyFatoorah. This is
// the reliable confirmation path when the customer's browser never returns (closed app,
// lost connection). We re-verify every event via GetPaymentStatus, so a forged webhook
// cannot mark an order paid; the optional signature check is defense-in-depth.
// Always responds 200 quickly so MyFatoorah doesn't spam retries for events we handled.
async function paymentWebhook(req, res) {
  try {
    const body = req.body || {};
    const signature = req.get('myfatoorah-signature') || req.get('MyFatoorah-Signature');
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(body);
    if (!paymentService.verifyWebhookSignature(rawBody, signature)) {
      console.warn('[payment] webhook signature check failed');
      return res.status(401).json({ received: false });
    }

    const data = body.Data || body.data || body;
    const invoiceId = data.InvoiceId || data.invoiceId;
    const paymentId = data.PaymentId || data.paymentId;

    if (paymentId) {
      await orderService.confirmOrderPayment(String(paymentId), 'PaymentId');
    } else if (invoiceId) {
      await orderService.confirmOrderPayment(String(invoiceId), 'InvoiceId');
    } else {
      console.warn('[payment] webhook had no InvoiceId/PaymentId');
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    // Never 500 to the gateway for a transient issue we can't fix synchronously; log it.
    console.error('[payment] webhook error:', err.message);
    return res.status(200).json({ received: true });
  }
}

module.exports = {
  createOrder,
  getOrderById,
  getAllOrdersAdmin,
  getMyOrderHistory,
  getAdminOrderHistory,
  getOrderStatusOnly,
  updateOrderStatus,
  initiatePayment,
  createPaymentSession,
  executeApplePay,
  paymentCallback,
  paymentError,
  paymentWebhook,
};
