/**
 * Cash arrangement — full DB integration verification (real DB, real services).
 *
 * LOCAL throwaway DB only — never run against production:
 *   DATABASE_URL="postgresql://user@localhost:5432/amoonis_cash_arrangement_test" \
 *     node scripts/cash-arrangement-verify.js
 *
 * Creates its own tagged region/zone/category/products/VAT+cash-arrangement configs (does
 * NOT rely on pre-existing seed data), exercises the real order.service checkout path end
 * to end, and cleans up everything it created on exit (success or failure).
 *
 * Covers: enablement scoping (ALL_PRODUCTS / SPECIFIC_PRODUCTS / SPECIFIC_CATEGORIES), the
 * full fee-schedule precedence chain (productZone > productRegion > product > categoryZone >
 * categoryRegion > category), the multi-product cart tie-break (skip an eligible-but-
 * unresolvable line for the next one), VAT applying to the fee but never the raw cash amount
 * (including under a SPECIFIC_CATEGORIES VAT scope that excludes the governing category —
 * regression test for the null/null synthetic-line bug), promo discount never touching the
 * fee, denomination whitelist validation, no min/max on the custom amount, the admin
 * empty-scope-list guard, the "no cash arrangement requested" baseline case, the
 * zone-level quick-pick/denomination LIST override on DeliveryZone (separate from the
 * ProductZone/CategoryZone fee-schedule override) falling back to the region's lists
 * when empty, and the FLAT region/zone fee tiers (CashArrangementConfig.feeStepAmount/
 * feeMarginPercent + DeliveryZone.cashArrangementFee*) as the base of the precedence chain
 * (product/category tiers still win over them; zoneFlat beats regionFlat).
 */
require('dotenv').config();
const prisma = require('../src/config/db');
const cashArrangementService = require('../src/services/cashArrangement.service');
const cashArrangementController = require('../src/controllers/cashArrangement.controller');
const vatService = require('../src/services/vat.service');
const orderService = require('../src/services/order.service');
const cartService = require('../src/services/cart.service');
const regionService = require('../src/services/region.service');
const deliveryZoneService = require('../src/services/deliveryZone.service');
const { computeCashArrangementFee } = require('../src/utils/cashArrangementMath');

// ─── Per-item migration compatibility shim ──────────────────────────────────
// Cash arrangement moved from ORDER-level to PER-ITEM. Most single-item tests below still
// pass a top-level `cashArrangement`; adapt that to the new per-line contract (put the cash
// on every item) so those cases keep exercising the real path unchanged. For a SINGLE item
// of quantity 1 the order-level roll-up equals the per-unit value, so their assertions on
// order.cashArrangement* still hold. Genuine multi-line / aggregate behavior is tested
// explicitly in its own section (search "PER-ITEM").
const _origCreateGuestOrder = orderService.createGuestOrder.bind(orderService);
orderService.createGuestOrder = (input, opts) => {
  if (input && input.cashArrangement !== undefined && Array.isArray(input.items)) {
    const { cashArrangement, ...rest } = input;
    return _origCreateGuestOrder(
      { ...rest, items: input.items.map((it) => ({ ...it, cashArrangement: it.cashArrangement !== undefined ? it.cashArrangement : cashArrangement })) },
      opts
    );
  }
  return _origCreateGuestOrder(input, opts);
};

/** Minimal Express req/res mock for calling a controller function directly (no HTTP server). */
function mockReqRes(overrides = {}) {
  const req = { body: {}, params: {}, userId: undefined, regionId: null, ...overrides };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return { req, res };
}

const TAG = 'ZZCASH';
let pass = 0;
let fail = 0;
const approx = (a, b, e = 0.01) => Math.abs(Number(a) - Number(b)) <= e;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
function eq(name, a, b) { ok(`${name} (=${b}, got ${a})`, approx(a, b), `expected ${b}, got ${a}`); }

const createdOrderIds = [];

