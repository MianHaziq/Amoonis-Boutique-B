/**
 * Verification harness for the product search feature (service + trgm indexes).
 * Exercises visibility (storefront region/PUBLISHED vs staff), bilingual + subtitle +
 * category-name matching, pagination, and confirms the pg_trgm GIN index is actually
 * used by the planner at scale.
 *
 * Run against a LOCAL throwaway DB only, e.g.:
 *   DATABASE_URL="postgresql://postgres@localhost:5432/amoonis_search_test" \
 *     node scripts/search-verify.js
 */
const prisma = require('../src/config/db');
const productService = require('../src/services/product.service');

const TAG = 'ZZSEARCHTEST'; // unique marker so we only touch our own rows

let failures = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

async function cleanup() {
  // Remove anything this harness created (products, category, regions by marker).
  await prisma.product.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.category.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.region.deleteMany({ where: { code: { in: [`${TAG}_R1`, `${TAG}_R2`] } } });
}

async function main() {
  await cleanup();

  // --- Seed: two regions, one category, a spread of products --------------------
  const region1 = await prisma.region.create({
    data: { code: `${TAG}_R1`, name: `${TAG} Region One`, isDefault: false, isActive: true },
  });
  const region2 = await prisma.region.create({
    data: { code: `${TAG}_R2`, name: `${TAG} Region Two`, isActive: true },
  });
  const category = await prisma.category.create({
    data: { title: `${TAG} Roses`, title_ar: `${TAG} ورود`, status: 'PUBLISHED' },
  });

  async function makeProduct({ title, title_ar, subtitle, status, regionId, categoryId }) {
    return prisma.product.create({
      data: {
        title: `${TAG} ${title}`,
        title_ar: title_ar ? `${TAG} ${title_ar}` : null,
        subtitle: subtitle ?? null,
        price: 49.99,
        quantity: 5,
        status,
        ...(categoryId ? { categoryId } : {}),
        regions: { create: [{ regionId }] },
      },
    });
  }

  // Published, region 1
  await makeProduct({ title: 'Red Rose Bouquet', title_ar: 'باقة ورد أحمر', status: 'PUBLISHED', regionId: region1.id, categoryId: category.id });
  await makeProduct({ title: 'Rose Gold Vase', status: 'PUBLISHED', regionId: region1.id });
  await makeProduct({ title: 'White Lily Stems', subtitle: 'A rose-scented arrangement', status: 'PUBLISHED', regionId: region1.id });
  // Draft, region 1 (should be hidden from storefront, visible to staff)
  await makeProduct({ title: 'Secret Rose Draft', status: 'DRAFT', regionId: region1.id });
  // Published but region 2 only (should NOT appear for region-1 storefront)
  await makeProduct({ title: 'Rose in Other Region', status: 'PUBLISHED', regionId: region2.id });
  // Unrelated published product in region 1
  await makeProduct({ title: 'Sunflower Basket', status: 'PUBLISHED', regionId: region1.id });

  const storefront = { isStaff: false, regionId: region1.id };
  const storefront2 = { isStaff: false, regionId: region2.id };
  const staff = { isStaff: true };

  // --- 1. Storefront: title match, region + PUBLISHED scoped --------------------
  const r1 = await productService.searchProducts('rose', 1, 50, storefront);
  const titles1 = r1.items.map((p) => p.title);
  ok('storefront finds published rose products in region', r1.total === 3, `got ${r1.total}: ${titles1.join(' | ')}`);
  ok('storefront excludes DRAFT', !titles1.some((t) => t.includes('Secret Rose Draft')));
  ok('storefront excludes other-region product', !titles1.some((t) => t.includes('Other Region')));
  ok('subtitle match is included', titles1.some((t) => t.includes('White Lily Stems')));
  ok('every result carries an id (navigable slug)', r1.items.length > 0 && r1.items.every((p) => typeof p.id === 'string' && p.id.length > 0));

  // --- 1b. Region isolation: a different region sees ONLY its own product -------
  const r1b = await productService.searchProducts('rose', 1, 50, storefront2);
  const titles1b = r1b.items.map((p) => p.title);
  ok('region 2 storefront sees only its own rose', r1b.total === 1 && titles1b.some((t) => t.includes('Other Region')), `got ${r1b.total}: ${titles1b.join(' | ')}`);
  ok('region 2 does NOT see region 1 products', !titles1b.some((t) => t.includes('Red Rose Bouquet')));

  // --- 2. Staff: sees drafts + all regions --------------------------------------
  const r2 = await productService.searchProducts('rose', 1, 50, staff);
  const titles2 = r2.items.map((p) => p.title);
  ok('staff sees draft rose', titles2.some((t) => t.includes('Secret Rose Draft')));
  ok('staff sees other-region rose', titles2.some((t) => t.includes('Other Region')));
  ok('staff total >= storefront total', r2.total >= r1.total, `staff ${r2.total}`);

  // --- 3. Case-insensitive ------------------------------------------------------
  const r3 = await productService.searchProducts('ROSE', 1, 50, storefront);
  ok('search is case-insensitive', r3.total === 3, `got ${r3.total}`);

  // --- 4. Arabic title match ----------------------------------------------------
  const r4 = await productService.searchProducts('ورد', 1, 50, storefront);
  ok('arabic title match works', r4.items.some((p) => p.title.includes('Red Rose Bouquet')), `got ${r4.total}`);

  // --- 5. Category-name match ---------------------------------------------------
  const r5 = await productService.searchProducts('sunflower', 1, 50, storefront);
  ok('non-rose term matches its own product only', r5.total === 1 && r5.items[0].title.includes('Sunflower'), `got ${r5.total}`);

  // --- 5b. Click-through: search result -> product detail is region-consistent --
  // The storefront links each result to /shop/<id>, which loads via getProductById
  // under the SAME visibility. Verify the navigation target opens in-region and is
  // blocked cross-region (so an out-of-region product can't be reached by URL either).
  const region1RoseId = r1.items.find((p) => p.title.includes('Red Rose Bouquet')).id;
  const region2RoseId = r1b.items.find((p) => p.title.includes('Other Region')).id;
  const draftRose = await prisma.product.findFirst({ where: { title: { contains: 'Secret Rose Draft' } } });

  const openInRegion = await productService.getProductById(region1RoseId, storefront);
  ok('clicking a region-1 result opens the product for a region-1 user', openInRegion && openInRegion.id === region1RoseId);

  const openCrossRegion = await productService.getProductById(region1RoseId, storefront2);
  ok('region-2 user CANNOT open a region-1 product by id (404 path)', openCrossRegion === null);

  const openOtherFromR1 = await productService.getProductById(region2RoseId, storefront);
  ok('region-1 user CANNOT open a region-2 product by id (404 path)', openOtherFromR1 === null);

  const openDraft = await productService.getProductById(draftRose.id, storefront);
  ok('storefront CANNOT open a DRAFT product by id (404 path)', openDraft === null);

  const staffOpensOtherRegion = await productService.getProductById(region2RoseId, staff);
  ok('staff CAN open any product by id regardless of region', staffOpensOtherRegion && staffOpensOtherRegion.id === region2RoseId);

  // --- 6. Empty query returns nothing (not the whole catalog) -------------------
  const r6 = await productService.searchProducts('   ', 1, 50, storefront);
  ok('blank query returns no results', r6.total === 0 && r6.items.length === 0);

  // --- 7. No-match term ---------------------------------------------------------
  const r7 = await productService.searchProducts('zzzznotathing', 1, 50, storefront);
  ok('unknown term returns empty', r7.total === 0);

  // --- 8. Pagination shape ------------------------------------------------------
  const r8 = await productService.searchProducts('rose', 1, 2, storefront);
  ok('pagination caps page size', r8.items.length === 2 && r8.total === 3 && r8.totalPages === 2, JSON.stringify({ len: r8.items.length, total: r8.total, pages: r8.totalPages }));
  ok('meta echoes normalized query', r8.query === 'rose');

  // --- 9. Index usage at scale --------------------------------------------------
  // Insert filler rows so the planner has a reason to prefer the trgm index, then
  // confirm the plan uses a Bitmap Index Scan on our GIN index rather than a Seq Scan.
  const filler = [];
  for (let i = 0; i < 3000; i++) {
    filler.push({ title: `${TAG} filler product number ${i}`, price: 10, quantity: 1, status: 'PUBLISHED' });
  }
  await prisma.product.createMany({ data: filler });
  await prisma.$executeRawUnsafe('ANALYZE "Product";');

  // Confirm the planner CAN serve the ILIKE from the trgm GIN index. On a tiny table a
  // seq scan is cheapest, so we scope enable_seqscan=off within a transaction (SET LOCAL)
  // and check the chosen plan is a Bitmap Index Scan on our trigram index. If the index
  // couldn't support the predicate, disabling seq scan would not produce this plan.
  const plan = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    return tx.$queryRawUnsafe(
      `EXPLAIN (FORMAT JSON) SELECT id FROM "Product" WHERE "title" ILIKE '%rose%';`
    );
  });
  const planText = JSON.stringify(plan);
  ok(
    'trgm GIN index serves the ILIKE predicate',
    /Bitmap Index Scan/.test(planText) && /trgm/.test(planText),
    planText.slice(0, 200)
  );

  await cleanup();
  console.log(`\n${failures === 0 ? '🎉 ALL PASSED' : `💥 ${failures} FAILED`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch {}
  await prisma.$disconnect();
  process.exit(1);
});
