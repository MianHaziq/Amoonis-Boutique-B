/**
 * Verification harness for the server cart (cart.service) — the module the web
 * storefront now drives. Covers add/increment, stock caps, quantity edits,
 * removal, per-item + order messages, discounted line totals, per-user
 * isolation, clear, and the suggestions payload shape.
 *
 * LOCAL throwaway DB only:
 *   DATABASE_URL="postgresql://postgres@localhost:5432/amoonis_search_test" \
 *     node scripts/cart-verify.js
 */
const prisma = require('../src/config/db');
const cartService = require('../src/services/cart.service');

const TAG = 'ZZCARTTEST';
let failures = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

async function cleanup() {
  await prisma.cartItem.deleteMany({ where: { product: { title: { contains: TAG } } } });
  await prisma.cart.deleteMany({ where: { user: { email: { contains: TAG } } } });
  await prisma.product.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.category.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.user.deleteMany({ where: { email: { contains: TAG } } });
}

async function main() {
  await cleanup();

  const userA = await prisma.user.create({ data: { email: `${TAG}_a@test.local` } });
  const userB = await prisma.user.create({ data: { email: `${TAG}_b@test.local` } });
  const catRose = await prisma.category.create({ data: { title: `${TAG} Roses`, status: 'PUBLISHED' } });
  const catCandle = await prisma.category.create({ data: { title: `${TAG} Candles`, status: 'PUBLISHED' } });

  const mk = (title, price, qty, categoryId, discountedPrice = null) =>
    prisma.product.create({
      data: { title: `${TAG} ${title}`, price, discountedPrice, quantity: qty, status: 'PUBLISHED', categoryId },
    });

  const rose = await mk('Rose Bouquet', 50, 10, catRose.id);
  const roseDisc = await mk('Rose Deluxe', 100, 5, catRose.id, 80);
  const candle = await mk('Vanilla Candle', 30, 10, catCandle.id);
  const soldOut = await mk('Sold Out Rose', 40, 0, catRose.id);

  const A = userA.id;

  // 1. Empty cart
  let cart = await cartService.getCart(A);
  ok('empty cart is empty', cart.items.length === 0 && cart.totalAmount === 0);

  // 2. Add + additive increment
  await cartService.addToCart(A, { productId: rose.id, quantity: 1 });
  let r = await cartService.addToCart(A, { productId: rose.id, quantity: 2 });
  ok('add is additive', r.error === null);
  cart = await cartService.getCart(A);
  const roseLine = cart.items.find((i) => i.productId === rose.id);
  ok('quantity accumulates to 3', roseLine?.quantity === 3, `got ${roseLine?.quantity}`);
  ok('lineTotal = price * qty', roseLine?.lineTotal === 150, `got ${roseLine?.lineTotal}`);

  // 3. Nonexistent product
  r = await cartService.addToCart(A, { productId: '00000000-0000-0000-0000-000000000000', quantity: 1 });
  ok('add nonexistent product errors', r.error === 'Product not found', r.error || '');

  // 4. Stock cap on add (rose has 10; already 3, adding 8 -> 11 > 10)
  r = await cartService.addToCart(A, { productId: rose.id, quantity: 8 });
  ok('add beyond stock is rejected', /in stock/.test(r.error || ''), r.error || '');

  // 5. Out-of-stock product
  r = await cartService.addToCart(A, { productId: soldOut.id, quantity: 1 });
  ok('add out-of-stock product is rejected', /out of stock/.test(r.error || ''), r.error || '');

  // 6. Discounted line total uses the effective (discounted) price
  await cartService.addToCart(A, { productId: roseDisc.id, quantity: 2 });
  cart = await cartService.getCart(A);
  const discLine = cart.items.find((i) => i.productId === roseDisc.id);
  ok('discounted lineTotal uses discountedPrice', discLine?.lineTotal === 160, `got ${discLine?.lineTotal} (expected 80*2)`);

  // 7. totalAmount sums line totals (rose 150 + roseDisc 160 = 310)
  ok('totalAmount sums lines', cart.totalAmount === 310, `got ${cart.totalAmount}`);

  // 8. updateQuantity absolute set + stock cap
  await cartService.updateQuantity(A, { productId: rose.id, quantity: 2 });
  cart = await cartService.getCart(A);
  ok('updateQuantity sets absolute value', cart.items.find((i) => i.productId === rose.id)?.quantity === 2);
  r = await cartService.updateQuantity(A, { productId: rose.id, quantity: 999 });
  ok('updateQuantity beyond stock is rejected', /in stock/.test(r.error || ''), r.error || '');
  r = await cartService.updateQuantity(A, { productId: candle.id, quantity: 1 });
  ok('updateQuantity for item not in cart errors', r.error === 'Product not in cart', r.error || '');

  // 9. updateQuantity 0 removes
  await cartService.updateQuantity(A, { productId: rose.id, quantity: 0 });
  cart = await cartService.getCart(A);
  ok('updateQuantity 0 removes the line', !cart.items.some((i) => i.productId === rose.id));

  // 10. per-item message + order message
  await cartService.updateItemMessage(A, { productId: roseDisc.id, message: 'Happy Birthday' });
  await cartService.updateCartMessage(A, 'Leave at the door');
  cart = await cartService.getCart(A);
  ok('per-item message persists', cart.items.find((i) => i.productId === roseDisc.id)?.message === 'Happy Birthday');
  ok('order message persists', cart.orderMessage === 'Leave at the door');

  // 11. Per-user isolation
  const cartB = await cartService.getCart(userB.id);
  ok('a second user has an independent (empty) cart', cartB.items.length === 0);

  // 12. Suggestions shape: cart has a rose (catRose) → discover pulls from OTHER
  //     categories (candle), excludes cart items, only in-stock.
  const sug = await cartService.getCartSuggestions(A, { discoverLimit: 5, limitPerCategory: 5 });
  ok('suggestions returns {sections, discover, headline, hint}',
    Array.isArray(sug.sections) && Array.isArray(sug.discover) && typeof sug.headline === 'string');
  ok('discover excludes cart items', !sug.discover.some((p) => p.id === roseDisc.id));
  ok('discover only in-stock', sug.discover.every((p) => p.quantity == null || p.quantity > 0));
  ok('discover surfaces other-category candle', sug.discover.some((p) => p.id === candle.id),
    `discover ids: ${sug.discover.map((p) => p.title).join(', ')}`);

  // 13. clear
  await cartService.clearCart(A);
  cart = await cartService.getCart(A);
  ok('clearCart empties the cart', cart.items.length === 0 && cart.totalAmount === 0);

  await cleanup();
  console.log(`\n${failures === 0 ? '🎉 ALL PASSED' : `💥 ${failures} FAILED`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch {}
  await prisma.$disconnect();
  process.exit(1);
});