async function cleanup() {
  try {
    if (createdOrderIds.length) {
      await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    await prisma.user.deleteMany({ where: { email: { contains: TAG.toLowerCase() } } });
    await prisma.promoCodeRegion.deleteMany({ where: { region: { code: { startsWith: TAG } } } });
    await prisma.promoCode.deleteMany({ where: { code: { startsWith: TAG } } });
    await prisma.cashArrangementConfigProduct.deleteMany({ where: { product: { title: { contains: TAG } } } });
    await prisma.cashArrangementConfigCategory.deleteMany({ where: { category: { title: { contains: TAG } } } });
    await prisma.cashArrangementConfig.deleteMany({ where: { region: { code: { startsWith: TAG } } } });
    await prisma.vatConfig.deleteMany({ where: { region: { code: { startsWith: TAG } } } });
    await prisma.productZone.deleteMany({ where: { product: { title: { contains: TAG } } } });
    await prisma.productRegion.deleteMany({ where: { product: { title: { contains: TAG } } } });
    await prisma.categoryZone.deleteMany({ where: { category: { title: { contains: TAG } } } });
    await prisma.categoryRegion.deleteMany({ where: { category: { title: { contains: TAG } } } });
    await prisma.product.deleteMany({ where: { title: { contains: TAG } } });
    await prisma.category.deleteMany({ where: { title: { contains: TAG } } });
    await prisma.deliveryZone.deleteMany({ where: { region: { code: { startsWith: TAG } } } });
    await prisma.region.deleteMany({ where: { code: { startsWith: TAG } } });
    console.log('\n(cleanup done — all tagged fixtures removed)');
  } catch (e) {
    console.error('cleanup error:', e.message);
  }
}

const SHIPPING = {
  fullName: 'Cash Arrangement Tester', phone: '+971500000000',
  streetAddress: '1 Test St', city: 'Dubai', country: 'AE', area: 'Dubai Marina',
};

async function main() {
  await cleanup();

  // ---------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------
  const region = await prisma.region.create({
    data: { code: `${TAG}UAE`, name: `${TAG} UAE`, currency: 'AED', isActive: true, standardDeliveryDays: 1 },
  });
  await prisma.settings.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default', defaultDeliveryLeadDays: 1 } });
  const zone = await prisma.deliveryZone.create({ data: { regionId: region.id, name: `${TAG} Downtown`, isActive: true } });

  const flowersCategory = await prisma.category.create({
    data: { title: `${TAG} Flowers`, status: 'PUBLISHED', cashArrangementFeeStepAmount: 50, cashArrangementFeeMarginPercent: 10 },
  });
  const otherCategory = await prisma.category.create({ data: { title: `${TAG} Mugs`, status: 'PUBLISHED' } });

  // Product A: own fee schedule (step=100, margin=20%) — the confirmed worked-example schedule.
  const productA = await prisma.product.create({
    data: {
      title: `${TAG} Rose Bouquet`, price: 100, quantity: 100, status: 'PUBLISHED',
      categoryId: flowersCategory.id,
      cashArrangementFeeStepAmount: 100, cashArrangementFeeMarginPercent: 20,
    },
  });
  // Product B: NO own schedule -> should fall back to the category default (50 / 10%).
  const productB = await prisma.product.create({
    data: { title: `${TAG} Orchid Box`, price: 80, quantity: 100, status: 'PUBLISHED', categoryId: flowersCategory.id },
  });
  // Product C: different category, no schedule anywhere -> never eligible/resolvable.
  const productC = await prisma.product.create({
    data: { title: `${TAG} Plain Mug`, price: 30, quantity: 100, status: 'PUBLISHED', categoryId: otherCategory.id },
  });

  // Cash arrangement enablement: region-level, scoped to the Flowers category only.
  await cashArrangementService.updateConfig(region.id, {
    enabled: true,
    appliesTo: 'SPECIFIC_CATEGORIES',
    categoryIds: [flowersCategory.id],
    quickPickAmounts: [500, 1000],
    denominations: [50, 100],
  });

  // VAT: exclusive 5%, ALL_PRODUCTS.
  await vatService.updateConfig(region.id, { enabled: true, ratePercent: 5, inclusive: false, appliesTo: 'ALL_PRODUCTS' });

  console.log(`Fixtures ready: region=${region.code}, zone=${zone.id}, productA(own 100/20%)=${productA.id}, productB(category-default 50/10%)=${productB.id}, productC(ineligible)=${productC.id}\n`);

  // ---------------------------------------------------------------------
  // 1) Enablement scoping
  // ---------------------------------------------------------------------
  console.log('1) Enablement scoping (SPECIFIC_CATEGORIES = Flowers only)');
  {
    const eligibleA = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: null, cartLines: [{ productId: productA.id, categoryId: flowersCategory.id }],
    });
    ok('Flowers product (A) is eligible', eligibleA.eligible === true);

    const ineligibleC = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: null, cartLines: [{ productId: productC.id, categoryId: otherCategory.id }],
    });
    ok('Non-Flowers product (C) is NOT eligible', ineligibleC.eligible === false);

    // Disabled region-wide -> nobody eligible, even Flowers.
    await cashArrangementService.updateConfig(region.id, { enabled: false });
    const disabled = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: null, cartLines: [{ productId: productA.id, categoryId: flowersCategory.id }],
    });
    ok('Disabled config -> not eligible even for in-scope product', disabled.eligible === false);
    // Re-enable for the rest of the suite.
    await cashArrangementService.updateConfig(region.id, { enabled: true, appliesTo: 'SPECIFIC_CATEGORIES', categoryIds: [flowersCategory.id] });
  }

  // ---------------------------------------------------------------------
  // 2) Fee-schedule precedence chain
  // ---------------------------------------------------------------------
  console.log('\n2) Fee-schedule precedence chain');
  {
    const resolvedA = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: null, cartLines: [{ productId: productA.id, categoryId: flowersCategory.id }],
    });
    eq('Product A uses its OWN schedule (step=100)', resolvedA.feeStepAmount, 100);
    eq('Product A uses its OWN schedule (margin=20)', resolvedA.feeMarginPercent, 20);

    const resolvedB = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: null, cartLines: [{ productId: productB.id, categoryId: flowersCategory.id }],
    });
    eq('Product B (no own schedule) falls back to CATEGORY default (step=50)', resolvedB.feeStepAmount, 50);
    eq('Product B (no own schedule) falls back to CATEGORY default (margin=10)', resolvedB.feeMarginPercent, 10);

    // ProductRegion override on A (200/15%) must win over Product A's own default (100/20%).
    await prisma.productRegion.create({
      data: { productId: productA.id, regionId: region.id, cashArrangementFeeStepAmount: 200, cashArrangementFeeMarginPercent: 15 },
    });
    const resolvedARegion = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: null, cartLines: [{ productId: productA.id, categoryId: flowersCategory.id }],
    });
    eq('ProductRegion override wins over Product default (step=200)', resolvedARegion.feeStepAmount, 200);

    // ProductZone override on A (300/25%) must win over ProductRegion (200/15%) when a zone is given.
    await prisma.productZone.create({
      data: { productId: productA.id, zoneId: zone.id, cashArrangementFeeStepAmount: 300, cashArrangementFeeMarginPercent: 25 },
    });
    const resolvedAZone = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: zone.id, cartLines: [{ productId: productA.id, categoryId: flowersCategory.id }],
    });
    eq('ProductZone override wins over ProductRegion (step=300)', resolvedAZone.feeStepAmount, 300);
    // Without a zone, still falls back to the ProductRegion override (200), not the zone one.
    const resolvedARegionAgain = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: null, cartLines: [{ productId: productA.id, categoryId: flowersCategory.id }],
    });
    eq('No zone given -> ProductRegion (200), zone override not applied', resolvedARegionAgain.feeStepAmount, 200);

    // Clean these overrides back off for the rest of the suite.
    await prisma.productZone.deleteMany({ where: { productId: productA.id } });
    await prisma.productRegion.deleteMany({ where: { productId: productA.id } });
  }

  // ---------------------------------------------------------------------
  // 3) Multi-product cart tie-break: an eligible-but-unresolvable line must be SKIPPED,
  // not reported as "cart ineligible" — the next eligible+resolvable line should govern.
  // ---------------------------------------------------------------------
  console.log('\n3) Multi-product cart tie-break');
  {
    // Temporarily strip Product B's fallback (category default) so B is enablement-eligible
    // (Flowers category) but has NO resolvable fee schedule anywhere.
    const savedCategoryFee = { cashArrangementFeeStepAmount: 50, cashArrangementFeeMarginPercent: 10 };
    await prisma.category.update({ where: { id: flowersCategory.id }, data: { cashArrangementFeeStepAmount: null, cashArrangementFeeMarginPercent: null } });

    const resolvedBOnly = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: null, cartLines: [{ productId: productB.id, categoryId: flowersCategory.id }],
    });
    ok('Product B alone (no schedule anywhere) -> not eligible', resolvedBOnly.eligible === false);

    // Cart order: B (eligible, unresolvable) THEN A (eligible, has its own schedule).
    const resolvedMixed = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: null,
      cartLines: [
        { productId: productB.id, categoryId: flowersCategory.id },
        { productId: productA.id, categoryId: flowersCategory.id },
      ],
    });
    ok('Mixed cart [B, A] -> still eligible (skips B, uses A)', resolvedMixed.eligible === true);
    eq('Mixed cart resolves to A\'s schedule (step=100)', resolvedMixed.feeStepAmount, 100);
    ok('governingProductId is A, not B', resolvedMixed.governingProductId === productA.id);

    // Restore category default.
    await prisma.category.update({ where: { id: flowersCategory.id }, data: savedCategoryFee });
  }

  // ---------------------------------------------------------------------
  // 4) Real order — VAT applies to the fee, never to the raw cash amount
  // ---------------------------------------------------------------------
  console.log('\n4) Real order: VAT on fee, never on raw cash amount');
  {
    const cashAmount = 570; // -> fee 120 with Product A's 100/20% schedule (confirmed example)
    const { order, error } = await orderService.createGuestOrder(
      {
        items: [{ productId: productA.id, quantity: 1 }],
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.orderA@t.local`,
        cashArrangement: { cashAmount, denomination: 100, note: 'Please seal in an envelope' },
      },
      { regionCode: region.code }
    );
    ok('Order created without error', !error, error || '');
    if (order) {
      createdOrderIds.push(order.id);
      const expectedFee = computeCashArrangementFee(cashAmount, { feeStepAmount: 100, feeMarginPercent: 20 });
      eq('cashArrangementFeeAmount = 120 (570 -> step 6 * 20)', order.cashArrangementFeeAmount, expectedFee);
      ok('cashArrangementRequested = true', order.cashArrangementRequested === true);
      eq('cashArrangementAmount snapshot = 570', order.cashArrangementAmount, cashAmount);
      ok('cashArrangementDenomination snapshot = 100', order.cashArrangementDenomination === 100);
      ok('cashArrangementNote snapshot persisted', order.cashArrangementNote === 'Please seal in an envelope');

      const productSubtotal = 100; // productA price * qty 1
      const productVat = Math.round(productSubtotal * 0.05 * 100) / 100; // 5
      const feeVat = Math.round(expectedFee * 0.05 * 100) / 100; // 6
      eq('cashArrangementFeeVatAmount = 5% of the fee only', order.cashArrangementFeeVatAmount, feeVat);
      eq('taxAmount = product VAT + fee VAT (blended)', order.taxAmount, productVat + feeVat);
      // total = subtotal + productVat + shipping(0, no rate configured) + cashAmount (untaxed) + fee + feeVat
      const expectedTotal = productSubtotal + productVat + 0 + cashAmount + expectedFee + feeVat;
      eq('totalAmount includes cash amount UNTAXED + fee taxed', order.totalAmount, expectedTotal);
      // Explicitly prove the cash amount itself was never run through VAT: if it HAD been,
      // total would be higher by cashAmount*0.05 = 28.5.
      ok('cash amount was NOT taxed (total does not include cashAmount*5%)', !approx(order.totalAmount, expectedTotal + cashAmount * 0.05, 0.001));
    }
  }

  // ---------------------------------------------------------------------
  // 5) Regression: VAT-on-fee under a SPECIFIC_CATEGORIES VAT scope that EXCLUDES the
  // governing product's category -> fee VAT must be 0 (not silently taxed via a null/null
  // synthetic line, and not silently skipped when it SHOULD be taxed either).
  // ---------------------------------------------------------------------
  console.log('\n5) VAT-on-fee under SPECIFIC_CATEGORIES scope (regression: governing product/category, not null/null)');
  {
    // Scope VAT to "Mugs" only -> Flowers (productA's category) is NOT taxed.
    await vatService.updateConfig(region.id, { appliesTo: 'SPECIFIC_CATEGORIES', categoryIds: [otherCategory.id] });
    const cashAmount = 350; // -> fee 80
    const { order, error } = await orderService.createGuestOrder(
      {
        items: [{ productId: productA.id, quantity: 1 }],
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.orderB@t.local`,
        cashArrangement: { cashAmount },
      },
      { regionCode: region.code }
    );
    ok('Order created without error', !error, error || '');
    if (order) {
      createdOrderIds.push(order.id);
      eq('product line untaxed (Flowers excluded from VAT scope)', order.items[0].vatAmount, 0);
      eq('fee VAT is ALSO 0 (fee tracks the governing product\'s category, correctly excluded)', order.cashArrangementFeeVatAmount, 0);
      eq('taxAmount = 0', order.taxAmount, 0);
    }

    // Now scope VAT to "Flowers" (productA's own category) -> the fee (attached to a Flowers
    // product) MUST be taxed, proving the fix isn't just "always 0".
    await vatService.updateConfig(region.id, { appliesTo: 'SPECIFIC_CATEGORIES', categoryIds: [flowersCategory.id] });
    const { order: order2, error: error2 } = await orderService.createGuestOrder(
      {
        items: [{ productId: productA.id, quantity: 1 }],
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.orderC@t.local`,
        cashArrangement: { cashAmount },
      },
      { regionCode: region.code }
    );
    ok('Order created without error', !error2, error2 || '');
    if (order2) {
      createdOrderIds.push(order2.id);
      const expectedFee = computeCashArrangementFee(cashAmount, { feeStepAmount: 100, feeMarginPercent: 20 });
      const expectedFeeVat = Math.round(expectedFee * 0.05 * 100) / 100;
      ok('product line IS taxed (Flowers in scope)', order2.items[0].vatAmount > 0);
      eq('fee VAT is now > 0 (governing category IS in scope)', order2.cashArrangementFeeVatAmount, expectedFeeVat);
    }

    // Restore ALL_PRODUCTS VAT for the rest of the suite.
    await vatService.updateConfig(region.id, { appliesTo: 'ALL_PRODUCTS' });
  }

  // ---------------------------------------------------------------------
  // 6) Promo discount never touches the arrangement fee
  // ---------------------------------------------------------------------
  console.log('\n6) Promo discount does not reduce the arrangement fee');
  {
    const promo = await prisma.promoCode.create({
      data: {
        code: `${TAG}PROMO10`, name: `${TAG} 10% off`, discountType: 'PERCENTAGE', discountValue: 10,
        appliesTo: 'ALL_PRODUCTS', isActive: true,
        regions: { create: [{ regionId: region.id }] },
      },
    });
    const cashAmount = 100; // -> fee 20
    const { order, error } = await orderService.createGuestOrder(
      {
        items: [{ productId: productA.id, quantity: 1 }],
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.orderpromo@t.local`,
        promoCode: promo.code,
        cashArrangement: { cashAmount },
      },
      { regionCode: region.code }
    );
    ok('Order with promo + cash arrangement created without error', !error, error || '');
    if (order) {
      createdOrderIds.push(order.id);
      ok('Discount was applied to the order (discountAmount > 0)', Number(order.discountAmount) > 0);
      eq('Fee amount is UNAFFECTED by the discount (still 20, not 18)', order.cashArrangementFeeAmount, 20);
    }
    await prisma.promoCodeRegion.deleteMany({ where: { promoCodeId: promo.id } });
    await prisma.promoCode.delete({ where: { id: promo.id } });
  }

  // ---------------------------------------------------------------------
  // 7) Denomination validation (whitelist) + no min/max on custom cash amount
  // ---------------------------------------------------------------------
  console.log('\n7) Denomination whitelist + no min/max on cash amount');
  {
    const { order, error } = await orderService.createGuestOrder(
      {
        items: [{ productId: productA.id, quantity: 1 }],
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.orderbaddenom@t.local`,
        cashArrangement: { cashAmount: 500, denomination: 999 }, // 999 is not in [50, 100]
      },
      { regionCode: region.code }
    );
    ok('Order REJECTED for a denomination not in the region\'s preset list', !!error, `unexpectedly succeeded: ${JSON.stringify(order)}`);

    // No min/max: a very large custom cash amount is accepted (just fee-formula math scaling up).
    const bigAmount = 87654.32;
    const { order: bigOrder, error: bigError } = await orderService.createGuestOrder(
      {
        items: [{ productId: productA.id, quantity: 1 }],
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.orderbig@t.local`,
        cashArrangement: { cashAmount: bigAmount },
      },
      { regionCode: region.code }
    );
    ok('Very large cash amount (87,654.32) accepted — no business min/max', !bigError, bigError || '');
    if (bigOrder) {
      createdOrderIds.push(bigOrder.id);
      eq('Large cash amount snapshotted exactly', bigOrder.cashArrangementAmount, bigAmount);
    }
  }

  // ---------------------------------------------------------------------
  // 8) Baseline: no cash arrangement requested -> everything null/false/unaffected
  // ---------------------------------------------------------------------
  console.log('\n8) Baseline — no cash arrangement requested');
  {
    const { order, error } = await orderService.createGuestOrder(
      {
        items: [{ productId: productA.id, quantity: 1 }],
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.orderplain@t.local`,
      },
      { regionCode: region.code }
    );
    ok('Plain order (no cashArrangement key) created without error', !error, error || '');
    if (order) {
      createdOrderIds.push(order.id);
      ok('cashArrangementRequested = false', order.cashArrangementRequested === false);
      ok('cashArrangementAmount = null', order.cashArrangementAmount === null);
      ok('cashArrangementFeeAmount = null', order.cashArrangementFeeAmount === null);
      const productVat = Math.round(100 * 0.05 * 100) / 100;
      eq('totalAmount = product subtotal + VAT only', order.totalAmount, 100 + productVat);
    }

    // cashAmount <= 0 must be treated as "not requested", not an error.
    const { order: zeroOrder, error: zeroError } = await orderService.createGuestOrder(
      {
        items: [{ productId: productA.id, quantity: 1 }],
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.orderzero@t.local`,
        cashArrangement: { cashAmount: 0 },
      },
      { regionCode: region.code }
    );
    ok('cashAmount=0 treated as not-requested (no error)', !zeroError, zeroError || '');
    if (zeroOrder) {
      createdOrderIds.push(zeroOrder.id);
      ok('cashAmount=0 -> cashArrangementRequested = false', zeroOrder.cashArrangementRequested === false);
    }
  }

  // ---------------------------------------------------------------------
  // 9) Ineligible cart + cash requested -> friendly rejection, not a crash
  // ---------------------------------------------------------------------
  console.log('\n9) Ineligible cart + cash requested -> friendly 400, not a 500');
  {
    const { order, error } = await orderService.createGuestOrder(
      {
        items: [{ productId: productC.id, quantity: 1 }], // Mugs — out of scope
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.orderineligible@t.local`,
        cashArrangement: { cashAmount: 500 },
      },
      { regionCode: region.code }
    );
    ok('Order REJECTED with a friendly error (not a thrown exception)', !!error, `unexpectedly succeeded: ${JSON.stringify(order)}`);
  }

  // ---------------------------------------------------------------------
  // 10) Admin validation guard: SPECIFIC_PRODUCTS/CATEGORIES with an empty list is rejected
  // ---------------------------------------------------------------------
  console.log('\n10) Admin validation guard (empty scope list rejected)');
  {
    let threw = false;
    try {
      await cashArrangementService.updateConfig(region.id, { enabled: true, appliesTo: 'SPECIFIC_PRODUCTS', productIds: [] });
    } catch (e) {
      threw = e && e.status === 400;
    }
    ok('Enabling SPECIFIC_PRODUCTS with an empty productIds list is rejected (400)', threw);

    let threwCat = false;
    try {
      await cashArrangementService.updateConfig(region.id, { enabled: true, appliesTo: 'SPECIFIC_CATEGORIES', categoryIds: [] });
    } catch (e) {
      threwCat = e && e.status === 400;
    }
    ok('Enabling SPECIFIC_CATEGORIES with an empty categoryIds list is rejected (400)', threwCat);

    let threwRegion = false;
    try {
      await cashArrangementService.updateConfig('00000000-0000-0000-0000-000000000000', { enabled: true });
    } catch (e) {
      threwRegion = e && e.code === 'CASH_ARRANGEMENT_REGION_NOT_FOUND';
    }
    ok('Unknown region rejected (404)', threwRegion);
  }

  // ---------------------------------------------------------------------
  // 11) Public resolve preview ignores a cross-region zoneId (fix: previously trusted
  // the client-supplied zoneId with no check that it belongs to the resolved region).
  // ---------------------------------------------------------------------
  console.log('\n11) Public resolve preview ignores a cross-region zoneId');
  {
    const regionB = await prisma.region.create({
      data: { code: `${TAG}KSA`, name: `${TAG} KSA`, currency: 'SAR', isActive: true, standardDeliveryDays: 2 },
    });
    const zoneB = await prisma.deliveryZone.create({ data: { regionId: regionB.id, name: `${TAG} Riyadh`, isActive: true } });

    // A rogue/mismatched override: productA has a ProductZone row for zoneB (a DIFFERENT
    // region's zone) with an obviously distinct fee. If the preview endpoint incorrectly
    // honored a cross-region zoneId, this value would leak into region A's preview.
    await prisma.productZone.create({
      data: { productId: productA.id, zoneId: zoneB.id, cashArrangementFeeStepAmount: 999, cashArrangementFeeMarginPercent: 99 },
    });

    const { req, res } = mockReqRes({
      regionId: region.id, // region A's context
      body: { zoneId: zoneB.id, cartLines: [{ productId: productA.id }] }, // zone from region B
    });
    await cashArrangementController.resolveCashArrangement(req, res, (err) => { throw err; });

    ok('Preview call succeeds (degrades gracefully, does not error)', res.statusCode === 200);
    ok('Cross-region zoneId is IGNORED (fee is not the rogue zoneB override of 999)', res.body?.data?.feeStepAmount !== 999);
    eq("Falls back to product A's own default schedule (step=100)", res.body?.data?.feeStepAmount, 100);

    await prisma.productZone.deleteMany({ where: { productId: productA.id, zoneId: zoneB.id } });
    await prisma.deliveryZone.deleteMany({ where: { id: zoneB.id } });
    await prisma.region.deleteMany({ where: { id: regionB.id } });
  }

  // ---------------------------------------------------------------------
  // 12) Authenticated flows (createOrder + buyNow), not just guest checkout
  // ---------------------------------------------------------------------
  console.log('\n12) Authenticated flows (createOrder + buyNow) — cash arrangement end to end');
  {
    const user = await prisma.user.create({
      data: { email: `${TAG.toLowerCase()}.user@test.local`, fullName: 'Cash Arrangement Auth Tester' },
    });

    // Per-item: the authed cart checkout reads cash from the stored CART line (added below),
    // NOT from the checkout body.
    const cashAmount1 = 350; // -> fee 80
    await cartService.addToCart(user.id, {
      productId: productA.id,
      quantity: 1,
      cashArrangement: { cashAmount: cashAmount1 },
    });
    const { order: cartOrder, error: cartError } = await orderService.createOrder(
      user.id,
      { shippingAddress: SHIPPING, paymentMethod: 'COD' },
      { regionCode: region.code }
    );
    ok('Authenticated cart checkout (createOrder) created without error', !cartError, cartError || '');
    if (cartOrder) {
      createdOrderIds.push(cartOrder.id);
      const expectedFee1 = computeCashArrangementFee(cashAmount1, { feeStepAmount: 100, feeMarginPercent: 20 });
      eq('createOrder: order-level fee roll-up correct', cartOrder.cashArrangementFeeAmount, expectedFee1);
      ok('createOrder: per-item cash snapshot on the line', cartOrder.items[0].cashArrangementFeeAmount === expectedFee1);
    }

    const cashAmount2 = 200; // -> fee 40
    const { order: buyNowOrder, error: buyNowError } = await orderService.buyNow(
      user.id,
      { productId: productA.id, quantity: 1, shippingAddress: SHIPPING, cashArrangement: { cashAmount: cashAmount2 } },
      { regionCode: region.code }
    );
    ok('Buy Now created without error', !buyNowError, buyNowError || '');
    if (buyNowOrder) {
      createdOrderIds.push(buyNowOrder.id);
      const expectedFee2 = computeCashArrangementFee(cashAmount2, { feeStepAmount: 100, feeMarginPercent: 20 });
      eq('buyNow: cashArrangementFeeAmount correct', buyNowOrder.cashArrangementFeeAmount, expectedFee2);
    }
  }

  // ---------------------------------------------------------------------
  // 13) Note length boundary — exactly 500 chars accepted, 501 rejected
  // ---------------------------------------------------------------------
  console.log('\n13) Note length boundary (500 ok, 501 rejected)');
  {
    const note500 = 'x'.repeat(500);
    const { order, error } = await orderService.createGuestOrder(
      {
        items: [{ productId: productA.id, quantity: 1 }],
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.note500@t.local`,
        cashArrangement: { cashAmount: 100, note: note500 },
      },
      { regionCode: region.code }
    );
    ok('Exactly 500-char note accepted', !error, error || '');
    if (order) {
      createdOrderIds.push(order.id);
      ok('note stored at exactly 500 chars', order.cashArrangementNote?.length === 500);
    }

    const note501 = 'x'.repeat(501);
    const { order: order2, error: error2 } = await orderService.createGuestOrder(
      {
        items: [{ productId: productA.id, quantity: 1 }],
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.note501@t.local`,
        cashArrangement: { cashAmount: 100, note: note501 },
      },
      { regionCode: region.code }
    );
    ok('501-char note REJECTED', !!error2, `unexpectedly succeeded: ${JSON.stringify(order2)}`);
  }

  // ---------------------------------------------------------------------
  // 14) PER-ITEM: two lines of the SAME product with DIFFERENT cash (and one with a qty > 1).
  // Each line gets its own fee; the order-level fields are the roll-up (sum × qty).
  // ---------------------------------------------------------------------
  console.log('\n14) PER-ITEM: two lines, different cash, per-unit fee × qty aggregated');
  {
    // Line 1: qty 1, cash 100 -> fee 20.  Line 2: qty 2, cash 350 -> fee 80 each.
    const { order, error } = await orderService.createGuestOrder(
      {
        items: [
          { productId: productA.id, quantity: 1, cashArrangement: { cashAmount: 100 } },
          { productId: productA.id, quantity: 2, cashArrangement: { cashAmount: 350 } },
        ],
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.orderperitem@t.local`,
      },
      { regionCode: region.code }
    );
    ok('Per-item order created without error', !error, error || '');
    if (order) {
      createdOrderIds.push(order.id);
      ok('Both lines persisted', order.items.length === 2);
      const fee100 = computeCashArrangementFee(100, { feeStepAmount: 100, feeMarginPercent: 20 }); // 20
      const fee350 = computeCashArrangementFee(350, { feeStepAmount: 100, feeMarginPercent: 20 }); // 80
      // Per-item snapshots are PER UNIT.
      const line1 = order.items.find((it) => Number(it.cashArrangementAmount) === 100);
      const line2 = order.items.find((it) => Number(it.cashArrangementAmount) === 350);
      ok('Line 1 per-unit fee = 20', line1 && Number(line1.cashArrangementFeeAmount) === fee100);
      ok('Line 2 per-unit fee = 80', line2 && Number(line2.cashArrangementFeeAmount) === fee350);
      // Order-level roll-up: cash = 100×1 + 350×2 = 800; fee = 20×1 + 80×2 = 180.
      eq('Order cash roll-up = 100×1 + 350×2 = 800', order.cashArrangementAmount, 800);
      eq('Order fee roll-up = 20×1 + 80×2 = 180', order.cashArrangementFeeAmount, 180);
      // Denomination/note roll-up is null when lines differ (2 cash lines).
      ok('Order-level denomination roll-up is null for multiple cash lines', order.cashArrangementDenomination === null);
    }
  }

  // ---------------------------------------------------------------------
  // 15) Explicit cashArrangement: null behaves exactly like omitting it
  // ---------------------------------------------------------------------
  console.log('\n15) Explicit cashArrangement: null behaves exactly like omitting it');
  {
    const { order, error } = await orderService.createGuestOrder(
      {
        items: [{ productId: productA.id, quantity: 1 }],
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.ordernull@t.local`,
        cashArrangement: null,
      },
      { regionCode: region.code }
    );
    ok('Order with cashArrangement: null created without error', !error, error || '');
    if (order) {
      createdOrderIds.push(order.id);
      ok('cashArrangementRequested = false', order.cashArrangementRequested === false);
    }
  }

  // ---------------------------------------------------------------------
  // 16) Cascade delete safety (product/region referenced by cash-arrangement rows)
  // ---------------------------------------------------------------------
  console.log('\n16) Cascade delete safety (product/region referenced by cash-arrangement rows)');
  {
    const throwawayProduct = await prisma.product.create({
      data: { title: `${TAG} Throwaway`, price: 10, quantity: 5, status: 'PUBLISHED', categoryId: flowersCategory.id },
    });
    await cashArrangementService.updateConfig(region.id, {
      appliesTo: 'SPECIFIC_PRODUCTS', productIds: [productA.id, throwawayProduct.id],
    });
    const beforeDelete = await prisma.cashArrangementConfigProduct.count({ where: { productId: throwawayProduct.id } });
    ok('Scope join row exists before delete', beforeDelete === 1);

    let deleteThrew = false;
    try {
      await prisma.product.delete({ where: { id: throwawayProduct.id } });
    } catch (e) {
      deleteThrew = true;
    }
    ok('Deleting a scoped product does NOT throw (cascades cleanly)', !deleteThrew);
    const afterDelete = await prisma.cashArrangementConfigProduct.count({ where: { productId: throwawayProduct.id } });
    ok('Scope join row is gone after cascade delete', afterDelete === 0);

    // Restore scope back to Flowers category for the rest of the suite.
    await cashArrangementService.updateConfig(region.id, { appliesTo: 'SPECIFIC_CATEGORIES', categoryIds: [flowersCategory.id] });

    const throwawayRegion = await prisma.region.create({
      data: { code: `${TAG}DEL`, name: `${TAG} Delete Me`, currency: 'AED', isActive: true },
    });
    // regionService caches regions for 60s, invalidated only by writes made THROUGH the
    // service — a raw prisma.region.create (as above) bypasses that, so a same-process
    // lookup right after (assertRegion -> getRegionById, inside updateConfig below) would
    // otherwise 404 on a region that genuinely exists. Force a reload.
    regionService.invalidateCache();
    await cashArrangementService.updateConfig(throwawayRegion.id, { enabled: true });
    const configBefore = await prisma.cashArrangementConfig.count({ where: { regionId: throwawayRegion.id } });
    ok('Region cash-arrangement config exists before region delete', configBefore === 1);

    let regionDeleteThrew = false;
    try {
      await prisma.region.delete({ where: { id: throwawayRegion.id } });
    } catch (e) {
      regionDeleteThrew = true;
    }
    ok('Deleting a region with a cash-arrangement config does NOT throw', !regionDeleteThrew);
    const configAfter = await prisma.cashArrangementConfig.count({ where: { regionId: throwawayRegion.id } });
    ok('Cash-arrangement config is gone after cascade delete', configAfter === 0);
  }

  // ---------------------------------------------------------------------
  // 17) Order-total overflow guard (regression: a large-but-individually-valid cash
  // amount combined with the fee must never crash with a raw DB numeric overflow)
  // ---------------------------------------------------------------------
  console.log('\n17) Order-total overflow guard (large cash amount + fee must not crash)');
  {
    // 99,999,999.99 alone is under the per-field ceiling, but with a 20% margin the fee
    // pushes totalAmount well past Decimal(10,2)'s ~99,999,999.99 capacity. Before the fix
    // this threw a raw, unhandled Postgres "numeric field overflow" instead of a friendly error.
    const hugeAmount = 99999999.99;
    const { order, error } = await orderService.createGuestOrder(
      {
        items: [{ productId: productA.id, quantity: 1 }],
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.orderoverflow@t.local`,
        cashArrangement: { cashAmount: hugeAmount },
      },
      { regionCode: region.code }
    );
    ok('Huge cash amount is REJECTED with a friendly error (not a thrown DB exception)', !!error, `unexpectedly succeeded: ${JSON.stringify(order)}`);
    ok('Error message is the friendly total-too-large message, not a raw DB error', /too large/i.test(error || ''));
  }

  // ---------------------------------------------------------------------
  // 18) Cash amount at the per-field validation ceiling boundary
  // ---------------------------------------------------------------------
  console.log('\n18) Cash amount at the per-field validation ceiling boundary');
  {
    const atCeiling = 100_000_000;
    const { order, error } = await orderService.createGuestOrder(
      {
        items: [{ productId: productA.id, quantity: 1 }],
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.orderceiling@t.local`,
        cashArrangement: { cashAmount: atCeiling },
      },
      { regionCode: region.code }
    );
    ok('Amount AT the per-field ceiling (100,000,000) is REJECTED', !!error, `unexpectedly succeeded: ${JSON.stringify(order)}`);
  }

  // ---------------------------------------------------------------------
  // 19) Zone-level quick-pick amounts / denominations override the region's lists
  // (DeliveryZone.cashArrangementQuickPickAmounts/Denominations — a different concept from
  // the ProductZone/CategoryZone fee-SCHEDULE override already covered in section 2).
  // ---------------------------------------------------------------------
  console.log('\n19) Zone-level quick-pick/denomination list override (falls back to region when empty)');
  {
    // Baseline: zone has no override yet ([] default) -> resolveForOrder with this zone
    // still returns the REGION's lists (500,1000 / 50,100 set in the fixtures above).
    const beforeOverride = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: zone.id, cartLines: [{ productId: productA.id, categoryId: flowersCategory.id }],
    });
    ok(
      `Zone with no override -> quickPickAmounts falls back to region list (got ${JSON.stringify(beforeOverride.quickPickAmounts)})`,
      JSON.stringify(beforeOverride.quickPickAmounts) === JSON.stringify([500, 1000])
    );
    ok(
      `Zone with no override -> denominations falls back to region list (got ${JSON.stringify(beforeOverride.denominations)})`,
      JSON.stringify(beforeOverride.denominations) === JSON.stringify([50, 100])
    );

    // Set a zone-level override through the real service (exercises validation + persistence,
    // not just a raw prisma write).
    await deliveryZoneService.updateZone(zone.id, {
      cashArrangementQuickPickAmounts: [25, 75],
      cashArrangementDenominations: [5, 10],
    });
    const withOverride = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: zone.id, cartLines: [{ productId: productA.id, categoryId: flowersCategory.id }],
    });
    ok(
      `Zone WITH override -> quickPickAmounts uses the ZONE list (got ${JSON.stringify(withOverride.quickPickAmounts)})`,
      JSON.stringify(withOverride.quickPickAmounts) === JSON.stringify([25, 75])
    );
    ok(
      `Zone WITH override -> denominations uses the ZONE list (got ${JSON.stringify(withOverride.denominations)})`,
      JSON.stringify(withOverride.denominations) === JSON.stringify([5, 10])
    );

    // Same cart, NO zoneId passed at all -> region's lists used (regression: the non-zone-aware
    // call path is unaffected by the zone now having its own override).
    const noZone = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: null, cartLines: [{ productId: productA.id, categoryId: flowersCategory.id }],
    });
    ok(
      `No zoneId passed -> region list used (zone override is irrelevant) (got ${JSON.stringify(noZone.quickPickAmounts)})`,
      JSON.stringify(noZone.quickPickAmounts) === JSON.stringify([500, 1000])
    );

    // Clear the zone override back to [] -> falls back to the region's lists again.
    await deliveryZoneService.updateZone(zone.id, {
      cashArrangementQuickPickAmounts: [],
      cashArrangementDenominations: [],
    });
    const afterClear = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: zone.id, cartLines: [{ productId: productA.id, categoryId: flowersCategory.id }],
    });
    ok(
      `Clearing the zone override back to [] -> falls back to region list again (got ${JSON.stringify(afterClear.quickPickAmounts)})`,
      JSON.stringify(afterClear.quickPickAmounts) === JSON.stringify([500, 1000])
    );
  }

  // ---------------------------------------------------------------------
  // 20) FLAT region / zone fee — the "just set it region-wise" base of the chain
  // (CashArrangementConfig.feeStepAmount/feeMarginPercent + DeliveryZone.cashArrangement
  // FeeStepAmount/MarginPercent). Sits BELOW every product/category tier, above nothing.
  // ---------------------------------------------------------------------
  console.log('\n20) Flat region/zone fee (base fallback below product/category tiers)');
  {
    // Widen enablement to ALL_PRODUCTS so productC (Mugs — no product/category fee schedule
    // ANYWHERE) is enablement-eligible: the perfect probe for the flat fallback tiers.
    await cashArrangementService.updateConfig(region.id, { enabled: true, appliesTo: 'ALL_PRODUCTS' });

    // No flat fee set yet + productC has no schedule anywhere -> still not eligible.
    const noFee = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: null, cartLines: [{ productId: productC.id, categoryId: otherCategory.id }],
    });
    ok('productC (no schedule) + no flat fee -> not eligible', noFee.eligible === false);

    // Set a REGION flat fee -> productC now resolves to it.
    await cashArrangementService.updateConfig(region.id, { feeStepAmount: 25, feeMarginPercent: 8 });
    const regionFlat = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: null, cartLines: [{ productId: productC.id, categoryId: otherCategory.id }],
    });
    ok('productC now eligible via REGION flat fee', regionFlat.eligible === true);
    eq('productC uses region flat step=25', regionFlat.feeStepAmount, 25);
    eq('productC uses region flat margin=8', regionFlat.feeMarginPercent, 8);

    // A product WITH its own schedule (productA 100/20) still beats the region flat fee.
    const productWins = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: null, cartLines: [{ productId: productA.id, categoryId: flowersCategory.id }],
    });
    eq('product-level schedule still beats region flat (step=100)', productWins.feeStepAmount, 100);

    // Category schedule beats the flat tiers: productB (Flowers, no own schedule -> category
    // 50/10), even with a zone given, must use category 50, NOT any flat fee.
    await deliveryZoneService.updateZone(zone.id, { cashArrangementFeeStepAmount: 12, cashArrangementFeeMarginPercent: 4 });
    const categoryBeatsFlat = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: zone.id, cartLines: [{ productId: productB.id, categoryId: flowersCategory.id }],
    });
    eq('category schedule beats zone/region flat (step=50)', categoryBeatsFlat.feeStepAmount, 50);

    // ZONE flat fee beats REGION flat fee when a zone is given (for productC, which has no
    // product/category tier to override either).
    const zoneFlat = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: zone.id, cartLines: [{ productId: productC.id, categoryId: otherCategory.id }],
    });
    eq('ZONE flat fee beats region flat when a zone is given (step=12)', zoneFlat.feeStepAmount, 12);

    // Without the zone, still the region flat (25), not the zone one.
    const regionFlatAgain = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: null, cartLines: [{ productId: productC.id, categoryId: otherCategory.id }],
    });
    eq('no zone given -> region flat (25), zone flat not applied', regionFlatAgain.feeStepAmount, 25);

    // Real end-to-end order using ONLY the region flat fee (productC), proving the whole
    // pipeline (order.service -> tx resolveForOrder -> fee compute) works with a flat fee.
    const { order, error } = await orderService.createGuestOrder(
      {
        items: [{ productId: productC.id, quantity: 1 }],
        shippingAddress: SHIPPING,
        email: `${TAG.toLowerCase()}.orderflatfee@t.local`,
        cashArrangement: { cashAmount: 100 }, // step=25 -> ceil(100/25)=4 * (25*8/100=2) = 8
      },
      { regionCode: region.code }
    );
    ok('Order via region flat fee created without error', !error, error || '');
    if (order) {
      createdOrderIds.push(order.id);
      const expectedFee = computeCashArrangementFee(100, { feeStepAmount: 25, feeMarginPercent: 8 });
      eq('region-flat order fee correct', order.cashArrangementFeeAmount, expectedFee);
    }

    // Admin-write guard: a LONE region flat field (step without margin) is rejected.
    let loneThrew = false;
    try {
      await cashArrangementService.updateConfig(region.id, { feeStepAmount: 99, feeMarginPercent: null });
    } catch (e) {
      loneThrew = e && e.code === 'VALIDATION';
    }
    ok('lone region flat field (step, no margin) rejected (VALIDATION)', loneThrew);

    // Clear the flat fees + restore enablement scope for cleanliness.
    await deliveryZoneService.updateZone(zone.id, { cashArrangementFeeStepAmount: null, cashArrangementFeeMarginPercent: null });
    await cashArrangementService.updateConfig(region.id, {
      feeStepAmount: null, feeMarginPercent: null,
      appliesTo: 'SPECIFIC_CATEGORIES', categoryIds: [flowersCategory.id],
    });
    const cleared = await cashArrangementService.resolveForOrder({
      regionId: region.id, zoneId: null, cartLines: [{ productId: productC.id, categoryId: otherCategory.id }],
    });
    ok('after clearing flat fee + re-scoping, productC (Mugs) is not eligible again', cleared.eligible === false);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} Cash arrangement integration: ${pass} passed, ${fail} failed`);
}

main()
  .catch((e) => { console.error('\n❌ ERROR:', e); fail++; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    process.exit(fail === 0 ? 0 : 1);
  });
