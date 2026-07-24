/**
 * Seed the two homepage rails as real, admin-manageable Sections:
 *   1. "Best sellers"  — curated from the Gift Boxes range (falls back to newest)
 *   2. "New arrivals"  — the newest published products
 *
 * Both are PUBLISHED and assigned to the default region so they show on the
 * storefront immediately, and become fully editable/reorderable in the admin
 * Sections screen. Idempotent: skips a section whose title already exists.
 */
require('dotenv').config({ quiet: true });
const prisma = require('../src/config/db');
const sectionService = require('../src/services/section.service');

async function newestProductIds(take, whereExtra = {}) {
  const rows = await prisma.product.findMany({
    where: { status: 'PUBLISHED', ...whereExtra },
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

(async () => {
  try {
    const existing = await prisma.section.findMany({ select: { title: true } });
    const have = new Set(existing.map((s) => s.title.trim().toLowerCase()));

    // Best sellers → Gift Boxes products if that category exists, else newest.
    const giftBox = await prisma.category.findFirst({
      where: { title: { contains: 'gift box', mode: 'insensitive' } },
      select: { id: true },
    });
    const bestSellerIds = giftBox
      ? await newestProductIds(8, { categoryId: giftBox.id })
      : await newestProductIds(8);

    const newArrivalIds = await newestProductIds(8);

    const plan = [
      {
        title: 'Best sellers',
        title_ar: 'الأكثر مبيعا',
        sortOrder: 0,
        productIds: bestSellerIds,
      },
      {
        title: 'New arrivals',
        title_ar: 'وصل حديثا',
        sortOrder: 1,
        productIds: newArrivalIds,
      },
    ];

    for (const s of plan) {
      if (have.has(s.title.toLowerCase())) {
        console.log(`• "${s.title}" already exists — skipped.`);
        continue;
      }
      const created = await sectionService.createSection({
        title: s.title,
        title_ar: s.title_ar,
        sortOrder: s.sortOrder,
        status: 'PUBLISHED',
        productIds: s.productIds,
        categoryIds: [],
      });
      console.log(
        `✓ Created "${created.title}" (${s.productIds.length} products, PUBLISHED, order ${s.sortOrder}).`
      );
    }
  } catch (err) {
    console.error('✗ Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    process.exit();
  }
})();
