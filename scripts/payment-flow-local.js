/**
 * LOCAL end-to-end payment test against the real MyFatoorah TEST API.
 *
 * No ngrok, no webhook, no real money needed: it creates a throwaway order, asks
 * MyFatoorah for a real (sandbox) payment page, prints the URL for you to pay on,
 * then polls MyFatoorah's GetPaymentStatus (outbound) until the payment confirms —
 * exactly what the reconcile job does. Finally it checks the order became
 * CONFIRMED/PAID and that stock was deducted, then cleans up after itself.
 *
 * Prereqs: MYFATOORAH_API_KEY + MYFATOORAH_BASE_URL (test) + MYFATOORAH_CURRENCY set
 * in .env (you already have these). You do NOT need the server running.
 *
 *   node scripts/payment-flow-local.js
 *
 * Then: open the printed URL, pay with the MyFatoorah test card, and watch the
 * terminal confirm it automatically.
 */
require('dotenv').config();

const prisma = require('../src/config/db');
const orderService = require('../src/services/order.service');
const paymentService = require('../src/services/payment.service');

const CCY = process.env.MYFATOORAH_CURRENCY || 'KWD';
const TAG = `payflow_${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = { user: null, product: null, order: null };

async function cleanup() {
  try {
    if (ids.order) {
      await prisma.orderItem.deleteMany({ where: { orderId: ids.order } });
      await prisma.order.deleteMany({ where: { id: ids.order } });
    }
    if (ids.product) await prisma.product.deleteMany({ where: { id: ids.product } });
    if (ids.user) {
      await prisma.notification.deleteMany({ where: { userId: ids.user } });
      await prisma.userNotificationPreferences.deleteMany({ where: { userId: ids.user } });
      await prisma.cartItem.deleteMany({ where: { cart: { userId: ids.user } } });
      await prisma.cart.deleteMany({ where: { userId: ids.user } });
      await prisma.user.deleteMany({ where: { id: ids.user } });
    }
  } catch (e) {
    console.error('cleanup error:', e.message);
  }
}

// Clean up even if you Ctrl+C while waiting.
process.on('SIGINT', async () => { console.log('\n[ctrl+c] cleaning up…'); await cleanup(); await prisma.$disconnect(); process.exit(1); });

(async () => {
  try {
    console.log('\n=== LOCAL MyFatoorah payment flow test ===\n');
    if (!paymentService.isConfigured()) {
      console.error('❌ MYFATOORAH_API_KEY is not set in .env — cannot test online payment.');
      process.exit(1);
    }
    console.log(`Gateway: ${process.env.MYFATOORAH_BASE_URL}  |  Currency: ${CCY}\n`);

    // 1) Seed a throwaway user, product, order (AWAITING_PAYMENT / MYFATOORAH).
    const user = await prisma.user.create({
      data: { email: `${TAG}@example.com`, fullName: 'Test Customer', phone: '', status: 'ACTIVE' },
    });
    ids.user = user.id;
    const product = await prisma.product.create({ data: { title: `${TAG} product`, price: 0.5, quantity: 10 } });
    ids.product = product.id;
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        status: 'PENDING_PAYMENT',
        paymentStatus: 'UNPAID',
        paymentMethod: 'MYFATOORAH',
        totalAmount: 1, // 1.000 in your test currency
        shippingFullName: 'Test Customer',
      },
    });
    ids.order = order.id;
    await prisma.orderItem.create({ data: { orderId: order.id, productId: product.id, quantity: 2, price: 0.5 } });
    console.log(`Seeded order ${order.id} (total 1 ${CCY}, 2 units of a 10-stock product).\n`);

    // 2) Ask MyFatoorah for a real sandbox payment page (this is the real API call).
    console.log('→ Calling MyFatoorah SendPayment (initiateOrderPayment)…');
    const pay = await orderService.initiateOrderPayment(order.id, user.id);
    if (pay.error) throw new Error(`initiateOrderPayment failed: ${pay.error}`);
    console.log(`✅ Invoice created. InvoiceId=${pay.invoiceId}\n`);

    console.log('┌──────────────────────────────────────────────────────────────────┐');
    console.log('│  OPEN THIS URL IN YOUR BROWSER AND PAY WITH THE TEST CARD:          │');
    console.log('└──────────────────────────────────────────────────────────────────┘');
    console.log(`\n   ${pay.paymentUrl}\n`);
    console.log('   Test card: 5453 0100 0009 5323 · CVV 100 · exp 05/26 · OTP 1234');
    console.log('   (or the test card shown in your MyFatoorah test dashboard)\n');
    console.log('Polling MyFatoorah for the result every 6s (up to ~3 min)…\n');

    // 3) Poll GetPaymentStatus (via confirmOrderPayment) until paid — same as the job.
    let paid = false;
    for (let i = 1; i <= 30; i++) {
      const res = await orderService.confirmOrderPayment(pay.invoiceId, 'InvoiceId');
      const ord = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true, paymentStatus: true } });
      console.log(`  [${i}] gateway="${res.status}"  order.status=${ord.status}  paymentStatus=${ord.paymentStatus}`);
      if (res.isPaid) { paid = true; break; }
      await sleep(6000);
    }

    console.log('');
    if (!paid) {
      console.log('⏱  Not paid within the time limit (did you complete the payment?). You can re-run anytime.');
    } else {
      const ord = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true, paymentStatus: true } });
      const prod = await prisma.product.findUnique({ where: { id: product.id }, select: { quantity: true } });
      const ok = ord.paymentStatus === 'PAID' && ord.status === 'PROCESSING' && prod.quantity === 8;
      console.log(`${ok ? '✅ SUCCESS' : '❌ MISMATCH'} — order ${ord.status}/${ord.paymentStatus}, stock 10→${prod.quantity} (expected 8)`);
    }
  } catch (err) {
    console.error('\n💥 Error:', err.message);
  } finally {
    console.log('\nCleaning up test data…');
    await cleanup();
    await prisma.$disconnect();
    console.log('Done.\n');
    process.exit(0);
  }
})();
