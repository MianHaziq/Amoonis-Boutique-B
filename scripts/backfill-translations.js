#!/usr/bin/env node
/**
 * Generate the missing Arabic (or English) twin for EVERY bilingual field the
 * admin manages — products, categories, sections, promo codes, regions,
 * product descriptions/options, and historical order-item title snapshots.
 *
 * Never overwrites existing content: only fills the empty side of a pair
 * (empty = null OR blank string). Idempotent — safe to re-run any time.
 *
 * Rate-limit aware: the translation util swallows provider errors (a Google
 * per-minute 403 would otherwise silently leave rows untranslated), so this
 * script VERIFIES each row actually got filled and retries with backoff.
 *
 * Usage:
 *   node scripts/backfill-translations.js                 # fill everything
 *   node scripts/backfill-translations.js --dry-run       # report only (no API calls, no writes)
 *   node scripts/backfill-translations.js --model Product # one model only
 *   node scripts/backfill-translations.js --limit 50      # cap rows per model
 *   node scripts/backfill-translations.js --sleep 500     # ms between rows (default 300)
 *
 * Against production: DATABASE_URL="postgresql://...prod..." node scripts/backfill-translations.js
 */

require('dotenv').config({ quiet: true });

const prisma = require('../src/config/db');
const { autoTranslate } = require('../src/utils/bilingual');
const { isEnabled, getStatus } = require('../src/services/translation.service');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const modelArg = readFlag('--model');
const limitArg = readFlag('--limit');
const sleepMs = Math.max(0, parseInt(readFlag('--sleep') ?? '300', 10) || 300);
const limit = limitArg ? Math.max(1, parseInt(limitArg, 10)) : Infinity;

function readFlag(name) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const filledStr = (v) => !blank(v);

// ---------------------------------------------------------------------------
// Every bilingual model in the schema. `pairs` mirrors the autoTranslate schema
// used by the live create/update paths, so backfilled rows come out identical
// to rows the admin saves today.
// ---------------------------------------------------------------------------
const MODELS = [
  {
    name: 'Category',
    client: () => prisma.category,
    pairs: [
      { src: 'title', dst: 'title_ar' },
      { src: 'description', dst: 'description_ar' },
    ],
  },
  {
    name: 'Section',
    client: () => prisma.section,
    pairs: [{ src: 'title', dst: 'title_ar' }],
  },
  {
    name: 'Product',
    client: () => prisma.product,
    pairs: [
      { src: 'title', dst: 'title_ar' },
      { src: 'subtitle', dst: 'subtitle_ar' },
    ],
  },
  {
    name: 'ProductDescription',
    client: () => prisma.productDescription,
    pairs: [
      { src: 'title', dst: 'title_ar' },
      { src: 'description', dst: 'description_ar' },
    ],
  },
  {
    name: 'ProductOption',
    client: () => prisma.productOption,
    pairs: [
      { src: 'title', dst: 'title_ar' },
      { src: 'options', dst: 'options_ar', kind: 'arrayOfString' },
    ],
  },
  {
    name: 'PromoCode',
    client: () => prisma.promoCode,
    pairs: [
      { src: 'name', dst: 'name_ar' },
      { src: 'description', dst: 'description_ar' },
    ],
  },
  {
    name: 'Region',
    client: () => prisma.region,
    pairs: [{ src: 'name', dst: 'name_ar' }],
  },
  {
    // Historical snapshot titles on order lines (kept readable after a product
    // is deleted). Usually few rows; included so "everything" really is everything.
    name: 'OrderItem',
    client: () => prisma.orderItem,
    pairs: [{ src: 'productTitle', dst: 'productTitle_ar' }],
  },
];

// A pair still needs work when exactly one side has content. Array pairs need
// work when one array has fewer usable entries than the other.
function pairIncomplete(row, pair) {
  if (pair.kind === 'arrayOfString') {
    const a = Array.isArray(row[pair.src]) ? row[pair.src].filter(filledStr) : [];
    const b = Array.isArray(row[pair.dst]) ? row[pair.dst].filter(filledStr) : [];
    return (a.length > 0 && b.length < a.length) || (b.length > 0 && a.length < b.length);
  }
  return (filledStr(row[pair.src]) && blank(row[pair.dst]))
      || (blank(row[pair.src]) && filledStr(row[pair.dst]));
}

const rowIncomplete = (row, pairs) => pairs.some((p) => pairIncomplete(row, p));

