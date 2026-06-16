/**
 * Verifies the two payment/order fixes:
 *   1. Concurrent confirms deduct stock exactly once (FOR UPDATE lock in updateOrderStatus).
 *   2. Underpayment (same currency) is withheld; full payment confirms; cross-currency
 *      lower numeric value still confirms (no false stranding).
 *
 *   node scripts/payment-bugfix-test.js
 */
require('dotenv').config();

const prisma = require('../src/config/db');
const orderService = require('../src/services/order.service');
const paymentService = require('../src/services/payment.service');

const CCY = process.env.MYFATOORAH_CURRENCY || 'AED';
const TAG = `pbf_${Date.now()}`;
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mkUser() {
  return prisma.user.create({ data: { email: `${TAG}_${Math.random().toString(36).slice(2)}@e.com`, status: 'ACTIVE' } });
}
async function mkProduct(qty) {
  return prisma.product.create({ data: { title: `${TAG} prod`, price: 5, quantity: qty } });
}
async function mkOrder(userId, productId, { status, qty, total, paymentMethod }) {
  const order = await prisma.order.create({
    data: { userId, status, paymentStatus: 'UNPAID', totalAmount: total, inventoryDeducted: false, paymentMethod },
  });
  await prisma.orderItem.create({ data: { orderId: order.id, productId, quantity: qty, price: 5 } });
  return order;
}

(async () => {
  const ids = { users: [], products: [], orders: [] };
  const origVerify = paymentService.verifyPayment;
  try {
    console.log('\n=== Payment/order bug-fix verification ===\n');

    // ---------- FIX 1: concurrent confirm deducts once ----------
    {
      const u = await mkUser(); ids.users.push(u.id);
      const p = await mkProduct(10); ids.products.push(p.id);
      const o = await mkOrder(u.id, p.id, { status: 'PENDING', qty: 3, total: 15, paymentMethod: 'COD' }); ids.orders.push(o.id);

      // Fire 6 concurrent CONFIRM calls — only one may deduct.
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => orderService.updateOrderStatus(o.id, 'CONFIRMED'))
      );
      const errored = results.filter((r) => r.status === 'rejected');
      const prod = await prisma.product.findUnique({ where: { id: p.id }, select: { quantity: true } });
      const ord = await prisma.order.findUnique({ where: { id: o.id }, select: { status: true, inventoryDeducted: true } });
      check('FIX1: 6 concurrent confirms deduct stock exactly once (10→7)', prod.quantity === 7, `quantity=${prod.quantity}`);
      check('FIX1: order ends CONFIRMED + inventoryDeducted', ord.status === 'CONFIRMED' && ord.inventoryDeducted === true);
      check('FIX1: no confirm threw an unexpected error', errored.length === 0, errored.map((e) => e.reason && e.reason.message).join('; '));
    }

    // ---------- FIX 2a: underpayment (same currency) is withheld ----------
    {
      const u = await mkUser(); ids.users.push(u.id);
      const p = await mkProduct(10); ids.products.push(p.id);
      const o = await mkOrder(u.id, p.id, { status: 'AWAITING_PAYMENT', qty: 2, total: 100, paymentMethod: 'MYFATOORAH' }); ids.orders.push(o.id);

      paymentService.verifyPayment = async () => ({
        isPaid: true, status: 'Paid', invoiceId: 'inv', invoiceValue: 1, currency: CCY, orderId: o.id, transactionId: 't',
      });
      const res = await orderService.confirmOrderPayment('inv', 'InvoiceId');
      const ord = await prisma.order.findUnique({ where: { id: o.id }, select: { status: true, paymentStatus: true, inventoryDeducted: true } });
      const prod = await prisma.product.findUnique({ where: { id: p.id }, select: { quantity: true } });
      check('FIX2a: underpayment NOT marked paid/confirmed', res.isPaid === false && res.reason === 'amount_mismatch_underpaid');
      check('FIX2a: order left AWAITING_PAYMENT + paymentStatus FAILED', ord.status === 'AWAITING_PAYMENT' && ord.paymentStatus === 'FAILED');
      check('FIX2a: stock NOT deducted on underpayment', prod.quantity === 10 && ord.inventoryDeducted === false);
    }

    // ---------- FIX 2b: full payment (same currency) confirms ----------
    {
      const u = await mkUser(); ids.users.push(u.id);
      const p = await mkProduct(10); ids.products.push(p.id);
      const o = await mkOrder(u.id, p.id, { status: 'AWAITING_PAYMENT', qty: 4, total: 100, paymentMethod: 'MYFATOORAH' }); ids.orders.push(o.id);

      paymentService.verifyPayment = async () => ({
        isPaid: true, status: 'Paid', invoiceId: 'inv2', invoiceValue: 100, currency: CCY, orderId: o.id, transactionId: 't2',
      });
      const res = await orderService.confirmOrderPayment('inv2', 'InvoiceId');
      await sleep(400); // let fire-and-forget notify/email settle
      const ord = await prisma.order.findUnique({ where: { id: o.id }, select: { status: true, paymentStatus: true, inventoryDeducted: true } });
      const prod = await prisma.product.findUnique({ where: { id: p.id }, select: { quantity: true } });
      check('FIX2b: correct full payment confirms (PAID + CONFIRMED)', res.isPaid === true && ord.paymentStatus === 'PAID' && ord.status === 'CONFIRMED');
      check('FIX2b: stock deducted once (10→6)', prod.quantity === 6, `quantity=${prod.quantity}`);
    }

    // ---------- FIX 2c: cross-currency lower numeric value still confirms (no stranding) ----------
    {
      const u = await mkUser(); ids.users.push(u.id);
      const p = await mkProduct(10); ids.products.push(p.id);
      const o = await mkOrder(u.id, p.id, { status: 'AWAITING_PAYMENT', qty: 1, total: 100, paymentMethod: 'MYFATOORAH' }); ids.orders.push(o.id);

      paymentService.verifyPayment = async () => ({
        isPaid: true, status: 'Paid', invoiceId: 'inv3', invoiceValue: 30, currency: 'KWD', orderId: o.id, transactionId: 't3',
      });
      const res = await orderService.confirmOrderPayment('inv3', 'InvoiceId');
      await sleep(400);
      const ord = await prisma.order.findUnique({ where: { id: o.id }, select: { status: true, paymentStatus: true } });
      check('FIX2c: cross-currency payment NOT stranded (confirms)', res.isPaid === true && ord.paymentStatus === 'PAID' && ord.status === 'CONFIRMED');
    }
  } catch (err) {
    console.error('\n💥 threw:', err);
    fail++;
  } finally {
    paymentService.verifyPayment = origVerify;
    try {
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids.orders } } });
      await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
      await prisma.product.deleteMany({ where: { id: { in: ids.products } } });
      for (const uid of ids.users) {
        await prisma.notification.deleteMany({ where: { userId: uid } });
        await prisma.userNotificationPreferences.deleteMany({ where: { userId: uid } });
        await prisma.cartItem.deleteMany({ where: { cart: { userId: uid } } });
        await prisma.cart.deleteMany({ where: { userId: uid } });
        await prisma.user.deleteMany({ where: { id: uid } });
      }
    } catch (e) { console.error('cleanup error:', e.message); }
    await prisma.$disconnect();
    console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
