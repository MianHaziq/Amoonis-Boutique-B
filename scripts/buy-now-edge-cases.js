/**
 * Industry-grade edge-case suite for "Buy Now" (single-product express purchase).
 * Models the cases big e-commerce apps must get right: stock at order + at capture,
 * server-side pricing/promo, address handling, abandoned-payment expiry, paid-but-no-stock,
 * and the concurrency / oversell race.
 *
 *   node scripts/buy-now-edge-cases.js
 */
require('dotenv').config();

const prisma = require('../src/config/db');
const orderService = require('../src/services/order.service');
const paymentService = require('../src/services/payment.service');

const CCY = process.env.MYFATOORAH_CURRENCY || 'KWD';
const TAG = `bne_${Date.now()}`;
const ADDR = { streetAddress: '1 St', city: 'C', country: 'X' };
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ids = { users: [], products: [], orders: [], promos: [], addresses: [] };
  const origVerify = paymentService.verifyPayment;
  const mkUser = async () => { const u = await prisma.user.create({ data: { email: `${TAG}_${Math.random().toString(36).slice(2)}@e.com`, fullName: 'E', phone: '1', status: 'ACTIVE' } }); ids.users.push(u.id); return u; };
  const mkProduct = async (qty, price = 1) => { const p = await prisma.product.create({ data: { title: `${TAG}p`, price, quantity: qty, status: 'PUBLISHED' } }); ids.products.push(p.id); return p; };
  const track = (o) => { if (o) ids.orders.push(o.id); return o; };

  try {
    console.log('\n=== Buy Now — edge cases ===\n');

    // 1) Out of stock at order time
    {
      const u = await mkUser(); const p = await mkProduct(2);
      const { order, error } = await orderService.buyNow(u.id, { productId: p.id, quantity: 5, paymentMethod: 'COD', shippingAddress: ADDR });
      check('1: qty > stock rejected at order time', !order && /in stock/.test(error || ''), error);
    }

    // 2) Exactly available stock allowed; COD does NOT deduct until confirmed
    {
      const u = await mkUser(); const p = await mkProduct(3);
      const { order, error } = await orderService.buyNow(u.id, { productId: p.id, quantity: 3, paymentMethod: 'COD', shippingAddress: ADDR });
      track(order);
      const prod = await prisma.product.findUnique({ where: { id: p.id }, select: { quantity: true } });
      check('2: qty == stock allowed (PENDING), stock not yet deducted', !error && order.status === 'PENDING' && prod.quantity === 3);

      // 3) Admin confirm → stock deducted by full qty
      await orderService.updateOrderStatus(order.id, 'CONFIRMED');
      const prod2 = await prisma.product.findUnique({ where: { id: p.id }, select: { quantity: true } });
      check('3: admin confirm deducts full qty (3→0)', prod2.quantity === 0, `quantity=${prod2.quantity}`);
    }

    // 4) Promo (10% off) applied server-side
    {
      const u = await mkUser(); const p = await mkProduct(10, 10);
      // Promo codes are stored/looked up UPPERCASE (service normalizes), so use an uppercase code.
      const codeStr = `BN${Date.now()}`.toUpperCase();
      const promo = await prisma.promoCode.create({ data: { code: codeStr, name: 'x', discountType: 'PERCENTAGE', discountValue: 10, appliesTo: 'ALL_PRODUCTS', isActive: true } });
      ids.promos.push(promo.id);
      const { order, error } = await orderService.buyNow(u.id, { productId: p.id, quantity: 2, paymentMethod: 'COD', shippingAddress: ADDR, promoCode: promo.code });
      track(order);
      // subtotal 20, 10% off => 18
      check('4: promo applied to buy-now (20 → 18)', !error && Number(order.totalAmount) === 18, error || `total=${order && order.totalAmount}`);
    }

    // 5) Invalid addressId rejected
    {
      const u = await mkUser(); const p = await mkProduct(5);
      const { order, error } = await orderService.buyNow(u.id, { productId: p.id, quantity: 1, paymentMethod: 'COD', addressId: '00000000-0000-0000-0000-000000000000' });
      check('5: invalid addressId rejected', !order && error === 'Address not found');
    }

    // 6) Valid saved address used
    {
      const u = await mkUser(); const p = await mkProduct(5);
      const addr = await prisma.address.create({ data: { userId: u.id, fullName: 'A B', phone: '9', streetAddress: '77 Saved Rd', city: 'SC', country: 'SX' } });
      ids.addresses.push(addr.id);
      const { order, error } = await orderService.buyNow(u.id, { productId: p.id, quantity: 1, paymentMethod: 'COD', addressId: addr.id });
      track(order);
      const row = await prisma.order.findUnique({ where: { id: order.id }, select: { shippingStreetAddress: true, addressId: true } });
      check('6: saved address used on the order', !error && row.shippingStreetAddress === '77 Saved Rd' && row.addressId === addr.id);
    }

    // 7) No address rejected
    {
      const u = await mkUser(); const p = await mkProduct(5);
      const { order, error } = await orderService.buyNow(u.id, { productId: p.id, quantity: 1, paymentMethod: 'COD' });
      check('7: missing address rejected', !order && /shipping address is required/.test(error || ''));
    }

    // 8) Online buy-now abandoned → expired by the job; cart intact, stock untouched
    {
      const u = await mkUser(); const p = await mkProduct(5);
      const cart = await prisma.cart.create({ data: { userId: u.id } });
      const other = await mkProduct(5);
      await prisma.cartItem.create({ data: { cartId: cart.id, productId: other.id, quantity: 1 } });
      const { order } = await orderService.buyNow(u.id, { productId: p.id, quantity: 1, paymentMethod: 'MYFATOORAH', shippingAddress: ADDR });
      track(order);
      // backdate so the expiry job picks it up
      await prisma.$executeRawUnsafe(`UPDATE "Order" SET "createdAt" = NOW() - INTERVAL '100 days' WHERE id = '${order.id}'`);
      await require('../src/jobs/handlers/orderExpire.job').handler();
      const ord = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true } });
      const cartN = await prisma.cartItem.count({ where: { cart: { userId: u.id } } });
      const prod = await prisma.product.findUnique({ where: { id: p.id }, select: { quantity: true } });
      check('8: abandoned online buy-now expired → CANCELLED', ord.status === 'CANCELLED');
      check('8: cart intact + stock untouched after expiry', cartN === 1 && prod.quantity === 5);
    }

    // 9) Paid but stock became 0 before capture → PAID, not CONFIRMED, no crash, no negative stock
    {
      const u = await mkUser(); const p = await mkProduct(5);
      const { order } = await orderService.buyNow(u.id, { productId: p.id, quantity: 1, paymentMethod: 'MYFATOORAH', shippingAddress: ADDR });
      track(order);
      await prisma.product.update({ where: { id: p.id }, data: { quantity: 0 } }); // stock gone
      paymentService.verifyPayment = async () => ({ isPaid: true, status: 'Paid', invoiceId: 'I9', invoiceValue: Number(order.totalAmount), currency: CCY, orderId: order.id, transactionId: 't' });
      const res = await orderService.confirmOrderPayment('I9', 'InvoiceId');
      paymentService.verifyPayment = origVerify;
      const ord = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true, paymentStatus: true } });
      const prod = await prisma.product.findUnique({ where: { id: p.id }, select: { quantity: true } });
      check('9: paid-but-no-stock → PAID and NOT auto-confirmed (no crash)', res.isPaid === true && ord.paymentStatus === 'PAID' && ord.status !== 'CONFIRMED');
      check('9: stock not driven negative', prod.quantity === 0, `quantity=${prod.quantity}`);
    }

    // 10) Concurrency / oversell: 2 buy-now orders, stock 1 → exactly one confirms, never negative
    {
      const u = await mkUser(); const p = await mkProduct(1);
      const a = track((await orderService.buyNow(u.id, { productId: p.id, quantity: 1, paymentMethod: 'MYFATOORAH', shippingAddress: ADDR })).order);
      const b = track((await orderService.buyNow(u.id, { productId: p.id, quantity: 1, paymentMethod: 'MYFATOORAH', shippingAddress: ADDR })).order);
      const map = { IA: a.id, IB: b.id };
      paymentService.verifyPayment = async (key) => ({ isPaid: true, status: 'Paid', invoiceId: key, invoiceValue: 1, currency: CCY, orderId: map[key], transactionId: 't' });
      await Promise.all([orderService.confirmOrderPayment('IA', 'InvoiceId'), orderService.confirmOrderPayment('IB', 'InvoiceId')]);
      paymentService.verifyPayment = origVerify;
      await sleep(200);
      const oa = await prisma.order.findUnique({ where: { id: a.id }, select: { status: true } });
      const ob = await prisma.order.findUnique({ where: { id: b.id }, select: { status: true } });
      const prod = await prisma.product.findUnique({ where: { id: p.id }, select: { quantity: true } });
      const confirmedCount = [oa.status, ob.status].filter((s) => s === 'CONFIRMED').length;
      check('10: exactly ONE of two competing orders confirmed', confirmedCount === 1, `statuses=${oa.status}/${ob.status}`);
      check('10: stock never negative (ends at 0)', prod.quantity === 0, `quantity=${prod.quantity}`);
    }

    // 11) Non-integer / huge quantity
    {
      const u = await mkUser(); const p = await mkProduct(10);
      const frac = await orderService.buyNow(u.id, { productId: p.id, quantity: 1.5, paymentMethod: 'COD', shippingAddress: ADDR });
      const huge = await orderService.buyNow(u.id, { productId: p.id, quantity: 999999, paymentMethod: 'COD', shippingAddress: ADDR });
      check('11: non-integer quantity rejected', !frac.order);
      check('11: huge quantity beyond stock rejected', !huge.order);
    }
  } catch (err) {
    console.error('\n💥 threw:', err);
    fail++;
  } finally {
    paymentService.verifyPayment = origVerify;
    try {
      await prisma.promoCodeUsage.deleteMany({ where: { promoCodeId: { in: ids.promos } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids.orders } } });
      await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
      await prisma.promoCode.deleteMany({ where: { id: { in: ids.promos } } });
      for (const uid of ids.users) {
        await prisma.notification.deleteMany({ where: { userId: uid } });
        await prisma.userNotificationPreferences.deleteMany({ where: { userId: uid } });
        await prisma.cartItem.deleteMany({ where: { cart: { userId: uid } } });
        await prisma.cart.deleteMany({ where: { userId: uid } });
        await prisma.address.deleteMany({ where: { userId: uid } });
        await prisma.user.deleteMany({ where: { id: uid } });
      }
      await prisma.product.deleteMany({ where: { id: { in: ids.products } } });
    } catch (e) { console.error('cleanup error:', e.message); }
    await prisma.$disconnect();
    console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