function pairFields(pairs) {
  return pairs.flatMap((p) => [p.src, p.dst]);
}

// Provider errors are swallowed inside autoTranslate, so a rate-limited call
// looks like "nothing happened". Retry with growing waits (Google's limit is
// per-minute, so the later waits let the quota window reset).
const RETRY_WAITS_MS = [0, 5_000, 20_000, 65_000];

async function translateRowWithRetry(pairs, draft) {
  for (let attempt = 0; attempt < RETRY_WAITS_MS.length; attempt++) {
    if (RETRY_WAITS_MS[attempt] > 0) {
      console.log(`    …provider didn't fill the row (rate limit?) — waiting ${RETRY_WAITS_MS[attempt] / 1000}s and retrying`);
      await sleep(RETRY_WAITS_MS[attempt]);
    }
    await autoTranslate(draft, pairs);
    if (!rowIncomplete(draft, pairs)) return true;
  }
  return false;
}

const stats = {};
function bump(model, key, n = 1) {
  if (!stats[model]) stats[model] = { candidates: 0, translated: 0, written: 0, stillMissing: 0 };
  stats[model][key] += n;
}

async function backfillModel(model) {
  if (modelArg && modelArg.toLowerCase() !== model.name.toLowerCase()) return;

  const fields = pairFields(model.pairs);
  const select = { id: true };
  for (const f of fields) select[f] = true;

  // Fetch all rows and filter in JS — catches empty-string twins that a
  // `{ field: null }` WHERE clause would miss. All these tables are small.
  const rows = (await model.client().findMany({ select })).filter((r) =>
    rowIncomplete(r, model.pairs)
  );
  const todo = rows.slice(0, limit);
  console.log(`[backfill] ${model.name}: ${rows.length} row(s) missing a translation${todo.length < rows.length ? ` (processing ${todo.length})` : ''}`);

  if (dryRun) {
    bump(model.name, 'candidates', rows.length);
    for (const r of todo.slice(0, 5)) {
      const preview = model.pairs
        .filter((p) => pairIncomplete(r, p))
        .map((p) => `${p.src}=${JSON.stringify(r[p.src])} → ${p.dst} (missing)`)
        .join('; ');
      console.log(`    would translate ${r.id}: ${preview}`);
    }
    return;
  }

  for (const row of todo) {
    bump(model.name, 'candidates');
    const draft = {};
    for (const f of fields) draft[f] = row[f];

    const complete = await translateRowWithRetry(model.pairs, draft);

    // Persist whatever DID get filled, even on a partial fill — a re-run
    // finishes the rest (idempotent).
    const data = {};
    for (const f of fields) {
      if (JSON.stringify(draft[f]) !== JSON.stringify(row[f])) data[f] = draft[f];
    }
    if (Object.keys(data).length > 0) {
      await model.client().update({ where: { id: row.id }, data });
      bump(model.name, 'written');
      const label = draft[model.pairs[0].src] ?? row.id;
      console.log(`    ✓ ${JSON.stringify(label)} → ${JSON.stringify(draft[model.pairs[0].dst] ?? '')}`);
    }
    if (complete) bump(model.name, 'translated');
    else {
      bump(model.name, 'stillMissing');
      console.warn(`    ✗ ${row.id} still missing after retries — re-run the script later`);
    }

    await sleep(sleepMs); // gentle on the per-minute translation quota
  }
}

async function main() {
  console.log('[backfill] Translation provider:', getStatus());
  if (!dryRun && !isEnabled()) {
    console.error('[backfill] Translation provider is disabled — set TRANSLATION_PROVIDER (google|azure) and the matching API key in env, then re-run.');
    process.exit(1);
  }
  if (dryRun) console.log('[backfill] DRY-RUN: reporting only — no API calls, no DB writes.\n');

  const t0 = Date.now();
  for (const model of MODELS) {
    await backfillModel(model);
  }

  console.log('\n[backfill] DONE in', Math.round((Date.now() - t0) / 1000), 's');
  console.table(stats);
  const missing = Object.values(stats).reduce((s, m) => s + (m.stillMissing ?? 0), 0);
  if (missing > 0) {
    console.warn(`[backfill] ${missing} row(s) could not be translated (provider quota). Re-run the script to finish them.`);
    process.exitCode = 2;
  }
}

main()
  .catch((e) => { console.error('[backfill] fatal:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
