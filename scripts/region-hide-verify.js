/**
 * Verification harness for admin-hideable regions: region.service.updateRegion's
 * deactivation guardrails (last-active protection, default reassignment, user
 * migration) and order.service's region-resolution fallback (stale/inactive
 * User.regionId must never get stamped onto a new order).
 *
 * The "last active region" check is GLOBAL (system-wide), not scoped to this
 * script's own fixtures — so it can only be exercised correctly on a database
 * that has no other active regions to fall back on.
 *
 * LOCAL throwaway DB only (never the shared dev DB — it already has real UAE/SA
 * regions, which this test would otherwise silently ride on and mask bugs):
 *   1. Create an empty database and a placeholder order-number sequence:
 *        CREATE DATABASE amoon_region_test;
 *        CREATE SEQUENCE order_number_seq START 1001;  (run against that DB)
 *   2. Push the schema onto it:
 *        npx prisma db push --accept-data-loss --url "postgresql://postgres:postgres@localhost:5432/amoon_region_test"
 *   3. Run:
 *        DATABASE_URL="postgresql://postgres:postgres@localhost:5432/amoon_region_test" node scripts/region-hide-verify.js
 */
const prisma = require('../src/config/db');
const regionService = require('../src/services/region.service');
const orderService = require('../src/services/order.service');

const TAG = 'ZZREGIONTEST';
let failures = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

async function cleanup() {
  await prisma.orderItem.deleteMany({ where: { order: { user: { email: { contains: TAG } } } } });
  await prisma.order.deleteMany({ where: { user: { email: { contains: TAG } } } });
  await prisma.address.deleteMany({ where: { user: { email: { contains: TAG } } } });
  await prisma.user.deleteMany({ where: { email: { contains: TAG } } });
  await prisma.product.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.category.deleteMany({ where: { title: { contains: TAG } } });
  // deleteRegion (and raw deleteMany here) blocks/ignores the default flag — clear it first.
  await prisma.region.updateMany({ where: { code: { startsWith: TAG } }, data: { isDefault: false } });
  await prisma.region.deleteMany({ where: { code: { startsWith: TAG } } });
  regionService.invalidateCache();
}

async function main() {
  await cleanup();

  const rh1 = await prisma.region.create({
    data: { code: `${TAG}1`, name: 'RH Test One', isActive: true, isDefault: true, sortOrder: 900, currency: 'AED' },
  });
  const rh2 = await prisma.region.create({
    data: { code: `${TAG}2`, name: 'RH Test Two', isActive: true, isDefault: false, sortOrder: 901, currency: 'SAR' },
  });
  regionService.invalidateCache();

  console.log('1) Hiding a non-default region');
  const userA = await prisma.user.create({ data: { email: `${TAG}_a@test.local`, regionId: rh2.id } });
  let updated = await regionService.updateRegion(rh2.id, { isActive: false });
  ok('deactivation succeeds', updated?.isActive === false);
  let rh1Check = await prisma.region.findUnique({ where: { id: rh1.id } });
  ok('default region untouched', rh1Check.isDefault === true && rh1Check.isActive === true);
  let userAAfter = await prisma.user.findUnique({ where: { id: userA.id } });
  ok('user on hidden region migrated to default', userAAfter.regionId === rh1.id, `got ${userAAfter.regionId}`);
  await regionService.updateRegion(rh2.id, { isActive: true }); // reset

  console.log('\n2) Cannot hide the only active region');
  await regionService.updateRegion(rh2.id, { isActive: false });
  let threw = null;
  try {
    await regionService.updateRegion(rh1.id, { isActive: false });
  } catch (err) {
    threw = err;
  }
  ok('rejected with LAST_ACTIVE_REGION', threw?.code === 'LAST_ACTIVE_REGION', threw?.message || 'did not throw');
  rh1Check = await prisma.region.findUnique({ where: { id: rh1.id } });
  ok('region left unchanged after rejection', rh1Check.isActive === true);
  await regionService.updateRegion(rh2.id, { isActive: true }); // reset

  console.log('\n3) Cannot promote a not-yet-default region to default while hiding it');
  threw = null;
  try {
    await regionService.updateRegion(rh2.id, { isDefault: true, isActive: false });
  } catch (err) {
    threw = err;
  }
  ok('rejected with VALIDATION', threw?.code === 'VALIDATION', threw?.message || 'did not throw');
  let rh2Check = await prisma.region.findUnique({ where: { id: rh2.id } });
  ok('region left unchanged after rejection', rh2Check.isActive === true && rh2Check.isDefault === false);

  console.log('\n4) Hiding the default region auto-promotes a replacement + migrates users');
  const userB = await prisma.user.create({ data: { email: `${TAG}_b@test.local`, regionId: rh1.id } });
  // isDefault: true resubmitted unchanged (mirrors the admin form always sending both
  // checkboxes) must NOT be treated as a contradiction — it should auto-resolve.
  updated = await regionService.updateRegion(rh1.id, { isActive: false, isDefault: true });
  ok('deactivation succeeds (not rejected)', updated?.isActive === false, updated ? '' : String(updated));
  let rh2After = await prisma.region.findUnique({ where: { id: rh2.id } });
  ok('remaining active region promoted to default', rh2After.isDefault === true && rh2After.isActive === true);
  let rh1After = await prisma.region.findUnique({ where: { id: rh1.id } });
  ok('old default region isDefault cleared', rh1After.isDefault === false);
  let userBAfter = await prisma.user.findUnique({ where: { id: userB.id } });
  ok('user on old default migrated to new default', userBAfter.regionId === rh2.id, `got ${userBAfter.regionId}`);

  console.log('\n5) Reactivation is a clean no-op (no default reclaim, no user reversal)');
  updated = await regionService.updateRegion(rh1.id, { isActive: true });
  ok('reactivation succeeds', updated?.isActive === true);
  ok('does not reclaim default', updated?.isDefault === false);
  let userBAfterReactivate = await prisma.user.findUnique({ where: { id: userB.id } });
  ok('previously migrated user stays put', userBAfterReactivate.regionId === rh2.id);

  console.log('\n6) order creation never stamps a stale/inactive User.regionId');
  // State: rh1 active+non-default, rh2 active+default. Hide rh1 (non-default this time).
  await regionService.updateRegion(rh1.id, { isActive: false });
  const cat = await prisma.category.create({ data: { title: `${TAG} Cat`, status: 'PUBLISHED' } });
  const product = await prisma.product.create({
    data: { title: `${TAG} Product`, price: 100, quantity: 10, status: 'PUBLISHED', categoryId: cat.id },
  });
  // Deliberately stale: assigned directly to the now-inactive rh1 after the fact —
  // functionally identical to a user whose home region was hidden out from under them.
  const userC = await prisma.user.create({ data: { email: `${TAG}_c@test.local`, regionId: rh1.id } });

  const { order, error } = await orderService.buyNow(
    userC.id,
    {
      productId: product.id,
      quantity: 1,
      shippingAddress: { area: 'Al Barsha' },
      paymentMethod: 'COD',
    },
    {} // no X-Region header — exercises the stale-fallback path being hardened
  );
  ok('order created despite stale inactive User.regionId', !!order, error || '');
  if (order) {
    ok('order NOT stamped with the inactive region', order.regionId !== rh1.id, `got ${order.regionId}`);
    ok('order falls through to the active default region', order.regionId === rh2.id, `got ${order.regionId}, expected ${rh2.id}`);
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} Region-hide verification: ${failures === 0 ? 'all checks passed' : failures + ' check(s) failed'}`);
  await cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
