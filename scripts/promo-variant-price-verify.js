/**
 * Verification harness for the promo-code PREVIEW endpoint's variant-price fix
 * (POST /promo-codes/validate). Unlike scripts/promo-verify.js (which calls
 * promoCodeService.validateAndCalculate directly and never exercises the
 * controller's item-hydration bug), this hits the REAL HTTP endpoint — the exact
 * path the storefront checkout page uses — so it actually covers the fix in
 * src/controllers/promoCode.controller.js (item hydration was reading the
 * parent Product's own price/discountedPrice instead of resolving the selected
 * ProductVariant's price).
 *
 * Requires the backend dev server already running on :5000 against the SAME
 * local throwaway DB this script writes to.
 *
 * LOCAL throwaway DB only:
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/test1" \
 *     node scripts/promo-variant-price-verify.js
 */
const prisma = require('../src/config/db');
const productService = require('../src/services/product.service');

const TAG = 'ZZPROMOVARIANT';
const API = 'http://localhost:5000/api/v1';
let failures = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

async function cleanup() {
  await prisma.promoCode.deleteMany({ where: { code: { startsWith: TAG } } });
  await prisma.product.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.category.deleteMany({ where: { title: { contains: TAG } } });
}

async function validate(code, items) {
  const res = await fetch(`${API}/promo-codes/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, items }),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function main() {
  await cleanup();

  const cat = await prisma.category.create({ data: { title: `${TAG} Gift Boxes`, status: 'PUBLISHED' } });
  const defaultRegion = await prisma.region.findFirst({ where: { isDefault: true } });
  const promo = await prisma.promoCode.create({
    data: {
      code: `${TAG}10`,
      name: 'Test 10%',
      discountType: 'PERCENTAGE',
      discountValue: 10,
      appliesTo: 'ALL_PRODUCTS',
      isActive: true,
      regions: { create: [{ regionId: defaultRegion.id }] },
    },
  });

  const product = await productService.createProduct({
    title: `${TAG} Graduation Box`,
    title_ar: `${TAG} صندوق`,
    price: 999, // must be ignored — variants are the source of truth
    quantity: 30,
    status: 'PUBLISHED',
    categoryId: cat.id,
    productOptions: [
      { title: 'Size', title_ar: 'المقاس', options: ['Small', 'Medium', 'Large'], options_ar: ['صغير', 'وسط', 'كبير'], isVariantAxis: true },
    ],
    variants: [
      { optionValue: 'Small', optionValue_ar: 'صغير', price: 25, isDefault: true },
      { optionValue: 'Medium', optionValue_ar: 'وسط', price: 30 },
      { optionValue: 'Large', optionValue_ar: 'كبير', price: 40 },
    ],
  });

  // --- 1. Guest-style preview: item sent WITHOUT price, WITH selectedOptions ---
  // (exactly what the storefront checkout page now sends).
  const large = await validate(promo.code, [
    { productId: product.id, quantity: 1, selectedOptions: { Size: 'Large' } },
  ]);
  ok('Large preview succeeds', large.status === 200, JSON.stringify(large.json));
  ok(
    'Large preview: eligibleSubtotal = 40 (not default 25)',
    large.json?.data?.eligibleSubtotal === 40,
    `got ${large.json?.data?.eligibleSubtotal}`
  );
  ok(
    'Large preview: discountAmount = 4 (10% of 40)',
    large.json?.data?.discountAmount === 4,
    `got ${large.json?.data?.discountAmount}`
  );

  const medium = await validate(promo.code, [
    { productId: product.id, quantity: 2, selectedOptions: { Size: 'Medium' } },
  ]);
  ok(
    'Medium x2 preview: eligibleSubtotal = 60 (30 x2, not default 25 x2=50)',
    medium.json?.data?.eligibleSubtotal === 60,
    `got ${medium.json?.data?.eligibleSubtotal}`
  );
  ok(
    'Medium x2 preview: discountAmount = 6 (10% of 60)',
    medium.json?.data?.discountAmount === 6,
    `got ${medium.json?.data?.discountAmount}`
  );

  // --- 2. No selection at all (legacy-shaped item) falls back to the default variant ---
  const noSelection = await validate(promo.code, [{ productId: product.id, quantity: 1 }]);
  ok(
    'No-selection preview falls back to default variant (25)',
    noSelection.json?.data?.eligibleSubtotal === 25,
    `got ${noSelection.json?.data?.eligibleSubtotal}`
  );

  await cleanup();
  console.log(`\n${failures === 0 ? '🎉 ALL PASSED' : `❌ ${failures} FAILED`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
