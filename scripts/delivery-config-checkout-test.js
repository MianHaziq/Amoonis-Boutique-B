/* Phase 4 checkout-engine integration test. Creates a throwaway region + zone + product,
 * places guest orders exercising each delivery rule, then cleans everything up.
 * Run: node -r dotenv/config scripts/delivery-config-checkout-test.js  (LOCAL DB only) */
const prisma = require('../src/config/db');
const regionService = require('../src/services/region.service');
const zoneService = require('../src/services/deliveryZone.service');
const orderService = require('../src/services/order.service');

const legal = {};
for (const f of ['registrationCity', 'currencyDisplayName', 'vatLawName', 'dataProtectionLawName',
  'dataProtectionAuthority', 'ipLawName', 'consumerProtectionLawName', 'consumerProtectionAuthority',
  'standardsAuthority']) { legal[f] = 'x'; legal[f + '_ar'] = 'س'; }

let pass = 0, fail = 0;
function check(name, cond, extra = '') { if (cond) { pass++; console.log('  PASS', name, extra); } else { fail++; console.log('  FAIL', name, extra); } }

(async () => {
  const code = 'TCHK_' + Math.floor(Math.random() * 1e6);
  const region = await regionService.createRegion({
    code, name: 'Checkout Test', currency: 'AED', timezone: 'Asia/Dubai',
    shippingFlatRate: 30, freeDeliveryThreshold: 200, standardDeliveryDays: 2,
    deliveryDays: [], sameDayEnabled: true, sameDayCutoff: '23:59', codEnabled: true,
    ...legal,
  });
  // Zone A: overrides fee=15, cod on, min 50, max 500
  const zoneA = await zoneService.createZone({
    regionId: region.id, name: 'ZoneA', shippingFlatRate: 15, codEnabled: true,
    minOrderAmount: 50, maxOrderAmount: 500,
  });
  // Zone B: COD disabled
  const zoneB = await zoneService.createZone({ regionId: region.id, name: 'ZoneB', codEnabled: false });

  // A published product priced 100 in this region.
  const category = await prisma.category.create({ data: { title: 'TC_' + code } });
  const product = await prisma.product.create({
    data: {
      title: 'TCProd ' + code, status: 'PUBLISHED',
      price: 100, quantity: 1000, categoryId: category.id,
      regions: { create: { regionId: region.id, price: 100 } },
    },
  });

  const addr = (zoneId) => ({ fullName: 'Test Buyer', phone: '0500000000', area: 'Somewhere', deliveryZoneId: zoneId, city: 'X', country: 'AE' });
  const guest = (qty, zoneId, extra = {}) => orderService.createGuestOrder({
    items: [{ productId: product.id, quantity: qty }],
    shippingAddress: addr(zoneId), email: 'buyer@test.com', paymentMethod: 'COD',
    deliveryType: 'STANDARD', ...extra,
  }, { regionCode: code });

  console.log('\n[1] STANDARD order in Zone A (qty 1 = 100): zone fee 15, not free');
  let r = await guest(1, zoneA.id);
  check('order created', !r.error, r.error || '');
  check('shippingAmount = 15 (zone override)', r.order?.shippingAmount === 15, `got ${r.order?.shippingAmount}`);
  check('estimatedDeliveryDays = 2 (region)', r.order?.estimatedDeliveryDays === 2, `got ${r.order?.estimatedDeliveryDays}`);

  console.log('\n[2] Free delivery when net >= 200 (qty 2 = 200)');
  r = await guest(2, zoneA.id);
  check('shippingAmount = 0 (free threshold hit)', r.order?.shippingAmount === 0, `got ${r.order?.shippingAmount}`);

  console.log('\n[3] Min order not met — need a zone with min above the order value');
  const zoneMin = await zoneService.createZone({ regionId: region.id, name: 'ZoneMin', minOrderAmount: 150 });
  r = await guest(1, zoneMin.id); // 100 < 150
  check('rejected with min-order error', !!r.error && /minimum order/i.test(r.error), r.error || 'no error');

  console.log('\n[4] Max order exceeded');
  const zoneMax = await zoneService.createZone({ regionId: region.id, name: 'ZoneMax', maxOrderAmount: 150 });
  r = await guest(2, zoneMax.id); // 200 > 150
  check('rejected with max-order error', !!r.error && /maximum order/i.test(r.error), r.error || 'no error');

  console.log('\n[5] COD disabled in Zone B');
  r = await guest(1, zoneB.id);
  check('rejected with COD-not-available error', !!r.error && /cash on delivery/i.test(r.error), r.error || 'no error');

  console.log('\n[6] SCHEDULED for a valid future date (date-only, no time slots)');
  const cfg = await require('../src/services/deliveryConfig.service').loadAndResolve({ regionRef: code, zoneId: zoneA.id, subtotal: 100 });
  const futureKey = require('../src/utils/businessTime').addDaysToKey(cfg.config.todayKey, 5);
  r = await guest(1, zoneA.id, { deliveryType: 'SCHEDULED', scheduledDeliveryAt: `${futureKey}T12:00:00Z` });
  check('scheduled order created', !r.error, r.error || '');
  check('scheduledDeliveryAt persisted', !!r.order?.scheduledDeliveryAt, `got ${r.order?.scheduledDeliveryAt}`);

  console.log('\n[7] SCHEDULED with no date -> rejected');
  r = await guest(1, zoneA.id, { deliveryType: 'SCHEDULED' });
  check('rejected: date required', !!r.error && /scheduledDeliveryAt is required/i.test(r.error), r.error || 'no error');

  console.log('\n[8] SCHEDULED on a blackout date -> rejected');
  // Add the blackout through the service so the region cache is invalidated (the real
  // admin path). A direct prisma write would leave the 60s region cache stale.
  await regionService.updateRegion(region.id, { blackoutDates: [{ date: futureKey, label: 'BO' }] });
  r = await guest(1, zoneA.id, { deliveryType: 'SCHEDULED', scheduledDeliveryAt: `${futureKey}T12:00:00Z` });
  check('rejected: blackout day', !!r.error && /not available on the selected date/i.test(r.error), r.error || 'no error');

  // cleanup
  await prisma.order.deleteMany({ where: { regionId: region.id } });
  await prisma.product.delete({ where: { id: product.id } });
  await prisma.category.delete({ where: { id: category.id } });
  await prisma.region.delete({ where: { id: region.id } });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR:', e); process.exit(1); });
