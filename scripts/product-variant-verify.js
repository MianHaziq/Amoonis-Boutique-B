/**
 * Verification harness for Product variants (Small/Medium/Large-style, real price/
 * photos/contents per value) — covers product.service normalization + mapping,
 * cart.service line pricing, and order.service live pricing at checkout.
 *
 * Every bilingual field below supplies BOTH English and Arabic text, so autoTranslate
 * short-circuits (manual override — see utils/bilingual.js) and this script has no
 * network dependency.
 *
 * LOCAL throwaway DB only:
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/test1" \
 *     node scripts/product-variant-verify.js
 */
const prisma = require('../src/config/db');
const productService = require('../src/services/product.service');
const cartService = require('../src/services/cart.service');
const orderService = require('../src/services/order.service');

const TAG = 'ZZVARIANTTEST';
let failures = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

async function cleanup() {
  await prisma.cartItem.deleteMany({ where: { product: { title: { contains: TAG } } } });
  await prisma.cart.deleteMany({ where: { user: { email: { contains: TAG.toLowerCase() } } } });
  await prisma.orderItem.deleteMany({ where: { product: { title: { contains: TAG } } } });
  await prisma.order.deleteMany({ where: { guestEmail: { contains: TAG.toLowerCase() } } });
  await prisma.product.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.category.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.user.deleteMany({ where: { email: { contains: TAG.toLowerCase() } } });
}

const SHIPPING = {
  fullName: 'Variant Tester', phone: '+971500000000',
  streetAddress: '1 Test St', area: 'Dubai Marina', city: 'Dubai', country: 'United Arab Emirates',
};

