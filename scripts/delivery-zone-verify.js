/**
 * Verification harness for delivery zones + per-region shipping fee + the
 * checkout Area/Emirate fields: deliveryZone.service CRUD, assertValidZone's
 * region-scoping guardrails, and order.service's area/zone/shipping wiring
 * (validateShippingAddress, resolvedAddress, shippingAmount in the total).
 *
 * LOCAL throwaway DB only — see scripts/region-hide-verify.js's header for the
 * one-time setup (empty DB + order_number_seq + schema push). This script
 * creates its own isolated regions/zones (never touches real UAE/SA), so it's
 * safe to re-run against the same throwaway DB used for region-hide-verify.js:
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/amoon_region_test" node scripts/delivery-zone-verify.js
 */
const prisma = require('../src/config/db');
const deliveryZoneService = require('../src/services/deliveryZone.service');
const regionService = require('../src/services/region.service');
const orderService = require('../src/services/order.service');

const TAG = 'ZZZONETEST';
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
  await prisma.deliveryZone.deleteMany({ where: { name: { contains: TAG } } });
  await prisma.region.updateMany({ where: { code: { startsWith: TAG } }, data: { isDefault: false } });
  await prisma.region.deleteMany({ where: { code: { startsWith: TAG } } });
  regionService.invalidateCache();
}

