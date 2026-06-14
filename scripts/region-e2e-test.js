/**
 * End-to-end test for multi-region + draft support.
 * Server must be running on PORT. Run: node scripts/region-e2e-test.js
 *
 * Covers: regions CRUD, product/category/banner/section region+draft visibility
 * (storefront vs staff), nested section filtering, user region capture, order region
 * capture, and region-aware analytics (combined vs scoped).
 */
require('dotenv').config();
const prisma = require('../src/config/db');

const PORT = process.env.PORT || 5000;
const BASE = `http://localhost:${PORT}/api/v1`;

let passed = 0;
let failed = 0;
const failures = [];
function ok(name) { console.log(`  OK  ${name}`); passed++; }
function bad(name, msg) { console.error(`  FAIL ${name}\n       ${msg}`); failed++; failures.push(name); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

async function req(method, path, { token, region, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (region) headers['X-Region'] = region;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { bad(name, e.message); }
}

async function main() {
  let adminToken, regions, uae, sa;

  await test('admin signin', async () => {
    const r = await req('POST', '/auth/signin', { body: { email: 'admin@example.com', password: 'Admin@123' } });
    assert(r.status === 200 && r.json?.data?.token, `signin failed: ${r.status} ${JSON.stringify(r.json)}`);
    adminToken = r.json.data.token;
  });

  // ---------------- REGIONS ----------------
  await test('GET /regions (public) returns seeded regions', async () => {
    const r = await req('GET', '/regions');
    assert(r.status === 200 && Array.isArray(r.json.data), 'no regions list');
    regions = r.json.data;
    uae = regions.find((x) => x.code === 'UAE');
    sa = regions.find((x) => x.code === 'SA');
    assert(uae && sa, 'expected UAE and SA seeded');
    assert(uae.isDefault === true, 'UAE should be default');
  });

  let tempRegionId;
  await test('POST /regions create (admin) — scalability: add region at runtime', async () => {
    const r = await req('POST', '/regions', { token: adminToken, body: { code: 'KW', name: 'Kuwait', name_ar: 'الكويت', sortOrder: 2 } });
    assert(r.status === 201 && r.json.data?.id, `create region failed: ${r.status} ${JSON.stringify(r.json)}`);
    tempRegionId = r.json.data.id;
  });

  await test('PUT /regions/:id update', async () => {
    const r = await req('PUT', `/regions/${tempRegionId}`, { token: adminToken, body: { isActive: false } });
    assert(r.status === 200 && r.json.data.isActive === false, 'update region failed');
  });

  await test('DELETE /regions/:id (unused) succeeds', async () => {
    const r = await req('DELETE', `/regions/${tempRegionId}`, { token: adminToken });
    assert(r.status === 200, `delete region failed: ${r.status} ${JSON.stringify(r.json)}`);
  });

  await test('DELETE default region is blocked (409)', async () => {
    const r = await req('DELETE', `/regions/${uae.id}`, { token: adminToken });
    assert(r.status === 409, `expected 409, got ${r.status}`);
  });

  // ---------------- PRODUCTS ----------------
  let draftBothId, uaeOnlyId, saOnlyId;

  await test('create product: DRAFT, both regions', async () => {
    const r = await req('POST', '/products', {
      token: adminToken,
      body: { title: 'RGN Draft Both', price: 10, status: 'DRAFT', regionIds: [uae.id, sa.id] },
    });
    assert(r.status === 201, `create failed: ${r.status} ${JSON.stringify(r.json)}`);
    assert(r.json.data.status === 'DRAFT', 'status should be DRAFT');
    assert(r.json.data.regionIds.length === 2, 'should have 2 regions');
    draftBothId = r.json.data.id;
  });

  await test('storefront (UAE) does NOT see DRAFT product', async () => {
    const r = await req('GET', `/products/${draftBothId}`, { region: 'UAE' });
    assert(r.status === 404, `draft should be hidden, got ${r.status}`);
  });

  await test('staff (admin token) DOES see DRAFT product', async () => {
    const r = await req('GET', `/products/${draftBothId}`, { token: adminToken });
    assert(r.status === 200 && r.json.data.id === draftBothId, 'staff should see draft');
  });

  await test('publish product (status=PUBLISHED via PUT)', async () => {
    const r = await req('PUT', `/products/${draftBothId}`, { token: adminToken, body: { status: 'PUBLISHED' } });
    assert(r.status === 200 && r.json.data.status === 'PUBLISHED', 'publish failed');
  });

  await test('after publish, UAE storefront sees it', async () => {
    const r = await req('GET', `/products/${draftBothId}`, { region: 'UAE' });
    assert(r.status === 200, `should be visible after publish, got ${r.status}`);
  });

  await test('create product: PUBLISHED, UAE only', async () => {
    const r = await req('POST', '/products', { token: adminToken, body: { title: 'RGN UAE Only', price: 11, status: 'PUBLISHED', regionIds: [uae.id] } });
    assert(r.status === 201, `create failed: ${JSON.stringify(r.json)}`);
    uaeOnlyId = r.json.data.id;
  });

  await test('UAE-only product: visible to UAE, hidden from SA', async () => {
    const inUae = await req('GET', `/products/${uaeOnlyId}`, { region: 'UAE' });
    const inSa = await req('GET', `/products/${uaeOnlyId}`, { region: 'SA' });
    assert(inUae.status === 200, `UAE should see it (${inUae.status})`);
    assert(inSa.status === 404, `SA should NOT see it (${inSa.status})`);
  });

  await test('create product: PUBLISHED, SA only', async () => {
    const r = await req('POST', '/products', { token: adminToken, body: { title: 'RGN SA Only', price: 12, status: 'PUBLISHED', regionIds: [sa.id] } });
    assert(r.status === 201, `create failed: ${JSON.stringify(r.json)}`);
    saOnlyId = r.json.data.id;
  });

  await test('SA-only product: visible to SA, hidden from UAE', async () => {
    const inUae = await req('GET', `/products/${saOnlyId}`, { region: 'UAE' });
    const inSa = await req('GET', `/products/${saOnlyId}`, { region: 'SA' });
    assert(inSa.status === 200, `SA should see it (${inSa.status})`);
    assert(inUae.status === 404, `UAE should NOT see it (${inUae.status})`);
  });

  await test('product list: invalid regionIds rejected (400)', async () => {
    const r = await req('POST', '/products', { token: adminToken, body: { title: 'Bad', price: 5, regionIds: ['11111111-1111-1111-1111-111111111111'] } });
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });

  await test('admin product list with ?region=SA filter excludes UAE-only', async () => {
    const r = await req('GET', '/products?limit=100&region=SA', { token: adminToken });
    assert(r.status === 200, 'list failed');
    const ids = r.json.data.map((p) => p.id);
    assert(!ids.includes(uaeOnlyId), 'UAE-only must not appear in SA admin filter');
    assert(ids.includes(saOnlyId), 'SA-only must appear in SA admin filter');
  });

  await test('storefront list (SA) excludes UAE-only and drafts', async () => {
    const r = await req('GET', '/products?limit=100', { region: 'SA' });
    const ids = r.json.data.map((p) => p.id);
    assert(!ids.includes(uaeOnlyId), 'UAE-only leaked into SA storefront');
    assert(r.json.data.every((p) => p.status === 'PUBLISHED'), 'storefront returned a non-published product');
  });

  // ---------------- CATEGORIES ----------------
  let catDraftId, catUaeId;
  await test('create category DRAFT (both) hidden from storefront, visible to staff', async () => {
    const c = await req('POST', '/categories', { token: adminToken, body: { title: 'RGN Cat Draft', status: 'DRAFT', regionIds: [uae.id, sa.id] } });
    assert(c.status === 201, `cat create failed: ${JSON.stringify(c.json)}`);
    catDraftId = c.json.data.id;
    const pub = await req('GET', `/categories/${catDraftId}`, { region: 'UAE' });
    const staff = await req('GET', `/categories/${catDraftId}`, { token: adminToken });
    assert(pub.status === 404, 'draft category should be hidden');
    assert(staff.status === 200, 'staff should see draft category');
  });

  await test('category PUBLISHED UAE-only: SA storefront list excludes it', async () => {
    const c = await req('POST', '/categories', { token: adminToken, body: { title: 'RGN Cat UAE', status: 'PUBLISHED', regionIds: [uae.id] } });
    assert(c.status === 201, 'cat create failed');
    catUaeId = c.json.data.id;
    const saList = await req('GET', '/categories', { region: 'SA' });
    const uaeList = await req('GET', '/categories', { region: 'UAE' });
    assert(!saList.json.data.map((x) => x.id).includes(catUaeId), 'UAE-only category leaked to SA');
    assert(uaeList.json.data.map((x) => x.id).includes(catUaeId), 'UAE category missing from UAE list');
  });

  // ---------------- BANNERS ----------------
  let bannerId;
  await test('add banner DRAFT (UAE only), hidden from storefront', async () => {
    const b = await req('POST', '/banners', { token: adminToken, body: { url: 'https://example.com/rgn-banner.jpg', status: 'DRAFT', regionIds: [uae.id] } });
    assert(b.status === 201, `banner add failed: ${JSON.stringify(b.json)}`);
    bannerId = b.json.data[0].id;
    const pub = await req('GET', '/banners', { region: 'UAE' });
    assert(!pub.json.data.map((x) => x.id).includes(bannerId), 'draft banner should be hidden from storefront');
  });

  await test('update + publish banner, then UAE sees it but SA does not', async () => {
    const u = await req('PUT', `/banners/${bannerId}`, { token: adminToken, body: { status: 'PUBLISHED' } });
    assert(u.status === 200 && u.json.data.status === 'PUBLISHED', 'banner publish failed');
    const inUae = await req('GET', '/banners', { region: 'UAE' });
    const inSa = await req('GET', '/banners', { region: 'SA' });
    assert(inUae.json.data.map((x) => x.id).includes(bannerId), 'UAE should see published banner');
    assert(!inSa.json.data.map((x) => x.id).includes(bannerId), 'SA should not see UAE-only banner');
  });

  // ---------------- SECTIONS (incl. nested filtering) ----------------
  let sectionId;
  await test('create section (both regions, PUBLISHED) with UAE-only + SA-only products', async () => {
    const s = await req('POST', '/sections', {
      token: adminToken,
      body: { title: 'RGN Section', status: 'PUBLISHED', regionIds: [uae.id, sa.id], productIds: [uaeOnlyId, saOnlyId] },
    });
    assert(s.status === 201, `section create failed: ${JSON.stringify(s.json)}`);
    sectionId = s.json.data.id;
    assert(s.json.data.products.length === 2, 'staff create should show both products');
  });

  await test('nested filtering: SA user sees only SA-eligible product in the section', async () => {
    const r = await req('GET', `/sections/${sectionId}`, { region: 'SA' });
    assert(r.status === 200, 'section should be visible (both regions)');
    const ids = r.json.data.products.map((p) => p.id);
    assert(ids.includes(saOnlyId), 'SA product should be present');
    assert(!ids.includes(uaeOnlyId), 'UAE-only product must NOT leak into SA section view');
  });

  await test('nested filtering: UAE user sees only UAE-eligible product', async () => {
    const r = await req('GET', `/sections/${sectionId}`, { region: 'UAE' });
    const ids = r.json.data.products.map((p) => p.id);
    assert(ids.includes(uaeOnlyId) && !ids.includes(saOnlyId), 'UAE section view incorrect');
  });

  await test('DRAFT section hidden from storefront', async () => {
    const s = await req('POST', '/sections', { token: adminToken, body: { title: 'RGN Draft Section', status: 'DRAFT', regionIds: [uae.id] } });
    const draftSecId = s.json.data.id;
    const pub = await req('GET', `/sections/${draftSecId}`, { region: 'UAE' });
    assert(pub.status === 404, 'draft section should be hidden');
  });

  // ---------------- USER REGION CAPTURE ----------------
  let saUserEmail = `rgn_sa_${Date.now()}@example.com`;
  await test('signup with X-Region: SA stores user region = SA', async () => {
    const r = await req('POST', '/auth/signup', { region: 'SA', body: { fullName: 'SA User', email: saUserEmail, password: 'Test@1234' } });
    assert(r.status === 201, `signup failed: ${JSON.stringify(r.json)}`);
    assert(r.json.data.user.regionId === sa.id, `user region should be SA, got ${r.json.data.user.regionId}`);
  });

  await test('admin user list ?region=SA includes the new SA user', async () => {
    const r = await req('GET', '/users?limit=200&region=SA', { token: adminToken });
    assert(r.status === 200, `user list failed: ${r.status}`);
    const found = r.json.data.find((u) => u.email === saUserEmail);
    assert(found, 'SA user not found in region-filtered admin list');
    assert(found.region?.code === 'SA', 'user.region not surfaced');
  });

  // ---------------- ORDER REGION + ANALYTICS ----------------
  await test('checkout stamps order.regionId from X-Region (DB verified)', async () => {
    // admin acts as the customer here (cart belongs to admin user). Use an in-stock product.
    const stock = await req('POST', '/products', { token: adminToken, body: { title: 'RGN Order Item', price: 9, quantity: 50, status: 'PUBLISHED', regionIds: [uae.id, sa.id] } });
    assert(stock.status === 201, `stock product create failed: ${JSON.stringify(stock.json)}`);
    await req('POST', '/cart', { token: adminToken, body: { productId: stock.json.data.id, quantity: 1 } });
    const co = await req('POST', '/orders/checkout', {
      token: adminToken,
      region: 'SA',
      body: { shippingAddress: { fullName: 'A', phone: '123', streetAddress: 'x', city: 'y', country: 'SA' } },
    });
    assert(co.status === 201, `checkout failed: ${co.status} ${JSON.stringify(co.json)}`);
    const orderId = co.json.data?.id || co.json.data?.order?.id;
    assert(orderId, 'no order id returned');
    const row = await prisma.order.findUnique({ where: { id: orderId }, select: { regionId: true } });
    assert(row.regionId === sa.id, `order region should be SA, got ${row.regionId}`);
  });

  await test('analytics revenue: combined >= UAE-scoped and SA-scoped', async () => {
    const all = await req('GET', '/admin/analytics/revenue?preset=all_time', { token: adminToken });
    const uaeR = await req('GET', '/admin/analytics/revenue?preset=all_time&region=UAE', { token: adminToken });
    const saR = await req('GET', '/admin/analytics/revenue?preset=all_time&region=SA', { token: adminToken });
    assert(all.status === 200 && uaeR.status === 200 && saR.status === 200, 'analytics calls failed');
    const allCount = all.json.data.summary.activeOrderCount + all.json.data.summary.cancelledOrderCount;
    const uaeCount = uaeR.json.data.summary.activeOrderCount + uaeR.json.data.summary.cancelledOrderCount;
    const saCount = saR.json.data.summary.activeOrderCount + saR.json.data.summary.cancelledOrderCount;
    assert(allCount >= uaeCount && allCount >= saCount, 'combined should be >= scoped');
    assert(allCount === uaeCount + saCount, `combined (${allCount}) should equal UAE (${uaeCount}) + SA (${saCount}) when only 2 regions exist`);
    assert(saR.json.data.range.region === 'SA', 'range.region should echo SA');
    assert(all.json.data.range.region === null, 'combined range.region should be null');
  });

  await test('analytics KPI + category-sales accept region filter without error', async () => {
    const kpi = await req('GET', '/admin/analytics/kpi?preset=all_time&region=SA', { token: adminToken });
    const cat = await req('GET', '/admin/analytics/revenue/by-category?preset=all_time&region=UAE', { token: adminToken });
    assert(kpi.status === 200, `kpi failed: ${kpi.status} ${JSON.stringify(kpi.json)}`);
    assert(cat.status === 200, `category-sales failed: ${cat.status} ${JSON.stringify(cat.json)}`);
  });

  // ---------------- BACKWARD COMPAT ----------------
  await test('existing catalog stayed visible (backfill: published + both regions)', async () => {
    const r = await req('GET', '/products?limit=100', { region: 'UAE' });
    assert(r.status === 200 && r.json.data.length > 0, 'storefront product list empty — backfill problem');
  });

  // ---------------- CLEANUP ----------------
  await test('cleanup created test data', async () => {
    await prisma.section.deleteMany({ where: { title: { startsWith: 'RGN ' } } });
    await prisma.bannerImage.deleteMany({ where: { url: 'https://example.com/rgn-banner.jpg' } });
    await prisma.category.deleteMany({ where: { title: { startsWith: 'RGN Cat' } } });
    await prisma.order.deleteMany({ where: { items: { some: { product: { title: { startsWith: 'RGN ' } } } } } });
    await prisma.product.deleteMany({ where: { title: { startsWith: 'RGN ' } } });
    await prisma.product.deleteMany({ where: { title: 'Bad' } });
    await prisma.user.deleteMany({ where: { email: saUserEmail } });
  });

  console.log(`\n=== Passed: ${passed}, Failed: ${failed}, Total: ${passed + failed} ===`);
  if (failed > 0) console.log('Failed tests:', failures.join(', '));
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error('runner error:', e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
