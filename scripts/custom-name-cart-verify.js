/**
 * SQA: custom-name / gift-card cart line identity (server-side, real DB).
 * Verifies same product+variant with different names/gift-card toggles form
 * SEPARATE lines (each own qty & price), that same name+config MERGES, that the
 * @@unique([cartId, productId, variantKey]) constraint permits it, and that
 * per-line quantity/remove targeting hits the right line.
 *
 * LOCAL throwaway DB only (never production):
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/amoonis_sqa_test" \
 *     node scripts/custom-name-cart-verify.js
 */
const prisma = require('../src/config/db');
const cartService = require('../src/services/cart.service');

const TAG = 'ZZNAMETEST';
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
  const user = await prisma.user.create({ data: { email: `${TAG}@test.local` } });
  const cat = await prisma.category.create({ data: { title: `${TAG} Gifts`, status: 'PUBLISHED' } });
  // Product supports BOTH add-ons; base 100, +10 custom name, +15 gift card.
  const product = await prisma.product.create({
    data: {
      title: `${TAG} Balloon`, price: 100, quantity: 50, status: 'PUBLISHED', categoryId: cat.id,
      customNameEnabled: true, customNamePrice: 10, giftCardEnabled: true, giftCardExtraPrice: 15,
    },
  });
  const U = user.id;
  const opts = { Colour: 'Red' };

  // 1. Same product+variant, two DIFFERENT names -> two lines, qty 1 each
  await cartService.addToCart(U, { productId: product.id, quantity: 1, selectedOptions: opts, customName: 'Osama' });
  await cartService.addToCart(U, { productId: product.id, quantity: 1, selectedOptions: opts, customName: 'Ali' });
  let cart = await cartService.getCart(U);
  const named = cart.items.filter((i) => i.customName);
  ok('two names -> 2 lines', cart.items.length === 2);
  ok('each named line qty 1', named.every((i) => i.quantity === 1));
  ok('names are Osama & Ali', named.map((i) => i.customName).sort().join(',') === 'Ali,Osama');
  ok('each line priced base+customName (110)', named.every((i) => i.lineTotal === 110));

  // 2. Re-add "Osama" -> merges into the Osama line (qty 2), still 2 lines
  await cartService.addToCart(U, { productId: product.id, quantity: 1, selectedOptions: opts, customName: 'Osama' });
  cart = await cartService.getCart(U);
  ok('re-add same name merges (still 2 lines)', cart.items.length === 2);
  ok('Osama line now qty 2', cart.items.find((i) => i.customName === 'Osama')?.quantity === 2);

  // 3. Same name "Osama" but WITH gift card -> a distinct third line
  await cartService.addToCart(U, { productId: product.id, quantity: 1, selectedOptions: opts, customName: 'Osama', giftCardSelected: true });
  cart = await cartService.getCart(U);
  ok('same name + gift card = separate line (3 lines)', cart.items.length === 3);
  const osamaGc = cart.items.find((i) => i.customName === 'Osama' && i.giftCardSelected);
  ok('gift-card line priced base+name+gc (125)', osamaGc?.lineTotal === 125);

  // 4. DB-level: the unique([cartId, productId, variantKey]) allowed 3 rows for ONE product
  const rows = await prisma.cartItem.findMany({ where: { cart: { userId: U }, productId: product.id }, select: { variantKey: true, quantity: true } });
  ok('DB holds 3 rows for one product (unique constraint permits it)', rows.length === 3);
  ok('all 3 variantKeys are distinct', new Set(rows.map((r) => r.variantKey)).size === 3);
  ok('variantKeys are name/variant-scoped', rows.every((r) => r.variantKey.startsWith('Colour=Red')));

  // 5. Per-line quantity targeting: bump ONLY the "Ali" line by its variantKey
  const aliKey = cart.items.find((i) => i.customName === 'Ali').variantKey;
  await cartService.updateQuantity(U, { productId: product.id, variantKey: aliKey, quantity: 5 });
  cart = await cartService.getCart(U);
  ok('updateQuantity targets exact line (Ali=5)', cart.items.find((i) => i.customName === 'Ali')?.quantity === 5);
  ok('other lines untouched (Osama still 2)', cart.items.find((i) => i.customName === 'Osama' && !i.giftCardSelected)?.quantity === 2);

  // 6. Per-line removal: remove ONLY the "Ali" line
  await cartService.removeFromCart(U, product.id, { variantKey: aliKey });
  cart = await cartService.getCart(U);
  ok('remove targets exact line (Ali gone)', !cart.items.some((i) => i.customName === 'Ali'));
  ok('other lines survive (2 remain)', cart.items.length === 2);

  // 7. Non-personalized add on the SAME product still merges into its own single line
  await cartService.addToCart(U, { productId: product.id, quantity: 1, selectedOptions: opts });
  await cartService.addToCart(U, { productId: product.id, quantity: 1, selectedOptions: opts });
  cart = await cartService.getCart(U);
  const plain = cart.items.find((i) => !i.customName && !i.giftCardSelected);
  ok('non-personalized merges into one line (qty 2)', plain?.quantity === 2);
  ok('plain line priced at base (100)', plain?.lineTotal === 200 / 1 / 1 * 1 && plain?.lineTotal === 200);

  await cleanup();
  console.log(`\n${failures === 0 ? '🎉 ALL PASSED' : `❌ ${failures} FAILED`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