async function main() {
  await cleanup();

  const regionA = await prisma.region.create({
    data: { code: `${TAG}A`, name: 'Zone Test Region A', isActive: true, isDefault: true, sortOrder: 900, currency: 'AED', shippingFlatRate: 25 },
  });
  const regionB = await prisma.region.create({
    data: { code: `${TAG}B`, name: 'Zone Test Region B', isActive: true, isDefault: false, sortOrder: 901, currency: 'AED' }, // no shippingFlatRate -> null
  });
  regionService.invalidateCache();

  console.log('1) Zone CRUD');
  const zone1 = await deliveryZoneService.createZone({ regionId: regionA.id, name: `${TAG} Dubai`, sortOrder: 0 });
  ok('zone created', !!zone1?.id);
  const zone2 = await deliveryZoneService.createZone({ regionId: regionA.id, name: `${TAG} Abu Dhabi`, sortOrder: 1 });
  ok('second zone created', !!zone2?.id);
  const listed = await deliveryZoneService.listZones({ regionId: regionA.id });
  ok('list scoped to region returns both', listed.length === 2, `got ${listed.length}`);
  const listedB = await deliveryZoneService.listZones({ regionId: regionB.id });
  ok('list scoped to a different region returns none', listedB.length === 0, `got ${listedB.length}`);
  const updated = await deliveryZoneService.updateZone(zone1.id, { name: `${TAG} Dubai Updated` });
  ok('zone update succeeds', updated?.name === `${TAG} Dubai Updated`);

  console.log('\n2) Duplicate name within the same region is rejected');
  let threw = null;
  try {
    await deliveryZoneService.createZone({ regionId: regionA.id, name: `${TAG} Abu Dhabi` });
  } catch (err) {
    threw = err;
  }
  ok('rejected with P2002', threw?.code === 'P2002', threw?.message || 'did not throw');

  console.log('\n3) assertValidZone guardrails');
  const validZone = await deliveryZoneService.assertValidZone(zone2.id, regionA.id);
  ok('valid zone in correct region passes', validZone?.id === zone2.id);

  threw = null;
  try {
    await deliveryZoneService.assertValidZone(zone2.id, regionB.id);
  } catch (err) {
    threw = err;
  }
  ok('zone from wrong region rejected', threw?.code === 'ZONE_WRONG_REGION', threw?.message || 'did not throw');

  threw = null;
  try {
    await deliveryZoneService.assertValidZone('00000000-0000-0000-0000-000000000000', regionA.id);
  } catch (err) {
    threw = err;
  }
  ok('nonexistent zone rejected', threw?.code === 'ZONE_NOT_FOUND', threw?.message || 'did not throw');

  await deliveryZoneService.updateZone(zone2.id, { isActive: false });
  threw = null;
  try {
    await deliveryZoneService.assertValidZone(zone2.id, regionA.id);
  } catch (err) {
    threw = err;
  }
  ok('inactive zone rejected', threw?.code === 'ZONE_INACTIVE', threw?.message || 'did not throw');
  await deliveryZoneService.updateZone(zone2.id, { isActive: true }); // reset for later checks

  console.log('\n4) Frictionless delete — no "in use" guard');
  const zone3 = await deliveryZoneService.createZone({ regionId: regionA.id, name: `${TAG} Sharjah`, sortOrder: 2 });
  const addrUser = await prisma.user.create({ data: { email: `${TAG}_addr@test.local` } });
  await prisma.address.create({ data: { userId: addrUser.id, area: 'Al Barsha', deliveryZoneId: zone3.id } });
  const deleted = await deliveryZoneService.deleteZone(zone3.id);
  ok('zone with a referencing address deletes without error', !!deleted);
  const orphaned = await prisma.address.findFirst({ where: { userId: addrUser.id } });
  ok('referencing address survives with deliveryZoneId set null', orphaned && orphaned.deliveryZoneId === null, `got ${orphaned?.deliveryZoneId}`);

  console.log('\n5) Order creation: area + zone + region shipping fee wiring');
  const cat = await prisma.category.create({ data: { title: `${TAG} Cat`, status: 'PUBLISHED' } });
  const product = await prisma.product.create({
    data: { title: `${TAG} Product`, price: 100, quantity: 10, status: 'PUBLISHED', categoryId: cat.id },
  });
  const userA = await prisma.user.create({ data: { email: `${TAG}_a@test.local`, regionId: regionA.id } });

  // 5a. Valid zone in the order's own region -> shippingArea/shippingZoneName/shippingAmount stamped.
  let res = await orderService.buyNow(
    userA.id,
    {
      productId: product.id,
      quantity: 1,
      shippingAddress: { area: 'Al Barsha', deliveryZoneId: zone1.id },
      paymentMethod: 'COD',
    },
    { regionCode: regionA.code }
  );
  ok('order created with valid area+zone', !!res.order, res.error || '');
  if (res.order) {
    ok('shippingArea stamped', res.order.regionId === regionA.id);
    const full = await prisma.order.findUnique({ where: { id: res.order.id } });
    ok('shippingArea = "Al Barsha"', full.shippingArea === 'Al Barsha', `got ${full.shippingArea}`);
    ok('shippingZoneName resolved from the zone', full.shippingZoneName === `${TAG} Dubai Updated`, `got ${full.shippingZoneName}`);
    ok('shippingAmount = region flat rate (25)', Number(full.shippingAmount) === 25, `got ${full.shippingAmount}`);
    ok('totalAmount includes the shipping fee', Number(full.totalAmount) === 125, `got ${full.totalAmount}`);
  }

  // 5b. Zone from a DIFFERENT region than the order -> rejected.
  res = await orderService.buyNow(
    userA.id,
    {
      productId: product.id,
      quantity: 1,
      shippingAddress: { area: 'Al Barsha', deliveryZoneId: zone1.id }, // zone1 belongs to regionA
      paymentMethod: 'COD',
    },
    { regionCode: regionB.code } // ordering in regionB
  );
  ok('order rejected when zone belongs to a different region', !res.order && /region/i.test(res.error || ''), res.error || 'unexpectedly succeeded');

  // 5c. Region with no shippingFlatRate configured -> shippingAmount 0.
  const userB = await prisma.user.create({ data: { email: `${TAG}_b@test.local`, regionId: regionB.id } });
  res = await orderService.buyNow(
    userB.id,
    { productId: product.id, quantity: 1, shippingAddress: { area: 'Downtown' }, paymentMethod: 'COD' },
    { regionCode: regionB.code }
  );
  ok('order created in a region with no shipping fee configured', !!res.order, res.error || '');
  if (res.order) {
    const full = await prisma.order.findUnique({ where: { id: res.order.id } });
    ok('shippingAmount is 0 (free)', Number(full.shippingAmount) === 0, `got ${full.shippingAmount}`);
    ok('no deliveryZoneId submitted -> shippingZoneName null', full.shippingZoneName === null);
  }

  // 5d. Missing area is rejected by validateShippingAddress.
  res = await orderService.buyNow(
    userA.id,
    { productId: product.id, quantity: 1, shippingAddress: { deliveryZoneId: zone1.id }, paymentMethod: 'COD' },
    { regionCode: regionA.code }
  );
  ok('order rejected when area is missing', !res.order && /area/i.test(res.error || ''), res.error || 'unexpectedly succeeded');

  console.log(`\n${failures === 0 ? '✅' : '❌'} Delivery zone verification: ${failures === 0 ? 'all checks passed' : failures + ' check(s) failed'}`);
  await cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
