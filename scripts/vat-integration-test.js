/**
 * VAT integration test — runs against the ACTIVE DATABASE_URL (must be a local/throwaway DB,
 * never production). Exercises the real per-region config CRUD + a real guest order through
 * order.service so the stored Order/OrderItem VAT columns and totals are verified end-to-end.
 *
 * VAT is configured PER REGION. Guest orders with no explicit region land on the store's
 * DEFAULT region (see order.service#createOrderCore), so this test configures VAT on that
 * region and also proves per-region isolation: a rate set on a DIFFERENT region must not
 * affect an order placed in the default region.
 *
 * It creates temporary orders and RESTORES all state (VAT configs + product stock) on exit.
 * Run: `node scripts/vat-integration-test.js`
 */
require('dotenv').config();
const prisma = require('../src/config/db');
const vatService = require('../src/services/vat.service');
const regionService = require('../src/services/region.service');
const orderService = require('../src/services/order.service');

let pass = 0;
let fail = 0;
const approx = (a, b, e = 0.01) => Math.abs(Number(a) - Number(b)) <= e;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function eq(name, a, b) { ok(`${name} (=${b}, got ${a})`, approx(a, b)); }

const SHIPPING = {
  fullName: 'VAT Tester', phone: '+971500000000',
  streetAddress: '1 Test St', city: 'Dubai', country: 'AE',
};

const createdOrderIds = [];
let savedConfig = null;
let savedOtherRegionConfig = null;
let regionId = null;
let otherRegionId = null;
let product = null;
let otherProduct = null;
let originalQty = null;

async function placeGuestOrder(quantity) {
  const { order, error } = await orderService.createGuestOrder(
    { items: [{ productId: product.id, quantity }], shippingAddress: SHIPPING, email: 'vat.tester@example.com' },
    {}
  );
  if (error) throw new Error(`Order failed: ${error}`);
  createdOrderIds.push(order.id);
  return order;
}

