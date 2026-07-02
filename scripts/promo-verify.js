/**
 * Verification harness for promo-code validation (promoCode.service.validateAndCalculate)
 * — the contract the web checkout now consumes. Asserts the SUCCESS response shape the
 * frontend reads (promoCode, cartSubtotal, eligibleSubtotal, discountAmount, total,
 * eligibleProductIds), percentage cap + fixed math, scope filtering, and that each
 * ineligibility throws the expected PROMO_* code (the frontend surfaces the message).
 *
 * LOCAL throwaway DB only:
 *   DATABASE_URL="postgresql://postgres@localhost:5432/amoonis_search_test" \
 *     node scripts/promo-verify.js
 */
const prisma = require("../src/config/db");
const svc = require("../src/services/promoCode.service");

const TAG = "ZZPROMOTEST";
let failures = 0;
function ok(name, cond, extra = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}
async function expectCode(name, fn, code) {
  try {
    await fn();
    ok(name, false, "expected throw, got success");
  } catch (e) {
    ok(name, e.code === code, `got code=${e.code} msg="${e.message}"`);
  }
}

async function cleanup() {
  await prisma.promoCode.deleteMany({ where: { code: { startsWith: TAG } } });
  await prisma.product.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.category.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.user.deleteMany({ where: { email: { contains: TAG } } });
}

