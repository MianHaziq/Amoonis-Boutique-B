/**
 * Backend test for the native Apple Pay session flow.
 *   A) createPaymentSession → LIVE MyFatoorah InitiateSession (proves the real API works).
 *   B) executeOrderPayment → order placed + stock deducted (execute+verify mocked, since a
 *      real Apple Pay token only comes from a device).
 *   C) guard checks.
 *
 *   node scripts/payment-applepay-test.js
 */
require('dotenv').config();

const prisma = require('../src/config/db');
const orderService = require('../src/services/order.service');
const paymentService = require('../src/services/payment.service');

const CCY = process.env.MYFATOORAH_CURRENCY || 'KWD';
const TAG = `ap_${Date.now()}`;
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++; };

async function seed({ status = 'PENDING_PAYMENT', method = 'MYFATOORAH', paid = 'UNPAID', qty = 2, total = 1 } = {}) {
  const u = await prisma.user.create({ data: { email: `${TAG}_${Math.random().toString(36).slice(2)}@e.com`, fullName: 'AP Tester', status: 'ACTIVE' } });
  const p = await prisma.product.create({ data: { title: `${TAG} prod`, price: 0.5, quantity: 10 } });
  const o = await prisma.order.create({ data: { userId: u.id, status, paymentStatus: paid, paymentMethod: method, totalAmount: total, shippingFullName: 'AP Tester' } });
  await prisma.orderItem.create({ data: { orderId: o.id, productId: p.id, quantity: qty, price: 0.5 } });
  return { u, p, o };
}

(async () => {
  const created = [];
  const origExec = paymentService.executePayment;
  const origVerify = paymentService.verifyPayment;
  try {
    console.log('\n=== Native Apple Pay backend flow test ===\n');

    // A) LIVE InitiateSession
    {
      const { u, p, o } = await seed(); created.push({ u, p, o });
      const r = await orderService.createPaymentSession(o.id, u.id);
      check('A: createPaymentSession returns a live sessionId', !r.error && typeof r.sessionId === 'string' && r.sessionId.length > 0, r.error || `sessionId=${r.sessionId}`);
    }

    // B) execute → order placed (execute + verify mocked)
    {
      const { u, p, o } = await seed(); created.push({ u, p, o });
      paymentService.executePayment = async () => ({ invoiceId: 'MOCK_INV_1', paymentUrl: null, isDirectPayment: true });
      paymentService.verifyPayment = async () => ({ isPaid: true, status: 'Paid', invoiceId: 'MOCK_INV_1', invoiceValue: 1, currency: CCY, orderId: o.id, transactionId: 'tx1' });
      const res = await orderService.executeOrderPayment(o.id, u.id, 'SESSION_WITH_TOKEN');
      await new Promise((r) => setTimeout(r, 300));
      const ord = await prisma.order.findUnique({ where: { id: o.id }, select: { status: true, paymentStatus: true, paymentInvoiceId: true } });
      const prod = await prisma.product.findUnique({ where: { id: p.id }, select: { quantity: true } });
      check('B: execute returns isPaid=true', res.isPaid === true);
      check('B: order placed (CONFIRMED/PAID) + invoiceId stored', ord.status === 'PROCESSING' && ord.paymentStatus === 'PAID' && ord.paymentInvoiceId === 'MOCK_INV_1');
      check('B: stock deducted once (10→8)', prod.quantity === 8, `quantity=${prod.quantity}`);
      paymentService.executePayment = origExec;
      paymentService.verifyPayment = origVerify;
    }

    // B2) declined Apple Pay → order NOT placed
    {
      const { u, p, o } = await seed(); created.push({ u, p, o });
      paymentService.executePayment = async () => ({ invoiceId: 'MOCK_INV_2', paymentUrl: null, isDirectPayment: true });
      paymentService.verifyPayment = async () => ({ isPaid: false, status: 'Failed', invoiceId: 'MOCK_INV_2', invoiceValue: 1, currency: CCY, orderId: o.id, transactionId: null });
      const res = await orderService.executeOrderPayment(o.id, u.id, 'SESSION_X');
      const ord = await prisma.order.findUnique({ where: { id: o.id }, select: { status: true, paymentStatus: true } });
      const prod = await prisma.product.findUnique({ where: { id: p.id }, select: { quantity: true } });
      check('B2: declined → not paid, order stays AWAITING_PAYMENT, no stock deducted', res.isPaid === false && ord.status === 'PENDING_PAYMENT' && prod.quantity === 10);
      paymentService.executePayment = origExec;
      paymentService.verifyPayment = origVerify;
    }

    // C) guards
    {
      const { u, p, o } = await seed({ method: 'COD', status: 'PENDING_PAYMENT' }); created.push({ u, p, o });
      const r1 = await orderService.createPaymentSession(o.id, u.id);
      check('C: session rejected for COD order', r1.error === 'This order is not set up for online payment');
      const r2 = await orderService.executeOrderPayment(o.id, u.id, '');
      check('C: execute rejects empty sessionId', r2.error === 'sessionId is required');
      const r3 = await orderService.createPaymentSession('00000000-0000-0000-0000-000000000000', u.id);
      check('C: session rejected for non-existent order', r3.error === 'Order not found');
    }
  } catch (err) {
    console.error('\n💥 threw:', err);
    fail++;
  } finally {
    paymentService.executePayment = origExec;
    paymentService.verifyPayment = origVerify;
    for (const { u, p, o } of created) {
      try {
        await prisma.orderItem.deleteMany({ where: { orderId: o.id } });
        await prisma.order.deleteMany({ where: { id: o.id } });
        await prisma.product.deleteMany({ where: { id: p.id } });
        await prisma.notification.deleteMany({ where: { userId: u.id } });
        await prisma.userNotificationPreferences.deleteMany({ where: { userId: u.id } });
        await prisma.cartItem.deleteMany({ where: { cart: { userId: u.id } } });
        await prisma.cart.deleteMany({ where: { userId: u.id } });
        await prisma.user.deleteMany({ where: { id: u.id } });
      } catch (e) { /* ignore */ }
    }
    await prisma.$disconnect();
    console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
