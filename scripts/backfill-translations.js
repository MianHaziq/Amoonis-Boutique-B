#!/usr/bin/env node
/**
 * Backfill bilingual fields for rows created before auto-translation was enabled.
 *
 * Scans Section, Category, Product, ProductDescription, ProductOption, PromoCode for rows
 * where one of the en/_ar twins is filled and the other is null/empty, then fills the
 * missing side via Azure Translator. Idempotent — safe to re-run after partial failures.
 *
 * Usage:
 *   node scripts/backfill-translations.js                # backfill everything
 *   node scripts/backfill-translations.js --dry-run      # report only, no DB writes
 *   node scripts/backfill-translations.js --model Product  # one table only
 *   node scripts/backfill-translations.js --limit 50     # cap rows per table
 */

require('dotenv').config();

const prisma = require('../src/config/db');
const { autoTranslate, autoTranslateMany } = require('../src/utils/bilingual');
const { isEnabled, getStatus } = require('../src/services/translation.service');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const modelArg = readFlag('--model');
const limitArg = readFlag('--limit');
const limit = limitArg ? Math.max(1, parseInt(limitArg, 10)) : null;

function readFlag(name) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : null;
}

function shouldRun(model) {
  return !modelArg || modelArg.toLowerCase() === model.toLowerCase();
}

function missingTwin(row, src, dst) {
  const a = row[src];
  const b = row[dst];
  return (a && !b) || (!a && b);
}

const stats = {
  scanned: 0,
  translated: 0,
  skipped: 0,
  failed: 0,
  byModel: {},
};

function track(model, key) {
  if (!stats.byModel[model]) stats.byModel[model] = { translated: 0, scanned: 0 };
  stats.byModel[model][key]++;
}

async function backfillCategories() {
  if (!shouldRun('Category')) return;
  const rows = await prisma.category.findMany({
    where: {
      OR: [
        { AND: [{ title: { not: null } }, { title_ar: null }] },
        { AND: [{ title_ar: { not: null } }, { title: null }] },
        { AND: [{ description: { not: null } }, { description_ar: null }] },
        { AND: [{ description_ar: { not: null } }, { description: null }] },
      ],
    },
    take: limit ?? undefined,
  });
  console.log(`[backfill] Category: ${rows.length} candidate rows`);
  for (const row of rows) {
    track('Category', 'scanned');
    stats.scanned++;
    const draft = {
      title: row.title, title_ar: row.title_ar,
      description: row.description, description_ar: row.description_ar,
    };
    try {
      await autoTranslate(draft, [
        { src: 'title', dst: 'title_ar' },
        { src: 'description', dst: 'description_ar' },
      ]);
      if (!dryRun) {
        await prisma.category.update({
          where: { id: row.id },
          data: {
            title: draft.title, title_ar: draft.title_ar,
            description: draft.description, description_ar: draft.description_ar,
          },
        });
      }
      track('Category', 'translated'); stats.translated++;
    } catch (e) {
      console.error(`[backfill] Category ${row.id} failed:`, e.message);
      stats.failed++;
    }
  }
}

async function backfillSections() {
  if (!shouldRun('Section')) return;
  const rows = await prisma.section.findMany({
    where: {
      OR: [
        { AND: [{ title: { not: null } }, { title_ar: null }] },
        { AND: [{ title_ar: { not: null } }, { title: null }] },
      ],
    },
    take: limit ?? undefined,
  });
  console.log(`[backfill] Section: ${rows.length} candidate rows`);
  for (const row of rows) {
    track('Section', 'scanned'); stats.scanned++;
    const draft = { title: row.title, title_ar: row.title_ar };
    try {
      await autoTranslate(draft, [{ src: 'title', dst: 'title_ar' }]);
      if (!dryRun) {
        await prisma.section.update({ where: { id: row.id }, data: draft });
      }
      track('Section', 'translated'); stats.translated++;
    } catch (e) {
      console.error(`[backfill] Section ${row.id} failed:`, e.message);
      stats.failed++;
    }
  }
}

async function backfillProducts() {
  if (!shouldRun('Product')) return;
  const rows = await prisma.product.findMany({
    where: {
      OR: [
        { AND: [{ title: { not: null } }, { title_ar: null }] },
        { AND: [{ title_ar: { not: null } }, { title: null }] },
        { AND: [{ subtitle: { not: null } }, { subtitle_ar: null }] },
        { AND: [{ subtitle_ar: { not: null } }, { subtitle: null }] },
      ],
    },
    take: limit ?? undefined,
  });
  console.log(`[backfill] Product: ${rows.length} candidate rows`);
  for (const row of rows) {
    track('Product', 'scanned'); stats.scanned++;
    const draft = {
      title: row.title, title_ar: row.title_ar,
      subtitle: row.subtitle, subtitle_ar: row.subtitle_ar,
    };
    try {
      await autoTranslate(draft, [
        { src: 'title', dst: 'title_ar' },
        { src: 'subtitle', dst: 'subtitle_ar' },
      ]);
      if (!dryRun) {
        await prisma.product.update({ where: { id: row.id }, data: draft });
      }
      track('Product', 'translated'); stats.translated++;
    } catch (e) {
      console.error(`[backfill] Product ${row.id} failed:`, e.message);
      stats.failed++;
    }
  }
}

