/**
 * One-off seed: set the "Flowers" category's product prep/booking lead time
 * (Category.deliveryLeadDays = 2 days) so every flower product falls through to a
 * 2-day estimate instead of the global default — flowers need real prep time (sourcing/
 * arranging fresh stock), unlike gift boxes or other categories which are fine with the
 * store's normal 1-day default (Settings.defaultDeliveryLeadDays).
 *
 * This is business DATA, not schema — deliberately NOT baked into the
 * 20260723000000_add_delivery_lead_days migration. Run this once, whenever, against
 * whichever DATABASE_URL is active.
 *
 * Matching: checked the live catalogue directly (read-only) — categories are exactly
 * "Flower Bouquets", "Flower Mugs", "Gift Boxes", "Newborn Gifts". A naive "contains
 * 'flower'" match would WRONGLY catch "Flower Mugs" too (a printed mug/cup gift item,
 * not an actual fresh-flower arrangement — it doesn't need floral prep time, it belongs
 * with everything else on the 1-day default). So this matches the EXACT title "Flower
 * Bouquets" (case-insensitive) only, not a substring. If the catalogue's flower category
 * gets renamed later, update FLOWER_TITLE_EXACT below — the script prints every match
 * it finds before touching anything either way.
 *
 * Idempotent: safe to re-run. Only writes rows whose deliveryLeadDays isn't already 2;
 * a no-op re-run touches nothing. Every OTHER category is left completely untouched —
 * still null (its default from the migration), which falls through the resolution
 * chain to Settings.defaultDeliveryLeadDays (1 day) — covers gift boxes and everything
 * else, per the intended "boxes and other keep it 1 day" behavior.
 *
 * NOT executed automatically by anything (not wired into package.json scripts, not run
 * in CI/deploy). A human runs this deliberately, once, e.g.:
 *   DATABASE_URL="postgresql://postgres@localhost:5432/amoonis_dev" node scripts/seed-flowers-delivery-lead-days.js
 *
 * Do NOT point this at the live Railway production DATABASE_URL until you've reviewed
 * the printed match list against the real admin catalogue and are ready to apply it.
 */
require('dotenv').config({ quiet: true });
const prisma = require('../src/config/db');

const FLOWERS_DELIVERY_LEAD_DAYS = 2;
// Exact (case-insensitive) title match — see the header comment on why this is NOT a
// substring match (would wrongly also catch "Flower Mugs").
const FLOWER_TITLE_EXACT = 'Flower Bouquets';

(async () => {
  try {
    const candidates = await prisma.category.findMany({
      where: { title: { equals: FLOWER_TITLE_EXACT, mode: 'insensitive' } },
      select: { id: true, title: true, deliveryLeadDays: true },
    });

    if (candidates.length === 0) {
      console.log(
        `✗ No category found titled exactly "${FLOWER_TITLE_EXACT}" (case-insensitive). ` +
          `Nothing to do — check the exact category name in the admin panel and adjust FLOWER_TITLE_EXACT if needed.`
      );
      process.exit(0);
    }

    console.log(`Found ${candidates.length} matching categor${candidates.length === 1 ? 'y' : 'ies'}:`);
    for (const c of candidates) {
      console.log(`  - "${c.title}" (id=${c.id}), current deliveryLeadDays=${c.deliveryLeadDays ?? 'null'}`);
    }
    if (candidates.length > 1) {
      console.log(
        `  ⚠ More than one category matched "${FLOWER_TITLE_EXACT}" — all of them will be set to ` +
          `${FLOWERS_DELIVERY_LEAD_DAYS} day(s) unless you edit this script to filter by id before running again.`
      );
    }

    const toUpdate = candidates.filter((c) => c.deliveryLeadDays !== FLOWERS_DELIVERY_LEAD_DAYS);
    if (toUpdate.length === 0) {
      console.log(`✓ All matching categories already have deliveryLeadDays=${FLOWERS_DELIVERY_LEAD_DAYS}. Nothing to do.`);
      process.exit(0);
    }

    for (const c of toUpdate) {
      await prisma.category.update({
        where: { id: c.id },
        data: { deliveryLeadDays: FLOWERS_DELIVERY_LEAD_DAYS },
      });
      console.log(`✓ Updated "${c.title}" -> deliveryLeadDays=${FLOWERS_DELIVERY_LEAD_DAYS}`);
    }

    console.log(
      `✓ Done. ${toUpdate.length}/${candidates.length} matching categor${toUpdate.length === 1 ? 'y' : 'ies'} updated. ` +
        `Every other category is left untouched (null -> falls through to Settings.defaultDeliveryLeadDays).`
    );
  } catch (err) {
    console.error('✗ seed-flowers-delivery-lead-days failed:', err.message);
    process.exitCode = 1;
  } finally {
    process.exit();
  }
})();
