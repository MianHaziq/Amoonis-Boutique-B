/* F1 regression: a SCHEDULED order must not be bookable earlier than the cart's product
 * prep lead allows. LOCAL DB. Run: node -r dotenv/config scripts/scheduled-preplead-test.js */
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
  const code = 'PREP_' + Math.floor(Math.random() * 1e6);
  // All days deliverable, no cutoff, no same-day, region courier lead 1.
  const region = await regionService.createRegion({ code, name: 'Prep', currency: 'AED', timezone: 'Asia/Dubai', standardDeliveryDays: 1, deliveryDays: [], sameDayEnabled: false, ...legal });
  const zone = await zoneService.createZone({ regionId: region.id, name: 'Z' });
  const category = await prisma.category.create({ data: { title: 'PC_' + code } });
  // Product needs 7 days of prep.
  const product = await productService.createProduct({ title: 'PP ' + code, status: 'PUBLISHED', price: 100, quantity: 1000, categoryId: category.id, regionIds: [region.id], deliveryLeadDays: 7 });

  const order = (extra) => orderService.createGuestOrder({
    items: [{ productId: product.id, quantity: 1 }],
    shippingAddress: { fullName: 'B', phone: '05', area: 'A', deliveryZoneId: zone.id },
    email: 'b@t.com', paymentMethod: 'COD', ...extra,
  }, { regionCode: code });

  const today = bt.todayKeyInTz('Asia/Dubai');
  const iso = (k) => `${k}T12:00:00Z`;

  console.log('STANDARD estimate reflects prep lead 7');
  let r = await order({ deliveryType: 'STANDARD' });
  ok('STANDARD estimatedDeliveryDays == 7', !r.error && r.order.estimatedDeliveryDays === 7, r.error || `got ${r.order?.estimatedDeliveryDays}`);
  ok('STANDARD estimatedDeliveryDate == today+7', r.order?.estimatedDeliveryDate === bt.addDaysToKey(today, 7), `got ${r.order?.estimatedDeliveryDate}`);

  console.log('SCHEDULED before prep floor is REJECTED (the F1 bug)');
  r = await order({ deliveryType: 'SCHEDULED', scheduledDeliveryAt: iso(bt.addDaysToKey(today, 1)) });
  ok('tomorrow rejected (prep needs 7)', /too soon/i.test(r.error || ''), r.error || 'NOT REJECTED — F1 regressed');
  r = await order({ deliveryType: 'SCHEDULED', scheduledDeliveryAt: iso(bt.addDaysToKey(today, 3)) });
  ok('today+3 rejected (< 7)', /too soon/i.test(r.error || ''), r.error || 'NOT REJECTED');

  console.log('SCHEDULED at/after prep floor is ACCEPTED');
  r = await order({ deliveryType: 'SCHEDULED', scheduledDeliveryAt: iso(bt.addDaysToKey(today, 7)) });
  ok('today+7 accepted', !r.error, r.error || '');
  r = await order({ deliveryType: 'SCHEDULED', scheduledDeliveryAt: iso(bt.addDaysToKey(today, 10)) });
  ok('today+10 accepted', !r.error, r.error || '');

  await prisma.order.deleteMany({ where: { regionId: region.id } });
  await prisma.product.delete({ where: { id: product.id } });
  await prisma.category.delete({ where: { id: category.id } });
  await prisma.region.delete({ where: { id: region.id } });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR:', e); process.exit(1); });
