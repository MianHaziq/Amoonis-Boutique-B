/**
 * SQA: region-scoped saved addresses (real DB, real address.service).
 * Verifies an address captures its region at save time (from the delivery zone,
 * else the active region), exposes region {code,name} on read, and that changing
 * the zone re-tags the region.
 *
 * LOCAL throwaway DB only:
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/amoonis_sqa_test" \
 *     node scripts/address-region-verify.js
 */
const prisma = require('../src/config/db');
const addressService = require('../src/services/address.service');

const TAG = 'ZZADDRTEST';
let failures = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}
async function cleanup() {
  await prisma.address.deleteMany({ where: { user: { email: { contains: TAG } } } });
  await prisma.deliveryZone.deleteMany({ where: { name: { contains: TAG } } });
  await prisma.user.deleteMany({ where: { email: { contains: TAG } } });
  await prisma.region.deleteMany({ where: { code: { startsWith: 'ZZ' } } });
}

async function main() {
  await cleanup();
  // Two regions + a zone in each.
  const uae = await prisma.region.create({ data: { code: 'ZZUAE', name: `${TAG} UAE`, name_ar: 'الإمارات', currency: 'AED', isActive: true } });
  const ksa = await prisma.region.create({ data: { code: 'ZZSA', name: `${TAG} Saudi`, name_ar: 'السعودية', currency: 'SAR', isActive: true } });
  const dubaiZone = await prisma.deliveryZone.create({ data: { regionId: uae.id, name: `${TAG} Dubai`, isActive: true } });
  const riyadhZone = await prisma.deliveryZone.create({ data: { regionId: ksa.id, name: `${TAG} Riyadh`, isActive: true } });
  const user = await prisma.user.create({ data: { email: `${TAG}@test.local`, regionId: uae.id } });
  const U = user.id;

  // 1. Create with a UAE zone → region captured from the zone.
  const a1 = await addressService.createAddress(U, { label: 'Home', area: 'Al Barsha', deliveryZoneId: dubaiZone.id }, ksa.id /* even if header says KSA, the zone wins */);
  ok('zone region wins over header → regionId = UAE', a1.regionId === uae.id, `got ${a1.regionId}`);
  ok('response exposes region.code = ZZUAE', a1.region?.code === 'ZZUAE', a1.region?.code);
  ok('response exposes region.name', a1.region?.name === `${TAG} UAE`);

  // 2. Create with NO zone → falls back to the active region (header).
  const a2 = await addressService.createAddress(U, { label: 'NoZone', area: 'Somewhere' }, ksa.id);
  ok('zoneless address → regionId = active header region (KSA)', a2.regionId === ksa.id, `got ${a2.regionId}`);
  ok('zoneless exposes region.code = ZZSA', a2.region?.code === 'ZZSA');

  // 3. Create a KSA address via Riyadh zone.
  const a3 = await addressService.createAddress(U, { label: 'Office', area: 'Olaya', deliveryZoneId: riyadhZone.id }, uae.id);
  ok('Riyadh zone → regionId = KSA', a3.regionId === ksa.id);

  // 4. List returns all three, each with its own region code.
  const list = await addressService.listAddresses(U);
  ok('list returns 3 addresses', list.length === 3);
  const byLabel = Object.fromEntries(list.map((a) => [a.label, a.region?.code]));
  ok('Home → ZZUAE', byLabel['Home'] === 'ZZUAE');
  ok('Office → ZZSA', byLabel['Office'] === 'ZZSA');
  ok('NoZone → ZZSA', byLabel['NoZone'] === 'ZZSA');

  // 5. Update the Home address to the Riyadh zone → region re-tags to KSA.
  const upd = await addressService.updateAddress(U, a1.id, { deliveryZoneId: riyadhZone.id }, uae.id);
  ok('changing zone re-tags region → KSA', upd.regionId === ksa.id, `got ${upd.regionId}`);
  ok('updated region.code = ZZSA', upd.region?.code === 'ZZSA');

  // 6. Update an unrelated field (label) → region UNCHANGED.
  const upd2 = await addressService.updateAddress(U, a3.id, { label: 'Office HQ' }, uae.id);
  ok('unrelated edit leaves region untouched (still KSA)', upd2.regionId === ksa.id);

  await cleanup();
  console.log(`\n${failures === 0 ? '🎉 ALL PASSED' : `❌ ${failures} FAILED`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
