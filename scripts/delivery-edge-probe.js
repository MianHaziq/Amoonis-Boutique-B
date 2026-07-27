/* Nasty edge-case probe for delivery config — invariants that hold regardless of the
 * current wall clock. LOCAL DB. Run: node -r dotenv/config scripts/delivery-edge-probe.js */
const prisma = require('../src/config/db');
const regionService = require('../src/services/region.service');
const zoneService = require('../src/services/deliveryZone.service');
const productService = require('../src/services/product.service');
const orderService = require('../src/services/order.service');
const bt = require('../src/utils/businessTime');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) pass++; else { fail++; console.log('  ✗', n, e); } };
const legal = {};
for (const f of ['registrationCity','currencyDisplayName','vatLawName','dataProtectionLawName','dataProtectionAuthority','ipLawName','consumerProtectionLawName','consumerProtectionAuthority','standardsAuthority']) { legal[f]='x'; legal[f+'_ar']='س'; }

(async () => {
  const code = 'EDGE_' + Math.floor(Math.random() * 1e6);
  // Region: deliver Mon/Tue/Wed only [1,2,3], cutoff 12:00, region transit 4 days.
  const region = await regionService.createRegion({
    code, name: 'Edge', currency: 'AED', timezone: 'Asia/Dubai',
    standardDeliveryDays: 4, deliveryDays: [1, 2, 3], sameDayEnabled: true, sameDayCutoff: '12:00', codEnabled: true, ...legal,
  });
  const zoneLead6 = await zoneService.createZone({ regionId: region.id, name: 'Lead6', standardLeadDays: 6 });
  const zonePlain = await zoneService.createZone({ regionId: region.id, name: 'Plain' });
  const category = await prisma.category.create({ data: { title: 'EC_' + code } });
  // No product/category prep override → resolution falls through to the area STANDARD.
  const product = await productService.createProduct({ title: 'EP ' + code, status: 'PUBLISHED', price: 100, quantity: 100000, categoryId: category.id, regionIds: [region.id] });

  const guest = (zoneId, extra = {}) => orderService.createGuestOrder({
    items: [{ productId: product.id, quantity: 1 }],
    shippingAddress: { fullName: 'B', phone: '05', area: 'A', deliveryZoneId: zoneId },
    email: 'b@t.com', paymentMethod: 'COD', deliveryType: 'STANDARD', ...extra,
  }, { regionCode: code });

  console.log('A. STANDARD estimatedDeliveryDate invariants (restricted days + cutoff + zone lead 6)');
  let r = await guest(zoneLead6.id);
  ok('order placed', !r.error, r.error || '');
  const key = r.order?.estimatedDeliveryDate;
  const days = r.order?.estimatedDeliveryDays;
  const today = bt.todayKeyInTz('Asia/Dubai');
  ok('estimatedDeliveryDate is a valid key', bt.isValidDateKey(key || ''), `got ${key}`);
  ok('arrival weekday is an allowed delivery day (Mon/Tue/Wed)', [1, 2, 3].includes(bt.weekdayOfKey(key)), `wd ${bt.weekdayOfKey(key)} for ${key}`);
  ok('estimatedDeliveryDays == daysBetween(today, date)', days === bt.daysBetweenKeys(today, key), `days=${days} between=${bt.daysBetweenKeys(today, key)}`);
  ok('arrival >= today + zone lead 6 (>= 6, +1 if past cutoff)', days >= 6, `days=${days}`);

  console.log('B. zone standard 0 -> resolved 0 (rolled to the next allowed delivery day)');
  const zoneLead0 = await zoneService.createZone({ regionId: region.id, name: 'Lead0', standardLeadDays: 0 });
  // No product/category prep -> falls to zone standard 0 -> arrival = next allowed day (rolled).
  r = await guest(zoneLead0.id);
  ok('order placed (zone standard 0)', !r.error, r.error || '');
  ok('arrival still on an allowed delivery day', [1, 2, 3].includes(bt.weekdayOfKey(r.order?.estimatedDeliveryDate)), `wd ${bt.weekdayOfKey(r.order?.estimatedDeliveryDate)}`);
  ok('zone standard 0 respected (not region 4): days < 4', r.order?.estimatedDeliveryDays < 4, `days=${r.order?.estimatedDeliveryDays}`);

  console.log('C. SCHEDULED max-window boundary');
  // pick a valid allowed weekday within window and one beyond
  let within = bt.addDaysToKey(today, 30); while (![1,2,3].includes(bt.weekdayOfKey(within))) within = bt.addDaysToKey(within, 1);
  const beyond = bt.addDaysToKey(today, 70);
  r = await guest(zonePlain.id, { deliveryType: 'SCHEDULED', scheduledDeliveryAt: `${within}T12:00:00Z` });
  ok('scheduled within window on allowed day accepted', !r.error, r.error || '');
  ok('scheduled snapshot has no estimatedDeliveryDate (SCHEDULED)', !r.order?.estimatedDeliveryDate);
  r = await guest(zonePlain.id, { deliveryType: 'SCHEDULED', scheduledDeliveryAt: `${beyond}T12:00:00Z` });
  ok('scheduled beyond 60d rejected', /more than/i.test(r.error || ''), r.error || 'no error');

  console.log('D. SCHEDULED on a non-delivery weekday rejected (region days Mon/Tue/Wed)');
  let offday = bt.addDaysToKey(today, 2); while ([1,2,3].includes(bt.weekdayOfKey(offday))) offday = bt.addDaysToKey(offday, 1);
  r = await guest(zonePlain.id, { deliveryType: 'SCHEDULED', scheduledDeliveryAt: `${offday}T12:00:00Z` });
  ok('scheduled on Thu/Fri/Sat/Sun rejected', /not available on the selected date/i.test(r.error || ''), r.error || 'no error');

  console.log('E. region-only order (no zone) uses region transit 4, rolled');
  r = await orderService.createGuestOrder({ items: [{ productId: product.id, quantity: 1 }], shippingAddress: { fullName: 'B', phone: '05', area: 'A' }, email: 'b@t.com', paymentMethod: 'COD', deliveryType: 'STANDARD' }, { regionCode: code });
  ok('region-only order placed', !r.error, r.error || '');
  ok('region-only arrival on allowed day', [1, 2, 3].includes(bt.weekdayOfKey(r.order?.estimatedDeliveryDate)), `wd ${bt.weekdayOfKey(r.order?.estimatedDeliveryDate)}`);
  ok('region-only days >= 4 (region transit)', r.order?.estimatedDeliveryDays >= 4, `days=${r.order?.estimatedDeliveryDays}`);

  // cleanup
  await prisma.order.deleteMany({ where: { regionId: region.id } });
  await prisma.product.delete({ where: { id: product.id } });
  await prisma.category.delete({ where: { id: category.id } });
  await prisma.region.delete({ where: { id: region.id } });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR:', e); process.exit(1); });
