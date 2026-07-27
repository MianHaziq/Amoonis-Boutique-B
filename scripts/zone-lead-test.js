/* Per-zone product/category prep-lead: verifies the resolution chain
 * (productZone > productRegion > product > categoryZone > categoryRegion > category > default)
 * and that a per-zone product lead flows into a placed order's estimatedDeliveryDays.
 * LOCAL DB only. Run: node -r dotenv/config scripts/zone-lead-test.js */
const prisma = require('../src/config/db');
const regionService = require('../src/services/region.service');
const zoneService = require('../src/services/deliveryZone.service');
const productService = require('../src/services/product.service');
const categoryService = require('../src/services/category.service');
const orderService = require('../src/services/order.service');
const { resolveDeliveryLeadDays } = require('../src/utils/deliveryLeadDays');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) pass++; else { fail++; console.log('  ✗', n, e); } };
const legal = {};
for (const f of ['registrationCity','currencyDisplayName','vatLawName','dataProtectionLawName','dataProtectionAuthority','ipLawName','consumerProtectionLawName','consumerProtectionAuthority','standardsAuthority']) { legal[f]='x'; legal[f+'_ar']='س'; }

(async () => {
  // ---- pure chain ----
  console.log('A. resolveDeliveryLeadDays chain precedence');
  ok('zone beats region+product+category', resolveDeliveryLeadDays({ productZoneLeadDays: 9, productRegionLeadDays: 5, productLeadDays: 3, categoryZoneLeadDays: 8, categoryLeadDays: 2, defaultLeadDays: 1 }) === 9);
  ok('productRegion beats product when no zone', resolveDeliveryLeadDays({ productRegionLeadDays: 5, productLeadDays: 3, defaultLeadDays: 1 }) === 5);
  ok('categoryZone used when product tiers null', resolveDeliveryLeadDays({ categoryZoneLeadDays: 8, categoryRegionLeadDays: 4, categoryLeadDays: 2 }) === 8);
  ok('falls to default when all null', resolveDeliveryLeadDays({ defaultLeadDays: 1 }) === 1);
  ok('zero is respected (not treated as null)', resolveDeliveryLeadDays({ productZoneLeadDays: 0, productLeadDays: 5 }) === 0);

  // ---- E2E: per-zone product lead reaches the order ----
  console.log('B. E2E per-zone product lead -> order estimatedDeliveryDays');
  const code = 'ZL_' + Math.floor(Math.random() * 1e6);
  const region = await regionService.createRegion({ code, name: 'ZL', currency: 'AED', timezone: 'Asia/Dubai', standardDeliveryDays: 2, deliveryDays: [], sameDayEnabled: false, ...legal });
  const zoneA = await zoneService.createZone({ regionId: region.id, name: 'ZA' });
  const zoneB = await zoneService.createZone({ regionId: region.id, name: 'ZB' });
  const category = await prisma.category.create({ data: { title: 'ZLC_' + code } });
  // product: global lead 2; per-zone lead 9 for zoneA only
  const product = await productService.createProduct({
    title: 'ZLP ' + code, status: 'PUBLISHED', price: 100, quantity: 1000, categoryId: category.id,
    deliveryLeadDays: 2, regionIds: [region.id],
    zoneLeadDays: [{ zoneId: zoneA.id, deliveryLeadDays: 9 }],
  });
  ok('product create returns zoneLeadDays', Array.isArray(product.zoneLeadDays) && product.zoneLeadDays.some((z) => z.zoneId === zoneA.id && z.deliveryLeadDays === 9), JSON.stringify(product.zoneLeadDays));

  const guest = (zoneId) => orderService.createGuestOrder({
    items: [{ productId: product.id, quantity: 1 }],
    shippingAddress: { fullName: 'B', phone: '05', area: 'A', deliveryZoneId: zoneId },
    email: 'b@t.com', paymentMethod: 'COD', deliveryType: 'STANDARD',
  }, { regionCode: code });

  // Zone A: product-zone lead 9 wins over region transit 2 -> estimate 9 (all-days region, no cutoff)
  let r = await guest(zoneA.id);
  ok('Zone A order uses per-zone product lead 9', !r.error && r.order.estimatedDeliveryDays === 9, r.error || `got ${r.order?.estimatedDeliveryDays}`);
  // Zone B: no per-zone override -> falls to product global 2 vs region transit 2 -> 2
  r = await guest(zoneB.id);
  ok('Zone B order falls back to 2', !r.error && r.order.estimatedDeliveryDays === 2, r.error || `got ${r.order?.estimatedDeliveryDays}`);

  // ---- category-zone fallback (product has no lead at all) ----
  console.log('C. category-zone fallback');
  await categoryService.updateCategory(category.id, { zoneLeadDays: [{ zoneId: zoneA.id, deliveryLeadDays: 7 }] });
  const product2 = await productService.createProduct({
    title: 'ZLP2 ' + code, status: 'PUBLISHED', price: 100, quantity: 1000, categoryId: category.id, regionIds: [region.id],
    // no product deliveryLeadDays, no product-zone override -> should use category-zone 7 for zoneA
  });
  r = await orderService.createGuestOrder({ items: [{ productId: product2.id, quantity: 1 }], shippingAddress: { fullName: 'B', phone: '05', area: 'A', deliveryZoneId: zoneA.id }, email: 'b@t.com', paymentMethod: 'COD', deliveryType: 'STANDARD' }, { regionCode: code });
  ok('category-zone lead 7 used when product has none', !r.error && r.order.estimatedDeliveryDays === 7, r.error || `got ${r.order?.estimatedDeliveryDays}`);

  // cleanup
  await prisma.order.deleteMany({ where: { regionId: region.id } });
  await prisma.product.deleteMany({ where: { id: { in: [product.id, product2.id] } } });
  await prisma.category.delete({ where: { id: category.id } });
  await prisma.region.delete({ where: { id: region.id } });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR:', e); process.exit(1); });
