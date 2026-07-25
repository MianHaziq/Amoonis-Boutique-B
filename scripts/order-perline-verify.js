/**
 * SQA: order-level per-line pricing (real DB, real order.service#createOrderCore).
 * Places a guest order containing TWO lines of the SAME product with DIFFERENT
 * add-ons (different effective prices). Proves the OrderItems keep their own
 * prices instead of collapsing to one productId-keyed price (the bug fixed by
 * switching the price maps to index-aligned arrays).
 *
 * LOCAL throwaway DB only:
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/amoonis_sqa_test" \
 *     node scripts/order-perline-verify.js
 */
const prisma = require('../src/config/db');
const orderService = require('../src/services/order.service');

const TAG = 'ZZORDERTEST';
let failures = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}
async function cleanup() {
  await prisma.orderItem.deleteMany({ where: { product: { title: { contains: TAG } } } });
  await prisma.order.deleteMany({ where: { guestEmail: { contains: TAG.toLowerCase() } } });
  await prisma.product.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.category.deleteMany({ where: { title: { contains: TAG } } });
}

async function main() {
  await cleanup();
  const cat = await prisma.category.create({ data: { title: `${TAG} Gifts`, status: 'PUBLISHED' } });
  const product = await prisma.product.create({
    data: {
      title: `${TAG} Balloon`, price: 100, quantity: 50, status: 'PUBLISHED', categoryId: cat.id,
      customNameEnabled: true, customNamePrice: 10, giftCardEnabled: true, giftCardExtraPrice: 15,
    },
  });

  // Two lines, SAME product, DIFFERENT add-ons => different effective unit prices.
  const items = [
    { productId: product.id, quantity: 1, customName: 'Osama', giftCardSelected: false }, // 100 + 10      = 110
    { productId: product.id, quantity: 2, customName: null,    giftCardSelected: true },  // 100 + 15      = 115
    { productId: product.id, quantity: 1, customName: 'Ali',   giftCardSelected: true },  // 100 + 10 + 15 = 125
  ];
  const res = await orderService.createGuestOrder({
    items,
    email: `${TAG.toLowerCase()}@test.local`,
    shippingAddress: { fullName: 'SQA Tester', phone: '+971500000000', area: 'Dubai Marina', city: 'Dubai', country: 'United Arab Emirates' },
  });

  ok('guest order created', res.error === null && !!res.order, res.error || '');
  if (!res.order) { await cleanup(); await prisma.$disconnect(); process.exit(1); }

  const orderItems = await prisma.orderItem.findMany({
    where: { orderId: res.order.id },
    select: { customName: true, giftCardSelected: true, quantity: true, price: true },
  });
  const priceOf = (predicate) => Number(orderItems.find(predicate)?.price);

  ok('3 separate order items (no merge/collapse)', orderItems.length === 3, `got ${orderItems.length}`);
  ok('Osama (name only) line = 110', priceOf((i) => i.customName === 'Osama') === 110, `got ${priceOf((i) => i.customName === 'Osama')}`);
  ok('gift-card-only line = 115', priceOf((i) => !i.customName && i.giftCardSelected) === 115, `got ${priceOf((i) => !i.customName && i.giftCardSelected)}`);
  ok('Ali (name + gift card) line = 125', priceOf((i) => i.customName === 'Ali') === 125, `got ${priceOf((i) => i.customName === 'Ali')}`);
  // The old productId-keyed price Map would have made ALL three the same price.
  ok('the 3 lines have 3 DISTINCT prices (collapse gone)', new Set(orderItems.map((i) => Number(i.price))).size === 3);

  await cleanup();
  console.log(`\n${failures === 0 ? '🎉 ALL PASSED' : `❌ ${failures} FAILED`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
