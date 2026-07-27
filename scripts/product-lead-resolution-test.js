/* Verifies the UNIFIED product-page delivery-lead resolution (what the storefront/mobile
 * gets from GET /products/:id): productZone > productRegion > product > categoryZone >
 * categoryRegion > category > zoneStandard > regionStandard > default — specific-wins.
 * LOCAL DB. Run: node -r dotenv/config scripts/product-lead-resolution-test.js */
const prisma = require('../src/config/db');
const regionService = require('../src/services/region.service');
const zoneService = require('../src/services/deliveryZone.service');
const productService = require('../src/services/product.service');
const categoryService = require('../src/services/category.service');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) pass++; else { fail++; console.log('  ✗', n, e); } };
const legal = {};
for (const f of ['registrationCity','currencyDisplayName','vatLawName','dataProtectionLawName','dataProtectionAuthority','ipLawName','consumerProtectionLawName','consumerProtectionAuthority','standardsAuthority']) { legal[f]='x'; legal[f+'_ar']='س'; }

(async () => {
  const code = 'PLR_' + Math.floor(Math.random() * 1e6);
  // Region standard 2, zone Riyadh standard 5 (mirrors the user's real setup).
  const region = await regionService.createRegion({ code, name: 'PLR', currency: 'AED', standardDeliveryDays: 2, ...legal });
  const zone = await zoneService.createZone({ regionId: region.id, name: 'Riyadh', standardLeadDays: 5 });
  const vis = { isStaff: false, regionId: region.id, zoneId: zone.id, currency: 'AED' };
  const visNoZone = { isStaff: false, regionId: region.id, currency: 'AED' };
  const lead = async (id, v) => (await productService.getProductById(id, v))?.resolvedDeliveryLeadDays;

  const mkCat = async (name) => (await categoryService.createCategory({ title: name, regionIds: [region.id] })).id ?? (await prisma.category.findFirst({ where: { title: name } })).id;
  const mkProd = async (catId, extra = {}) => productService.createProduct({ title: 'P ' + code + Math.random(), status: 'PUBLISHED', price: 100, quantity: 1000, categoryId: catId, regionIds: [region.id], ...extra });

  console.log('A. no product/category override -> area STANDARD (zone 5, else region 2)');
  const catPlain = await mkCat('Plain_' + code);
  const p1 = await mkProd(catPlain);
  ok('with zone -> zone standard 5', await lead(p1.id, vis) === 5, `got ${await lead(p1.id, vis)}`);
  ok('without zone -> region standard 2', await lead(p1.id, visNoZone) === 2, `got ${await lead(p1.id, visNoZone)}`);

  console.log('B. category override wins over the standard (even when the customer is in the zone)');
  const catFlowers = await mkCat('Flowers_' + code);
  await categoryService.updateCategory(catFlowers, { deliveryLeadDays: 6 });
  const p2 = await mkProd(catFlowers);
  ok('category global 6 beats zone standard 5', await lead(p2.id, vis) === 6, `got ${await lead(p2.id, vis)}`);

  console.log('C. category per-region override beats category global + standard');
  await categoryService.updateCategory(catFlowers, { regionLeadDays: [{ regionId: region.id, deliveryLeadDays: 7 }] });
  ok('category-region 7 beats global 6 & zone 5', await lead(p2.id, vis) === 7, `got ${await lead(p2.id, vis)}`);

  console.log('D. category per-ZONE override is top of the category tier');
  await categoryService.updateCategory(catFlowers, { zoneLeadDays: [{ zoneId: zone.id, deliveryLeadDays: 3 }] });
  ok('category-zone 3 beats category-region 7', await lead(p2.id, vis) === 3, `got ${await lead(p2.id, vis)}`);
  ok('without zone still category-region 7', await lead(p2.id, visNoZone) === 7, `got ${await lead(p2.id, visNoZone)}`);

  console.log('E. product-level overrides beat category; product-zone beats product-region');
  const p3 = await mkProd(catFlowers, { deliveryLeadDays: 9 });
  ok('product global 9 beats category-zone 3', await lead(p3.id, vis) === 9, `got ${await lead(p3.id, vis)}`);
  await productService.updateProduct(p3.id, { zoneLeadDays: [{ zoneId: zone.id, deliveryLeadDays: 4 }] });
  ok('product-zone 4 beats product global 9', await lead(p3.id, vis) === 4, `got ${await lead(p3.id, vis)}`);

  console.log('F. stale/foreign zone id falls back to region level (no crash)');
  ok('bogus zoneId -> region standard 2 for plain product', await lead(p1.id, { ...vis, zoneId: '00000000-0000-0000-0000-000000000000' }) === 2, `got ${await lead(p1.id, { ...vis, zoneId: '00000000-0000-0000-0000-000000000000' })}`);

  console.log('G. a zone from ANOTHER region must NOT apply its overrides (cross-region leak)');
  const code2 = 'PLR2_' + Math.floor(Math.random() * 1e6);
  const region2 = await regionService.createRegion({ code: code2, name: 'PLR2', currency: 'AED', standardDeliveryDays: 80, ...legal });
  const zone2 = await zoneService.createZone({ regionId: region2.id, name: 'Foreign', standardLeadDays: 30 });
  // p1 is in region1; pass region2's zone as zoneId while resolving in region1 -> must ignore it.
  const foreignLead = await lead(p1.id, { ...vis, zoneId: zone2.id });
  ok('foreign zone (std 30) ignored -> region1 standard 2', foreignLead === 2, `got ${foreignLead}`);
  // also with a per-zone override on p1 for the foreign zone: still must be ignored in region1.
  await productService.updateProduct(p1.id, { zoneLeadDays: [{ zoneId: zone2.id, deliveryLeadDays: 20 }] });
  const foreignLead2 = await lead(p1.id, { ...vis, zoneId: zone2.id });
  ok('foreign zone product-override (20) ignored -> region1 standard 2', foreignLead2 === 2, `got ${foreignLead2}`);

  // cleanup
  await prisma.product.deleteMany({ where: { id: { in: [p1.id, p2.id, p3.id] } } });
  await prisma.category.deleteMany({ where: { id: { in: [catPlain, catFlowers] } } });
  await prisma.region.deleteMany({ where: { id: { in: [region.id, region2.id] } } });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR:', e); process.exit(1); });