async function main() {
  await cleanup();

  const oldUser = await prisma.user.create({
    data: { email: `${TAG}_old@test.local`, createdAt: new Date("2020-01-01") },
  });
  const newUser = await prisma.user.create({ data: { email: `${TAG}_new@test.local` } });
  const cat = await prisma.category.create({ data: { title: `${TAG} Roses`, status: "PUBLISHED" } });
  const rose = await prisma.product.create({ data: { title: `${TAG} Rose`, price: 100, quantity: 50, status: "PUBLISHED", categoryId: cat.id } });
  const candle = await prisma.product.create({ data: { title: `${TAG} Candle`, price: 100, quantity: 50, status: "PUBLISHED" } });

  const items = [
    { productId: rose.id, quantity: 1, price: 100, categoryId: cat.id },
    { productId: candle.id, quantity: 1, price: 100, categoryId: null },
  ];
  const day = 86_400_000;
  const mkPromo = (over) =>
    prisma.promoCode.create({
      data: {
        code: `${TAG}${Math.round(over.__n * 1)}`,
        name: over.name || "Test",
        discountType: over.discountType || "PERCENTAGE",
        discountValue: over.discountValue ?? 10,
        appliesTo: over.appliesTo || "ALL_PRODUCTS",
        maxDiscountAmount: over.maxDiscountAmount ?? null,
        minOrderAmount: over.minOrderAmount ?? null,
        maxOrderAmount: over.maxOrderAmount ?? null,
        startsAt: over.startsAt ?? null,
        expiresAt: over.expiresAt ?? null,
        isActive: over.isActive ?? true,
        newUsersOnly: over.newUsersOnly ?? false,
        newUserWithinDays: over.newUserWithinDays ?? null,
      },
    });
  let n = 0;
  const next = () => ({ __n: n++ });

  // 1. Percentage, ALL_PRODUCTS — 10% of 200 = 20; response shape the FE reads.
  const p1 = await mkPromo({ ...next(), discountType: "PERCENTAGE", discountValue: 10 });
  const r1 = await svc.validateAndCalculate(p1.code, oldUser.id, items);
  ok("success has discountAmount (10% of 200 = 20)", r1.discountAmount === 20, `got ${r1.discountAmount}`);
  ok("success shape: promoCode/cartSubtotal/eligibleSubtotal/total/eligibleProductIds present",
    !!r1.promoCode && r1.cartSubtotal === 200 && r1.eligibleSubtotal === 200 && r1.total === 180 && Array.isArray(r1.eligibleProductIds),
    JSON.stringify({ cs: r1.cartSubtotal, es: r1.eligibleSubtotal, t: r1.total }));
  ok("promoCode carries newUsersOnly flag", typeof r1.promoCode.newUsersOnly === "boolean");

  // 2. Percentage with maxDiscountAmount cap
  const p2 = await mkPromo({ ...next(), discountType: "PERCENTAGE", discountValue: 50, maxDiscountAmount: 30 });
  const r2 = await svc.validateAndCalculate(p2.code, oldUser.id, items);
  ok("percentage discount capped by maxDiscountAmount (50% of 200=100 → cap 30)", r2.discountAmount === 30, `got ${r2.discountAmount}`);

  // 3. Fixed
  const p3 = await mkPromo({ ...next(), discountType: "FIXED", discountValue: 25 });
  const r3 = await svc.validateAndCalculate(p3.code, oldUser.id, items);
  ok("fixed discount is flat", r3.discountAmount === 25, `got ${r3.discountAmount}`);

  // 4. Scope SPECIFIC_CATEGORIES — only the rose (cat) is eligible → 10% of 100 = 10
  const p4 = await mkPromo({ ...next(), discountType: "PERCENTAGE", discountValue: 10, appliesTo: "SPECIFIC_CATEGORIES" });
  await prisma.promoCodeCategory.create({ data: { promoCodeId: p4.id, categoryId: cat.id } });
  const r4 = await svc.validateAndCalculate(p4.code, oldUser.id, items);
  ok("category-scoped discount only counts eligible subtotal", r4.eligibleSubtotal === 100 && r4.discountAmount === 10, `es=${r4.eligibleSubtotal} d=${r4.discountAmount}`);
  ok("eligibleProductIds lists only the in-scope product", r4.eligibleProductIds.length === 1 && r4.eligibleProductIds[0] === rose.id);

  // 5. Min order not met
  const p5 = await mkPromo({ ...next(), minOrderAmount: 500 });
  await expectCode("min order not met throws PROMO_MIN_ORDER_NOT_MET", () => svc.validateAndCalculate(p5.code, oldUser.id, items), "PROMO_MIN_ORDER_NOT_MET");

  // 6. Expired
  const p6 = await mkPromo({ ...next(), expiresAt: new Date(Date.now() - day) });
  await expectCode("expired throws PROMO_EXPIRED", () => svc.validateAndCalculate(p6.code, oldUser.id, items), "PROMO_EXPIRED");

  // 7. Not started
  const p7 = await mkPromo({ ...next(), startsAt: new Date(Date.now() + day) });
  await expectCode("future start throws PROMO_NOT_STARTED", () => svc.validateAndCalculate(p7.code, oldUser.id, items), "PROMO_NOT_STARTED");

  // 8. Inactive
  const p8 = await mkPromo({ ...next(), isActive: false });
  await expectCode("inactive throws PROMO_INACTIVE", () => svc.validateAndCalculate(p8.code, oldUser.id, items), "PROMO_INACTIVE");

  // 9. Unknown code
  await expectCode("unknown code throws PROMO_NOT_FOUND", () => svc.validateAndCalculate(`${TAG}_NOPE`, oldUser.id, items), "PROMO_NOT_FOUND");

  // 10. New-users-only: old account rejected, fresh account accepted
  const p10 = await mkPromo({ ...next(), newUsersOnly: true, newUserWithinDays: 30 });
  await expectCode("new-users-only rejects an old account", () => svc.validateAndCalculate(p10.code, oldUser.id, items), "PROMO_NEW_USERS_ONLY");
  const r10 = await svc.validateAndCalculate(p10.code, newUser.id, items);
  ok("new-users-only accepts a fresh account", r10.discountAmount === 20, `got ${r10.discountAmount}`);

  await cleanup();
  console.log(`\n${failures === 0 ? "🎉 ALL PASSED" : `💥 ${failures} FAILED`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch {}
  await prisma.$disconnect();
  process.exit(1);
});