async function main() {
  await cleanup();

  const cat = await prisma.category.create({ data: { title: `${TAG} Gift Boxes`, title_ar: `${TAG} صناديق`, status: 'PUBLISHED' } });

  // --- 1. Create the merged product: one listing, three size variants ---------------
  const created = await productService.createProduct({
    title: `${TAG} Graduation Giveaway Box`,
    title_ar: `${TAG} صندوق التخرج`,
    price: 999, // must be ignored — variants are the source of truth once present
    quantity: 30,
    status: 'PUBLISHED',
    categoryId: cat.id,
    productOptions: [
      {
        title: 'Size', title_ar: 'المقاس',
        options: ['Small', 'Medium', 'Large'], options_ar: ['صغير', 'وسط', 'كبير'],
        isVariantAxis: true,
      },
      {
        // A purely-visual group must NOT affect price/variant matching.
        title: 'Colour', title_ar: 'اللون',
        options: ['Pink'], options_ar: ['وردي'],
        optionImageSets: [['https://img.test/pink.jpg']],
        isVariantAxis: false,
      },
    ],
    variants: [
      { optionValue: 'Small', optionValue_ar: 'صغير', price: 25, images: ['https://img.test/small.jpg'], contents: 'Small contents', contents_ar: 'محتويات صغيرة', isDefault: true },
      { optionValue: 'Medium', optionValue_ar: 'وسط', price: 30, images: ['https://img.test/medium.jpg'], contents: 'Medium contents', contents_ar: 'محتويات متوسطة' },
      { optionValue: 'Large', optionValue_ar: 'كبير', price: 40, discountedPrice: 35, images: ['https://img.test/large.jpg'], contents: 'Large contents', contents_ar: 'محتويات كبيرة' },
    ],
  });

  const mapped = productService.mapProduct(created);
  ok('product created with 3 variants', mapped.variants.length === 3, `got ${mapped.variants.length}`);
  ok('priceRange is {min:25, max:35}', mapped.priceRange?.min === 25 && mapped.priceRange?.max === 35, JSON.stringify(mapped.priceRange));
  ok('top-level price mirrors the default variant (Small=25)', mapped.price === 25, `got ${mapped.price}`);
  ok('top-level discountedPrice mirrors default variant (null)', mapped.discountedPrice === null, `got ${mapped.discountedPrice}`);
  ok('Size option flagged isVariantAxis', mapped.productOptions.find((o) => o.title === 'Size')?.isVariantAxis === true);
  ok('Colour option NOT flagged isVariantAxis', mapped.productOptions.find((o) => o.title === 'Colour')?.isVariantAxis === false);
  ok('exactly one variant isDefault', mapped.variants.filter((v) => v.isDefault).length === 1);

  // --- 2. Re-fetch via getProductById (staff) — same shape from a fresh read --------
  const fetched = await productService.getProductById(created.id, { isStaff: true });
  ok('getProductById returns the 3 variants', fetched.variants.length === 3, `got ${fetched.variants.length}`);

  // --- 3. Regression: pure colour-swatch image resolution (no variants) still works -
  const colourOnlyImg = productService.resolveVariantImage(
    fetched.productOptions.map((o) => ({ ...o })),
    { Colour: 'Pink' },
    [] // no variants matched — must fall through to the legacy optionImageSets path
  );
  ok('non-variant colour swatch image resolution unaffected', colourOnlyImg === 'https://img.test/pink.jpg', `got ${colourOnlyImg}`);

  // --- 4. Cart: selecting a size resolves that variant's price + photo --------------
  const user = await prisma.user.create({ data: { email: `${TAG.toLowerCase()}@test.local` } });
  await cartService.addToCart(user.id, { productId: created.id, quantity: 1, selectedOptions: { Size: 'Large' } });
  await cartService.addToCart(user.id, { productId: created.id, quantity: 2, selectedOptions: { Size: 'Medium' } });
  // No selection at all (legacy client) — falls back to the default variant (Small).
  await cartService.addToCart(user.id, { productId: created.id, quantity: 1 });

  const cart = await cartService.getCart(user.id);
  ok('cart has 3 distinct variant lines', cart.items.length === 3, `got ${cart.items.length}`);
  const largeLine = cart.items.find((i) => i.selectedOptions?.Size === 'Large');
  const mediumLine = cart.items.find((i) => i.selectedOptions?.Size === 'Medium');
  const legacyLine = cart.items.find((i) => !i.selectedOptions);
  ok('Large line total = 35 (discounted variant price x1)', largeLine?.lineTotal === 35, `got ${largeLine?.lineTotal}`);
  ok('Large line selectedImage = the Large variant photo', largeLine?.selectedImage === 'https://img.test/large.jpg', `got ${largeLine?.selectedImage}`);
  ok('Medium line total = 60 (30 x2)', mediumLine?.lineTotal === 60, `got ${mediumLine?.lineTotal}`);
  ok('no-selection legacy line falls back to default variant (25 x1)', legacyLine?.lineTotal === 25, `got ${legacyLine?.lineTotal}`);

  // --- 5. Arabic-keyed selection resolves the same variant ---------------------------
  await cartService.removeFromCart(user.id, created.id, { selectedOptions: {} }); // clear the legacy line
  const arCartRes = await cartService.addToCart(user.id, { productId: created.id, quantity: 1, selectedOptions: { 'المقاس': 'كبير' } });
  ok('Arabic-keyed/valued selection succeeds', arCartRes.error === null, arCartRes.error || '');
  const arCart = await cartService.getCart(user.id);
  const arLine = arCart.items.find((i) => i.selectedOptions?.['المقاس'] === 'كبير');
  ok('Arabic selection resolves to the Large variant price (35)', arLine?.lineTotal === 35, `got ${arLine?.lineTotal}`);

  // --- 6. Order: live pricing at checkout resolves per-line variants -----------------
  const orderRes = await orderService.createGuestOrder({
    items: [
      { productId: created.id, quantity: 1, selectedOptions: { Size: 'Large' } },
      { productId: created.id, quantity: 2, selectedOptions: { Size: 'Medium' } },
    ],
    email: `${TAG.toLowerCase()}.guest@test.local`,
    shippingAddress: SHIPPING,
  });
  ok('guest order created', orderRes.error === null && !!orderRes.order, orderRes.error || '');
  if (orderRes.order) {
    const orderItems = await prisma.orderItem.findMany({
      where: { orderId: orderRes.order.id },
      select: { selectedOptions: true, quantity: true, price: true },
    });
    const largeItem = orderItems.find((i) => i.selectedOptions?.Size === 'Large');
    const mediumItem = orderItems.find((i) => i.selectedOptions?.Size === 'Medium');
    ok('order line price = Large variant discounted price (35)', Number(largeItem?.price) === 35, `got ${largeItem?.price}`);
    ok('order line price = Medium variant price (30)', Number(mediumItem?.price) === 30, `got ${mediumItem?.price}`);
  }

  // --- 7. Validation: a variant with no price throws INVALID_PRICE ------------------
  let invalidPriceThrown = false;
  try {
    await productService.createProduct({
      title: `${TAG} Bad Product 1`, title_ar: `${TAG} منتج سيء`, price: 10, quantity: 1, status: 'DRAFT', categoryId: cat.id,
      variants: [{ optionValue: 'Only', optionValue_ar: 'فقط' }],
    });
  } catch (err) {
    invalidPriceThrown = err.code === 'INVALID_PRICE';
  }
  ok('variant with no price throws INVALID_PRICE', invalidPriceThrown);

  // --- 8. Validation: discountedPrice > price throws INVALID_PRICE ------------------
  let invalidDiscountThrown = false;
  try {
    await productService.createProduct({
      title: `${TAG} Bad Product 2`, title_ar: `${TAG} منتج سيء 2`, price: 10, quantity: 1, status: 'DRAFT', categoryId: cat.id,
      variants: [{ optionValue: 'Only', optionValue_ar: 'فقط', price: 20, discountedPrice: 25 }],
    });
  } catch (err) {
    invalidDiscountThrown = err.code === 'INVALID_PRICE';
  }
  ok('variant discountedPrice > price throws INVALID_PRICE', invalidDiscountThrown);

  // --- 9. Two variants marked isDefault -> only the first stays default -------------
  const twoDefaults = await productService.createProduct({
    title: `${TAG} Two Defaults`, title_ar: `${TAG} افتراضيان`, price: 10, quantity: 1, status: 'DRAFT', categoryId: cat.id,
    variants: [
      { optionValue: 'A', optionValue_ar: 'أ', price: 10, isDefault: true },
      { optionValue: 'B', optionValue_ar: 'ب', price: 20, isDefault: true },
    ],
  });
  const mappedTwoDefaults = productService.mapProduct(twoDefaults);
  ok('exactly one isDefault survives when two are sent', mappedTwoDefaults.variants.filter((v) => v.isDefault).length === 1);
  ok('the FIRST explicit isDefault choice wins', mappedTwoDefaults.variants.find((v) => v.isDefault)?.optionValue === 'A');

  // --- 10. Duplicate labels are de-duped (would otherwise violate the DB unique) ----
  const dupes = await productService.createProduct({
    title: `${TAG} Dupes`, title_ar: `${TAG} تكرار`, price: 10, quantity: 1, status: 'DRAFT', categoryId: cat.id,
    variants: [
      { optionValue: 'Large', optionValue_ar: 'كبير', price: 40 },
      { optionValue: 'large', optionValue_ar: 'كبير 2', price: 45 },
    ],
  });
  const mappedDupes = productService.mapProduct(dupes);
  ok('case-insensitive duplicate variant labels are de-duped', mappedDupes.variants.length === 1, `got ${mappedDupes.variants.length}`);

  // --- 11. Per-variant description blocks: shared vs override, at create -----------
  const descProduct = await productService.createProduct({
    title: `${TAG} Variant Descriptions`, title_ar: `${TAG} أوصاف المتغيرات`,
    price: 10, quantity: 5, status: 'PUBLISHED', categoryId: cat.id,
    descriptions: [
      { title: 'Shared Care Info', title_ar: 'معلومات العناية المشتركة', description: 'Shared care text', description_ar: 'نص العناية المشترك' },
    ],
    productOptions: [
      { title: 'Size', title_ar: 'المقاس', options: ['Small', 'Medium', 'Large'], options_ar: ['صغير', 'وسط', 'كبير'], isVariantAxis: true },
    ],
    variants: [
      { optionValue: 'Small', optionValue_ar: 'صغير', price: 25, isDefault: true },
      { optionValue: 'Medium', optionValue_ar: 'وسط', price: 30 },
      {
        optionValue: 'Large', optionValue_ar: 'كبير', price: 40,
        descriptions: [
          { title: 'Large-only note', title_ar: 'ملاحظة خاصة بالكبير', description: 'Large only text', description_ar: 'نص خاص بالكبير' },
        ],
      },
    ],
  });
  const mappedDesc = productService.mapProduct(descProduct);
  ok('shared descriptions list has 1 block', mappedDesc.descriptions.length === 1, `got ${mappedDesc.descriptions.length}`);
  const smallV = mappedDesc.variants.find((v) => v.optionValue === 'Small');
  const mediumV = mappedDesc.variants.find((v) => v.optionValue === 'Medium');
  const largeV = mappedDesc.variants.find((v) => v.optionValue === 'Large');
  ok('Small variant has no description override (shares the shared blocks)', smallV?.descriptions.length === 0, `got ${smallV?.descriptions.length}`);
  ok('Medium variant has no description override', mediumV?.descriptions.length === 0, `got ${mediumV?.descriptions.length}`);
  ok('Large variant has its own 1 override block', largeV?.descriptions.length === 1, `got ${largeV?.descriptions.length}`);
  ok('Large override title is correct', largeV?.descriptions[0]?.title === 'Large-only note', largeV?.descriptions[0]?.title);

  // --- 12. Same shape survives a fresh read via getProductById ----------------------
  const fetchedDesc = await productService.getProductById(descProduct.id, { isStaff: true });
  const fetchedLarge = fetchedDesc.variants.find((v) => v.optionValue === 'Large');
  ok('getProductById: Large override still present after fresh read', fetchedLarge?.descriptions.length === 1 && fetchedLarge.descriptions[0].description === 'Large only text');

  // --- 13. Update: give Medium its own override, remove Large's (revert to shared) --
  const updated1 = await productService.updateProduct(descProduct.id, {
    variants: [
      { optionValue: 'Small', optionValue_ar: 'صغير', price: 25, isDefault: true },
      {
        optionValue: 'Medium', optionValue_ar: 'وسط', price: 30,
        descriptions: [{ title: 'Medium note', title_ar: 'ملاحظة متوسطة', description: 'Medium only text', description_ar: 'نص خاص بالمتوسط' }],
      },
      { optionValue: 'Large', optionValue_ar: 'كبير', price: 40 }, // no descriptions -> reverts to shared
    ],
  });
  const mappedUpdated1 = productService.mapProduct(updated1);
  const mediumV2 = mappedUpdated1.variants.find((v) => v.optionValue === 'Medium');
  const largeV2 = mappedUpdated1.variants.find((v) => v.optionValue === 'Large');
  ok('after update: Medium now has its own override', mediumV2?.descriptions.length === 1 && mediumV2.descriptions[0].description === 'Medium only text');
  ok('after update: Large reverted to sharing (no override rows)', largeV2?.descriptions.length === 0, `got ${largeV2?.descriptions.length}`);

  // --- 14. Editing ONLY the shared descriptions must NOT wipe Medium's override -----
  const updated2 = await productService.updateProduct(descProduct.id, {
    descriptions: [
      { title: 'Shared Care Info v2', title_ar: 'معلومات العناية المشتركة 2', description: 'Shared care text v2', description_ar: 'نص العناية المشترك 2' },
    ],
  });
  const mappedUpdated2 = productService.mapProduct(updated2);
  ok('shared descriptions replaced (v2 text)', mappedUpdated2.descriptions[0]?.description === 'Shared care text v2');
  const mediumV3 = mappedUpdated2.variants.find((v) => v.optionValue === 'Medium');
  ok('Medium override SURVIVES an edit to the shared blocks (scoped delete)', mediumV3?.descriptions.length === 1 && mediumV3.descriptions[0].description === 'Medium only text');

  await cleanup();
  console.log(`\n${failures === 0 ? '🎉 ALL PASSED' : `❌ ${failures} FAILED`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