async function backfillProductDescriptions() {
  if (!shouldRun('ProductDescription')) return;
  const rows = await prisma.productDescription.findMany({
    where: {
      OR: [
        { AND: [{ title: { not: null } }, { title_ar: null }] },
        { AND: [{ title_ar: { not: null } }, { title: null }] },
        { AND: [{ description: { not: null } }, { description_ar: null }] },
        { AND: [{ description_ar: { not: null } }, { description: null }] },
      ],
    },
    take: limit ?? undefined,
  });
  console.log(`[backfill] ProductDescription: ${rows.length} candidate rows`);
  if (rows.length === 0) return;
  // Group rows together for a single batched call when reasonable (50 at a time).
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const drafts = batch.map((row) => ({
      _id: row.id,
      title: row.title, title_ar: row.title_ar,
      description: row.description, description_ar: row.description_ar,
    }));
    try {
      await autoTranslateMany(drafts, [
        { src: 'title', dst: 'title_ar' },
        { src: 'description', dst: 'description_ar' },
      ]);
      for (const d of drafts) {
        track('ProductDescription', 'scanned'); stats.scanned++;
        if (!dryRun) {
          await prisma.productDescription.update({
            where: { id: d._id },
            data: {
              title: d.title, title_ar: d.title_ar,
              description: d.description, description_ar: d.description_ar,
            },
          });
        }
        track('ProductDescription', 'translated'); stats.translated++;
      }
    } catch (e) {
      console.error('[backfill] ProductDescription chunk failed:', e.message);
      stats.failed += batch.length;
    }
  }
}

async function backfillProductOptions() {
  if (!shouldRun('ProductOption')) return;
  const rows = await prisma.productOption.findMany({
    where: {
      OR: [
        { AND: [{ title: { not: null } }, { title_ar: null }] },
        { AND: [{ title_ar: { not: null } }, { title: null }] },
      ],
    },
    take: limit ?? undefined,
  });
  console.log(`[backfill] ProductOption: ${rows.length} candidate rows`);
  for (const row of rows) {
    track('ProductOption', 'scanned'); stats.scanned++;
    const draft = {
      title: row.title, title_ar: row.title_ar,
      options: row.options, options_ar: row.options_ar,
    };
    try {
      await autoTranslate(draft, [
        { src: 'title', dst: 'title_ar' },
        { src: 'options', dst: 'options_ar', kind: 'arrayOfString' },
      ]);
      if (!dryRun) {
        await prisma.productOption.update({ where: { id: row.id }, data: draft });
      }
      track('ProductOption', 'translated'); stats.translated++;
    } catch (e) {
      console.error(`[backfill] ProductOption ${row.id} failed:`, e.message);
      stats.failed++;
    }
  }
}

async function backfillPromoCodes() {
  if (!shouldRun('PromoCode')) return;
  const rows = await prisma.promoCode.findMany({
    where: {
      OR: [
        { AND: [{ name: { not: null } }, { name_ar: null }] },
        { AND: [{ name_ar: { not: null } }, { name: null }] },
        { AND: [{ description: { not: null } }, { description_ar: null }] },
        { AND: [{ description_ar: { not: null } }, { description: null }] },
      ],
    },
    take: limit ?? undefined,
  });
  console.log(`[backfill] PromoCode: ${rows.length} candidate rows`);
  for (const row of rows) {
    track('PromoCode', 'scanned'); stats.scanned++;
    const draft = {
      name: row.name, name_ar: row.name_ar,
      description: row.description, description_ar: row.description_ar,
    };
    try {
      await autoTranslate(draft, [
        { src: 'name', dst: 'name_ar' },
        { src: 'description', dst: 'description_ar' },
      ]);
      if (!dryRun) {
        await prisma.promoCode.update({ where: { id: row.id }, data: draft });
      }
      track('PromoCode', 'translated'); stats.translated++;
    } catch (e) {
      console.error(`[backfill] PromoCode ${row.id} failed:`, e.message);
      stats.failed++;
    }
  }
}

async function main() {
  console.log('[backfill] Translation provider status:', getStatus());
  if (!isEnabled()) {
    console.error('[backfill] Translation provider is disabled — set TRANSLATION_PROVIDER=azure and AZURE_TRANSLATOR_KEY in env, then re-run.');
    process.exit(1);
  }
  if (dryRun) console.log('[backfill] DRY-RUN: no DB writes will occur.');

  const t0 = Date.now();
  await backfillCategories();
  await backfillSections();
  await backfillProducts();
  await backfillProductDescriptions();
  await backfillProductOptions();
  await backfillPromoCodes();
  const ms = Date.now() - t0;

  console.log('\n[backfill] DONE');
  console.log(`  total scanned:    ${stats.scanned}`);
  console.log(`  total translated: ${stats.translated}`);
  console.log(`  total failed:     ${stats.failed}`);
  console.log(`  elapsed:          ${ms} ms`);
  console.log('  by model:        ', stats.byModel);
}

main()
  .catch((e) => { console.error('[backfill] fatal:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