async function main() {
  const candidates = await prisma.product.findMany({
    where: { status: 'PUBLISHED', quantity: { gte: 20 }, price: { gt: 0 } },
    select: { id: true, price: true, quantity: true, categoryId: true },
    orderBy: { createdAt: 'desc' },
    take: 2,
  });
  if (candidates.length < 1) throw new Error('No suitable PUBLISHED product found in this DB');
  product = candidates[0];
  otherProduct = candidates[1] || candidates[0];
  const unit = Number(product.price);
  originalQty = product.quantity;

  // Guest orders with no explicit X-Region land on the DEFAULT region — configure VAT there
  // so the order and the config are guaranteed to line up regardless of DB seed data.
  const defaultRegion = await regionService.getDefaultRegion();
  if (!defaultRegion) throw new Error('No default region configured in this DB');
  regionId = defaultRegion.id;
  const allRegions = await regionService.listRegions({ includeInactive: true });
  const other = allRegions.find((r) => r.id !== regionId);
  otherRegionId = other ? other.id : null;

  console.log(`Using product ${product.id} @ ${unit} (cat ${product.categoryId})`);
  console.log(`Default region: ${defaultRegion.code} (${regionId})${otherRegionId ? ` · other region for isolation test: ${otherRegionId}` : ''}\n`);

  // Snapshot the current VAT config(s) so we can restore them verbatim afterwards.
  savedConfig = await vatService.getConfig(regionId);
  if (otherRegionId) savedOtherRegionConfig = await vatService.getConfig(otherRegionId);

  // --- 1) CRUD round-trip ---------------------------------------------------
  console.log('1) Config CRUD (per region)');
  {
    const updated = await vatService.updateConfig(regionId, {
      enabled: true, ratePercent: 5, inclusive: false, appliesTo: 'ALL_PRODUCTS',
    });
    ok('regionId echoed', updated.regionId === regionId);
    ok('enabled persisted', updated.enabled === true);
    eq('ratePercent persisted', updated.ratePercent, 5);
    ok('inclusive persisted', updated.inclusive === false);
    ok('appliesTo persisted', updated.appliesTo === 'ALL_PRODUCTS');
    const resolved = await vatService.resolveConfigForOrder(regionId);
    ok('resolveConfigForOrder returns active config for this region', resolved && resolved.enabled === true);
  }

  // --- 2) Exclusive ALL 5% on a real order ---------------------------------
  console.log('\n2) Exclusive ALL 5% — order');
  {
    const qty = 2;
    const order = await placeGuestOrder(qty);
    const subtotal = unit * qty;
    const expectedVat = Math.round(subtotal * 0.05 * 100) / 100;
    eq('subtotalAmount', order.subtotalAmount, subtotal);
    eq('taxAmount', order.taxAmount, expectedVat);
    eq('vatAmount alias', order.vatAmount, expectedVat);
    eq('totalAmount = subtotal + vat', order.totalAmount, subtotal + expectedVat);
    eq('vatRatePercent', order.vatRatePercent, 5);
    ok('vatInclusive=false', order.vatInclusive === false);
    eq('line vatAmount', order.items[0].vatAmount, expectedVat);
    eq('line vatRatePercent', order.items[0].vatRatePercent, 5);
  }

  // --- 3) Inclusive ALL 5% — total unchanged, VAT extracted ----------------
  console.log('\n3) Inclusive ALL 5% — order');
  {
    await vatService.updateConfig(regionId, { inclusive: true });
    const qty = 2;
    const order = await placeGuestOrder(qty);
    const subtotal = unit * qty;
    const expectedVat = Math.round((subtotal - subtotal / 1.05) * 100) / 100;
    eq('totalAmount unchanged', order.totalAmount, subtotal);
    eq('taxAmount extracted', order.taxAmount, expectedVat);
    ok('vatInclusive=true', order.vatInclusive === true);
  }

  // --- 4) SPECIFIC_PRODUCTS excluding our product → untaxed ----------------
  console.log('\n4) SPECIFIC_PRODUCTS (excludes our product) — untaxed');
  {
    // Scope VAT to a DIFFERENT real product so our ordered product falls outside it.
    await vatService.updateConfig(regionId, {
      inclusive: false, appliesTo: 'SPECIFIC_PRODUCTS', productIds: [otherProduct.id],
    });
    const qty = 1;
    const order = await placeGuestOrder(qty);
    eq('taxAmount 0', order.taxAmount, 0);
    eq('totalAmount = subtotal', order.totalAmount, unit * qty);
    ok('line untaxed', approx(order.items[0].vatAmount, 0));
  }

  // --- 5) SPECIFIC_PRODUCTS including our product → taxed -------------------
  console.log('\n5) SPECIFIC_PRODUCTS (includes our product) — taxed');
  {
    await vatService.updateConfig(regionId, {
      appliesTo: 'SPECIFIC_PRODUCTS', productIds: [product.id], inclusive: false,
    });
    const qty = 1;
    const order = await placeGuestOrder(qty);
    const expectedVat = Math.round(unit * qty * 0.05 * 100) / 100;
    eq('taxAmount', order.taxAmount, expectedVat);
    eq('totalAmount', order.totalAmount, unit * qty + expectedVat);
  }

  // --- 6) Validation: enabling SPECIFIC_CATEGORIES with empty set is rejected
  console.log('\n6) Validation guard');
  {
    let threw = false;
    try {
      await vatService.updateConfig(regionId, { enabled: true, appliesTo: 'SPECIFIC_CATEGORIES', categoryIds: [] });
    } catch (e) {
      threw = e && e.status === 400;
    }
    ok('empty SPECIFIC_CATEGORIES rejected (400)', threw);

    let threwRate = false;
    try { await vatService.updateConfig(regionId, { ratePercent: 150 }); }
    catch (e) { threwRate = e && e.status === 400; }
    ok('rate > 100 rejected (400)', threwRate);

    let threwRegion = false;
    try { await vatService.updateConfig('00000000-0000-0000-0000-000000000000', { ratePercent: 5 }); }
    catch (e) { threwRegion = e && e.code === 'VAT_REGION_NOT_FOUND'; }
    ok('unknown region rejected (404)', threwRegion);
  }

  // --- 7) Per-region isolation: a rate on the OTHER region must not leak in -
  console.log('\n7) Per-region isolation');
  if (otherRegionId) {
    // Reset our order's region to ALL_PRODUCTS 5% exclusive (known-good state), then set the
    // OTHER region to a very different, easy-to-spot rate. An order placed in our (default)
    // region must still be taxed at OUR rate, not the other region's.
    await vatService.updateConfig(regionId, {
      enabled: true, ratePercent: 5, inclusive: false, appliesTo: 'ALL_PRODUCTS',
    });
    await vatService.updateConfig(otherRegionId, {
      enabled: true, ratePercent: 15, inclusive: false, appliesTo: 'ALL_PRODUCTS',
    });
    const qty = 1;
    const order = await placeGuestOrder(qty);
    const expectedVat = Math.round(unit * qty * 0.05 * 100) / 100;
    eq('order taxed at THIS region\'s 5%, not the other region\'s 15%', order.taxAmount, expectedVat);
    eq('vatRatePercent is 5', order.vatRatePercent, 5);

    const otherResolved = await vatService.resolveConfigForOrder(otherRegionId);
    ok('other region resolves its own 15% independently', otherResolved && otherResolved.ratePercent === 15);
  } else {
    console.log('  (skipped — only one region exists in this DB)');
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} VAT integration: ${pass} passed, ${fail} failed`);
}

async function restore(rId, saved) {
  if (!rId || !saved) return;
  await vatService.updateConfig(rId, {
    enabled: saved.enabled,
    ratePercent: saved.ratePercent,
    inclusive: saved.inclusive,
    appliesTo: saved.appliesTo,
    productIds: saved.productIds,
    categoryIds: saved.categoryIds,
  });
}

async function cleanup() {
  try {
    if (createdOrderIds.length) {
      await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    // Restore product stock (order placement reserved it).
    if (product && originalQty != null) {
      await prisma.product.update({ where: { id: product.id }, data: { quantity: originalQty } });
    }
    // Restore VAT config(s) to their pre-test state.
    await restore(regionId, savedConfig);
    await restore(otherRegionId, savedOtherRegionConfig);
    console.log('\n(cleanup done — orders removed, stock + VAT configs restored)');
  } catch (e) {
    console.error('cleanup error:', e.message);
  }
}

main()
  .catch((e) => { console.error('\n❌ ERROR:', e.message); fail++; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    process.exit(fail === 0 ? 0 : 1);
  });
