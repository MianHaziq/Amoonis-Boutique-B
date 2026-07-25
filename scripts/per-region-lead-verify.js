/**
 * SQA: per-region delivery lead days (real DB, real services).
 * Verifies the resolution chain productRegion ?? product ?? categoryRegion ?? category
 * ?? default, and that the SAME product/category yields a DIFFERENT order delivery
 * estimate in different regions.
 *
 * LOCAL throwaway DB only:
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/amoonis_sqa_test" \
 *     node scripts/per-region-lead-verify.js
 */
const prisma = require('../src/config/db');
const productService = require('../src/services/product.service');
const orderService = require('../src/services/order.service');
const { resolveDeliveryLeadDays } = require('../src/utils/deliveryLeadDays');

const TAG = 'ZZLEADTEST';
let failures = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}
async function cleanup() {
  await prisma.orderItem.deleteMany({ where: { product: { title: { contains: TAG } } } });
  await prisma.order.deleteMany({ where: { guestEmail: { contains: TAG.toLowerCase() } } });
  await prisma.productRegion.deleteMany({ where: { product: { title: { contains: TAG } } } });
  await prisma.categoryRegion.deleteMany({ where: { category: { title: { contains: TAG } } } });
  await prisma.product.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.category.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.region.deleteMany({ where: { code: { startsWith: 'ZZL' } } });
}

async function main() {
  await cleanup();

  // --- Pure precedence (unit) ---
  ok('chain: productRegion wins', resolveDeliveryLeadDays({ productRegionLeadDays: 1, productLeadDays: 5, categoryRegionLeadDays: 7, categoryLeadDays: 3, defaultLeadDays: 9 }) === 1);
  ok('chain: product-global beats category-region', resolveDeliveryLeadDays({ productRegionLeadDays: null, productLeadDays: 5, categoryRegionLeadDays: 7, categoryLeadDays: 3, defaultLeadDays: 9 }) === 5);
  ok('chain: categoryRegion when no product tier', resolveDeliveryLeadDays({ productRegionLeadDays: null, productLeadDays: null, categoryRegionLeadDays: 7, categoryLeadDays: 3, defaultLeadDays: 9 }) === 7);
  ok('chain: category-global next', resolveDeliveryLeadDays({ productRegionLeadDays: null, productLeadDays: null, categoryRegionLeadDays: null, categoryLeadDays: 3, defaultLeadDays: 9 }) === 3);
  ok('chain: default last', resolveDeliveryLeadDays({ productRegionLeadDays: null, productLeadDays: null, categoryRegionLeadDays: null, categoryLeadDays: null, defaultLeadDays: 9 }) === 9);
  ok('chain: no region args == old behaviour', resolveDeliveryLeadDays({ productLeadDays: null, categoryLeadDays: 4, defaultLeadDays: 1 }) === 4);

  // --- DB-backed resolution via attachResolvedDeliveryLeadDays ---
  const uae = await prisma.region.create({ data: { code: 'ZZLUAE', name: `${TAG} UAE`, currency: 'AED', isActive: true, standardDeliveryDays: 1 } });
  const ksa = await prisma.region.create({ data: { code: 'ZZLSA', name: `${TAG} Saudi`, currency: 'SAR', isActive: true, standardDeliveryDays: 1 } });
  await prisma.settings.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default', defaultDeliveryLeadDays: 1 } });

  // Category global lead = 3, with a UAE override of 7.
  const cat = await prisma.category.create({ data: { title: `${TAG} Flowers`, status: 'PUBLISHED', deliveryLeadDays: 3 } });
  await prisma.categoryRegion.create({ data: { categoryId: cat.id, regionId: uae.id, deliveryLeadDays: 7 } });
  await prisma.categoryRegion.create({ data: { categoryId: cat.id, regionId: ksa.id } }); // no override

  // Product with NO global lead (inherits category), + a UAE ProductRegion override of 2.
  const prod = await prisma.product.create({ data: { title: `${TAG} Rose`, price: 100, quantity: 50, status: 'PUBLISHED', categoryId: cat.id, deliveryLeadDays: null } });
  await prisma.productRegion.create({ data: { productId: prod.id, regionId: uae.id, deliveryLeadDays: 2 } });

  const mapped = () => ({ id: prod.id, deliveryLeadDays: null, category: { id: cat.id, deliveryLeadDays: 3 } });

  // UAE: productRegion(2) wins.
  const uaeObj = mapped();
  await productService.attachResolvedDeliveryLeadDays([uaeObj], uae.id);
  ok('UAE resolves to productRegion=2', uaeObj.resolvedDeliveryLeadDays === 2, `got ${uaeObj.resolvedDeliveryLeadDays}`);

  // KSA: no product/category region override, product lead null → category global 3.
  const ksaObj = mapped();
  await productService.attachResolvedDeliveryLeadDays([ksaObj], ksa.id);
  ok('KSA resolves to category global=3', ksaObj.resolvedDeliveryLeadDays === 3, `got ${ksaObj.resolvedDeliveryLeadDays}`);

  // Remove the ProductRegion override → UAE should fall to categoryRegion=7.
  await prisma.productRegion.update({ where: { productId_regionId: { productId: prod.id, regionId: uae.id } }, data: { deliveryLeadDays: null } });
  const uaeObj2 = mapped();
  await productService.attachResolvedDeliveryLeadDays([uaeObj2], uae.id);
  ok('UAE (no productRegion) resolves to categoryRegion=7', uaeObj2.resolvedDeliveryLeadDays === 7, `got ${uaeObj2.resolvedDeliveryLeadDays}`);

  // Admin (regionId null) → global chain: product null → category global 3.
  const adminObj = mapped();
  await productService.attachResolvedDeliveryLeadDays([adminObj], null);
  ok('admin/global resolves to category global=3', adminObj.resolvedDeliveryLeadDays === 3);

  // --- Order estimate differs by region (same product) ---
  // Re-add the UAE ProductRegion override = 2.
  await prisma.productRegion.update({ where: { productId_regionId: { productId: prod.id, regionId: uae.id } }, data: { deliveryLeadDays: 2 } });
  const addr = { fullName: 'SQA', phone: '+971500000000', area: 'X', city: 'Y', country: 'Z' };
  const items = [{ productId: prod.id, quantity: 1 }];

  const uaeOrder = await orderService.createGuestOrder({ items, email: `${TAG.toLowerCase()}@t.local`, shippingAddress: addr }, { regionCode: 'ZZLUAE' });
  ok('UAE order created', !uaeOrder.error, uaeOrder.error || '');
  ok('UAE order estimate = max(transit 1, productRegion 2) = 2', uaeOrder.order?.estimatedDeliveryDays === 2, `got ${uaeOrder.order?.estimatedDeliveryDays}`);

  const ksaOrder = await orderService.createGuestOrder({ items, email: `${TAG.toLowerCase()}@t.local`, shippingAddress: addr }, { regionCode: 'ZZLSA' });
  ok('KSA order created', !ksaOrder.error, ksaOrder.error || '');
  ok('KSA order estimate = max(transit 1, category 3) = 3', ksaOrder.order?.estimatedDeliveryDays === 3, `got ${ksaOrder.order?.estimatedDeliveryDays}`);

  ok('SAME product → DIFFERENT per-region estimate (2 vs 3)', uaeOrder.order?.estimatedDeliveryDays !== ksaOrder.order?.estimatedDeliveryDays);

  await cleanup();
  console.log(`\n${failures === 0 ? '🎉 ALL PASSED' : `❌ ${failures} FAILED`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
