/**
 * Backfill Product.sortOrder to match the current display order (createdAt desc).
 *
 * All products default to sortOrder 0, which makes drag-and-drop reordering
 * ambiguous across paginated admin pages. Assigning each product a distinct
 * sortOrder equal to its current rank keeps the visible order identical while
 * giving every row a stable absolute position to reorder against.
 *
 * Idempotent: safe to re-run. It simply re-numbers by the current sort order
 * (sortOrder asc, then createdAt desc) — running it again on an already-ordered
 * catalog is a no-op in effect.
 */
require('dotenv').config();
const prisma = require('../src/config/db');

(async () => {
  try {
    const products = await prisma.product.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      select: { id: true, sortOrder: true },
    });

    const updates = products
      .map((p, i) => ({ id: p.id, from: p.sortOrder, to: i }))
      .filter((u) => u.from !== u.to);

    if (updates.length === 0) {
      console.log(`✓ ${products.length} products already sequentially ordered. Nothing to do.`);
      process.exit(0);
    }

    await prisma.$transaction(
      updates.map((u) =>
        prisma.product.update({ where: { id: u.id }, data: { sortOrder: u.to } })
      )
    );

    console.log(`✓ Re-numbered ${updates.length}/${products.length} products (sortOrder 0..${products.length - 1}).`);
  } catch (err) {
    console.error('✗ Backfill failed:', err.message);
    process.exitCode = 1;
  } finally {
    process.exit();
  }
})();
