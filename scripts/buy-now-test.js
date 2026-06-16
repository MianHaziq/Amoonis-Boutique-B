/**
 * Buy Now (single-product direct purchase) tests. Critical guarantee: a Buy Now order
 * NEVER touches the user's cart — not on COD, not on online payment success.
 *
 *   node scripts/buy-now-test.js
 */
require('dotenv').config();

const prisma = require('../src/config/db');
const orderService = require('../src/services/order.service');
const paymentService = require('../src/services/payment.service');

const CCY = process.env.MYFATOORAH_CURRENCY || 'KWD';
const TAG = `bn_${Date.now()}`;
const ADDR = { streetAddress: '123 Test St', city: 'Test City', country: 'Testland' };
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++; };

async function cartCount(userId) {
  return prisma.cartItem.count({ where: { cart: { userId } } });
}

(async () => {
  const ids = { users: [], products: [], orders: [] };
  const origVerify = paymentService.verifyPayment;
  try {
    console.log('\n=== Buy Now tests ===\n');

    const user = await prisma.user.create({ data: { email: `${TAG}@e.com`, fullName: 'BN Tester', phone: '123', status: 'ACTIVE' } });
    ids.users.push(user.id);
    const prodCart = await prisma.product.create({ data: { title: `${TAG} cart-item`, price: 1, quantity: 10, status: 'PUBLISHED' } });
    const prodBuy = await prisma.product.create({ data: { title: `${TAG} buy-item`, price: 2, quantity: 10, status: 'PUBLISHED' } });
    const prodDraft = await prisma.product.create({ data: { title: `${TAG} draft`, price: 2, quantity: 10, status: 'DRAFT' } });
    ids.products.push(prodCart.id, prodBuy.id, prodDraft.id);

    // Put an item in the user's cart (this must survive every Buy Now).
    const cart = await prisma.cart.create({ data: { userId: user.id } });
    await prisma.cartItem.create({ data: { cartId: cart.id, productId: prodCart.id, quantity: 1 } });
    check('setup: cart has 1 item', (await cartCount(user.id)) === 1);

    // 1) Buy Now COD
    {
      const { order, error } = await orderService.buyNow(user.id, { productId: prodBuy.id, quantity: 2, paymentMethod: 'COD', shippingAddress: ADDR });
      if (order) ids.orders.push(order.id);
      check('1: COD buy-now placed as PENDING with the single product', !error && order.status === 'PENDING' && order.items.length === 1);
      check('1: cart left untouched after COD buy-now', (await cartCount(user.id)) === 1);
    }

    // 2) Buy Now online → AWAITING_PAYMENT, then payment success → placed, cart STILL intact
    {
      const { order, error } = await orderService.buyNow(user.id, { productId: prodBuy.id, quantity: 1, paymentMethod: 'MYFATOORAH', shippingAddress: ADDR });
      if (order) ids.orders.push(order.id);
      check('2: online buy-now is AWAITING_PAYMENT', !error && order.status === 'AWAITING_PAYMENT');
      const flag = await prisma.order.findUnique({ where: { id: order.id }, select: { clearCartOnPayment: true } });
      check('2: clearCartOnPayment=false on buy-now order', flag.clearCartOnPayment === false);

      // simulate a successful payment confirmation
      paymentService.verifyPayment = async () => ({ isPaid: true, status: 'Paid', invoiceId: 'BN_INV', invoiceValue: Number(order.totalAmount), currency: CCY, orderId: order.id, transactionId: 'tx' });
      const res = await orderService.confirmOrderPayment('BN_INV', 'InvoiceId');
      await new Promise((r) => setTimeout(r, 300));
      const ord = await prisma.order.findUnique({ where: { id: order.id }, select: { status: true, paymentStatus: true } });
      const prod = await prisma.product.findUnique({ where: { id: prodBuy.id }, select: { quantity: true } });
      check('2: payment placed the order (CONFIRMED/PAID)', res.isPaid === true && ord.status === 'CONFIRMED' && ord.paymentStatus === 'PAID');
      // Stock is now RESERVED at placement (H1): the COD buy-now above (qty 2) deducted 2 at
      // placement, and this online buy-now (qty 1) deducted 1 at placement (payment confirm
      // does NOT re-deduct). So 10 - 2 - 1 = 7. (Previously placement reserved nothing and
      // deduction only happened at confirm, which is the oversell window H1 closes.)
      check('2: stock reserved at placement for buy-now item (10-2-1=7)', prod.quantity === 7, `quantity=${prod.quantity}`);
      check('2: ⭐ cart STILL intact after online buy-now payment', (await cartCount(user.id)) === 1);
      paymentService.verifyPayment = origVerify;
    }

    // 3) Buy Now of a DRAFT product is rejected
    {
      const { order, error } = await orderService.buyNow(user.id, { productId: prodDraft.id, quantity: 1, paymentMethod: 'COD', shippingAddress: ADDR });
      check('3: draft/unpublished product rejected', !order && error === 'Product is not available for purchase');
    }

    // 4) Bad quantity rejected
    {
      const r0 = await orderService.buyNow(user.id, { productId: prodBuy.id, quantity: 0, paymentMethod: 'COD', shippingAddress: ADDR });
      const rNeg = await orderService.buyNow(user.id, { productId: prodBuy.id, quantity: -1, paymentMethod: 'COD', shippingAddress: ADDR });
      const rMissing = await orderService.buyNow(user.id, { paymentMethod: 'COD', shippingAddress: ADDR });
      check('4: quantity 0 / negative / missing productId rejected', !r0.order && !rNeg.order && !rMissing.order);
    }

    // 5) Regression: normal cart checkout STILL clears the cart
    {
      const { order, error } = await orderService.createOrder(user.id, { paymentMethod: 'COD', shippingAddress: ADDR });
      if (order) ids.orders.push(order.id);
      check('5: cart checkout still works (PENDING)', !error && order.status === 'PENDING');
      check('5: cart checkout cleared the cart', (await cartCount(user.id)) === 0);
    }
  } catch (err) {
    console.error('\n💥 threw:', err);
    fail++;
  } finally {
    paymentService.verifyPayment = origVerify;
    try {
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids.orders } } });
      await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
      for (const uid of ids.users) {
        await prisma.notification.deleteMany({ where: { userId: uid } });
        await prisma.userNotificationPreferences.deleteMany({ where: { userId: uid } });
        await prisma.cartItem.deleteMany({ where: { cart: { userId: uid } } });
        await prisma.cart.deleteMany({ where: { userId: uid } });
        await prisma.user.deleteMany({ where: { id: uid } });
      }
      await prisma.product.deleteMany({ where: { id: { in: ids.products } } });
    } catch (e) { console.error('cleanup error:', e.message); }
    await prisma.$disconnect();
    console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
