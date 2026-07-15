/**
 * Backfill Product.giftCardEnabled / giftCardExtraPrice / customNameEnabled /
 * customNamePrice to mirror the client site's (amoonis-boutique.com) CURRENT
 * per-product configuration, verified by directly crawling all 32 live
 * products with a headless browser on 2026-07-15 (not text-scraped).
 *
 * Matched to our rows by exact product title. Two products had no confident
 * client-site match and are called out explicitly below rather than guessed
 * silently:
 *   - "Luxury Pamper & Relaxation Box" — no client-site counterpart found.
 *     Defaulted to giftCardEnabled=true (matches the 31/32 baseline), custom
 *     name off. Flagged in the log output — please confirm manually.
 *   - "test01" — not a real product (test artifact). Left untouched.
 *
 * Idempotent: safe to re-run, always re-applies the same mapping.
 */
require('dotenv').config();
const prisma = require('../src/config/db');

// title -> { giftCardEnabled, giftCardExtraPrice, customNameEnabled, customNamePrice }
const MAPPING = {
  'Luxury Self-Care Box': { giftCardEnabled: false, customNameEnabled: false },

  'New Makeup Box': { giftCardEnabled: true, customNameEnabled: false },
  'Large Bouquet with Flowers & Beauty Products': { giftCardEnabled: true, customNameEnabled: false },
  'Joy Bouquet': { giftCardEnabled: true, customNameEnabled: false },
  'Piano Bouquet': { giftCardEnabled: true, customNameEnabled: false },
  'Elegance Rose Bouquet': { giftCardEnabled: true, customNameEnabled: false },
  'Rose Symphony Bouquet': { giftCardEnabled: true, customNameEnabled: false },
  'Royal Bouquet': { giftCardEnabled: true, customNameEnabled: false },
  'Small Giveaway Box': { giftCardEnabled: true, customNameEnabled: false },
  'Medium Giveaway Box': { giftCardEnabled: true, customNameEnabled: false },
  'Large Giveaway Box': { giftCardEnabled: true, customNameEnabled: false },
  'The Elegance Cup': { giftCardEnabled: true, customNameEnabled: false },
  'Bloom Classic Cup': { giftCardEnabled: true, customNameEnabled: false },
  'Graduation Makeup Box': { giftCardEnabled: true, customNameEnabled: false },
  'Graduation Pamper & Self-Care Box': { giftCardEnabled: true, customNameEnabled: false },
  'Graduation Box 1': { giftCardEnabled: true, customNameEnabled: false },
  'Graduation Box 2': { giftCardEnabled: true, customNameEnabled: false },
  'Red Rose Graduation Bouquet – Black Wrap': { giftCardEnabled: true, customNameEnabled: false },
  'Pink Rose Graduation Bouquet – White Wrap': { giftCardEnabled: true, customNameEnabled: false },
  'White Graduation Gift Cup': { giftCardEnabled: true, customNameEnabled: false },
  'Small Graduation Giveaway Box': { giftCardEnabled: true, customNameEnabled: false },
  'Medium Graduation Giveaway Box': { giftCardEnabled: true, customNameEnabled: false },
  'Large Graduation Giveaway Box': { giftCardEnabled: true, customNameEnabled: false },
  'Little Girls Box': { giftCardEnabled: true, customNameEnabled: false },

  "Men’s Gift Cup": { giftCardEnabled: true, customNameEnabled: true, customNamePrice: 10 },
  'Black Graduation Gift Cup': { giftCardEnabled: true, customNameEnabled: true, customNamePrice: 10 },

  'Acrylic Baby Boy Box': { giftCardEnabled: true, customNameEnabled: true, customNamePrice: 20 },
  'Acrylic Baby Girl Box': { giftCardEnabled: true, customNameEnabled: true, customNamePrice: 20 },
  'Baby Girl Balloon Gift': { giftCardEnabled: true, customNameEnabled: true, customNamePrice: 20 },
  'Baby Boy Balloon Gift': { giftCardEnabled: true, customNameEnabled: true, customNamePrice: 20 },
  'Bunny Balloon Gift': { giftCardEnabled: true, customNameEnabled: true, customNamePrice: 20 },
  'Bunny Acrylic Box': { giftCardEnabled: true, customNameEnabled: true, customNamePrice: 20 },

  // No confident client-site match — flagged assumption, see header comment.
  'Luxury Pamper & Relaxation Box': { giftCardEnabled: true, customNameEnabled: false, assumed: true },
};

const SKIP_TITLES = new Set(['test01']);

(async () => {
  try {
    const products = await prisma.product.findMany({
      select: { id: true, title: true },
    });

    const updates = [];
    const unmatched = [];
    const assumed = [];

    for (const p of products) {
      if (SKIP_TITLES.has(p.title)) continue;
      const cfg = MAPPING[p.title];
      if (!cfg) {
        unmatched.push(p.title);
        continue;
      }
      if (cfg.assumed) assumed.push(p.title);
      updates.push({
        id: p.id,
        title: p.title,
        data: {
          giftCardEnabled: !!cfg.giftCardEnabled,
          giftCardExtraPrice: cfg.giftCardExtraPrice ?? null,
          customNameEnabled: !!cfg.customNameEnabled,
          customNamePrice: cfg.customNameEnabled ? (cfg.customNamePrice ?? null) : null,
        },
      });
    }

    if (updates.length === 0) {
      console.log('Nothing to update.');
      process.exit(0);
    }

    await prisma.$transaction(
      updates.map((u) => prisma.product.update({ where: { id: u.id }, data: u.data }))
    );

    console.log(`✓ Updated ${updates.length}/${products.length} products.`);
    if (assumed.length > 0) {
      console.log(`⚠ Assumed (no confident client-site match, please double-check): ${assumed.join(', ')}`);
    }
    if (unmatched.length > 0) {
      console.log(`⚠ Skipped — no mapping entry at all: ${unmatched.join(', ')}`);
    }
  } catch (err) {
    console.error('✗ Backfill failed:', err.message);
    process.exitCode = 1;
  } finally {
    process.exit();
  }
})();
