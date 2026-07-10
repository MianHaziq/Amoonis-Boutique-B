#!/usr/bin/env node
/**
 * Apply the hand-written Arabic translations in scripts/data/arabic-translations.js
 * to the database. No external translation API involved.
 *
 * Safety:
 *   - Only fills fields that are currently EMPTY (null or blank) — existing
 *     Arabic content is never overwritten.
 *   - For options_ar (arrays), only fills when the array is empty/shorter than
 *     the English list.
 *   - Skips IDs that don't exist in the target DB (safe across environments).
 *   - Idempotent: a second run writes nothing.
 *
 * Usage:
 *   node scripts/apply-arabic-translations.js --dry-run   # report only
 *   node scripts/apply-arabic-translations.js             # write
 *   DATABASE_URL="postgresql://...prod..." node scripts/apply-arabic-translations.js
 */

require('dotenv').config({ quiet: true });

const prisma = require('../src/config/db');
const data = require('./data/arabic-translations');

const dryRun = process.argv.includes('--dry-run');
const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');

const TARGETS = [
  { key: 'categories', model: () => prisma.category, label: 'Category' },
  { key: 'sections', model: () => prisma.section, label: 'Section' },
  { key: 'products', model: () => prisma.product, label: 'Product' },
  { key: 'descriptions', model: () => prisma.productDescription, label: 'ProductDescription' },
  { key: 'options', model: () => prisma.productOption, label: 'ProductOption' },
  { key: 'promoCodes', model: () => prisma.promoCode, label: 'PromoCode' },
];

// Should this field be written? Only when the target is currently empty.
function fillable(row, field, value) {
  if (Array.isArray(value)) {
    const current = Array.isArray(row[field]) ? row[field].filter((s) => !blank(s)) : [];
    return current.length < value.length;
  }
  return blank(row[field]) && !blank(value);
}

(async () => {
  const stats = {};
  for (const t of TARGETS) {
    const entries = Object.entries(data[t.key] ?? {});
    stats[t.label] = { planned: entries.length, written: 0, alreadyDone: 0, notFound: 0 };

    for (const [id, fields] of entries) {
      const select = { id: true };
      for (const f of Object.keys(fields)) select[f] = true;
      const row = await t.model().findUnique({ where: { id }, select });
      if (!row) {
        stats[t.label].notFound++;
        console.warn(`  [${t.label}] ${id} not found in this DB — skipped`);
        continue;
      }

      const update = {};
      for (const [field, value] of Object.entries(fields)) {
        if (fillable(row, field, value)) update[field] = value;
      }

      if (Object.keys(update).length === 0) {
        stats[t.label].alreadyDone++;
        continue;
      }

      if (dryRun) {
        console.log(`  [${t.label}] would fill ${Object.keys(update).join(', ')} on ${id}`);
      } else {
        await t.model().update({ where: { id }, data: update });
      }
      stats[t.label].written++;
    }
  }

  console.log(dryRun ? '\nDRY-RUN summary (nothing written):' : '\nApplied:');
  console.table(stats);
  process.exit(0);
})().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
