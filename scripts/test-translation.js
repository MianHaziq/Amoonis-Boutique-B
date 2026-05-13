#!/usr/bin/env node
/**
 * Translation service smoke test.
 *
 * Two modes:
 *   - Offline (no AZURE_TRANSLATOR_KEY): asserts the kill switch — translate() returns
 *     input as-is, no network call. Use for CI without secrets.
 *   - Live (AZURE_TRANSLATOR_KEY set): runs real round-trips, measures latency,
 *     verifies cache + batching savings.
 *
 * Usage:
 *   node scripts/test-translation.js
 *   node scripts/test-translation.js --skip-bilingual   # skip helper tests
 */

require('dotenv').config();

const { translate, translateBatch, isEnabled, getStatus, _resetCache } = require('../src/services/translation.service');
const { autoTranslate, autoTranslateMany, detectLanguage } = require('../src/utils/bilingual');

const argv = process.argv.slice(2);
const skipBilingual = argv.includes('--skip-bilingual');

const t = {
  passed: 0, failed: 0,
  ok(label) { this.passed++; console.log(`  ✓ ${label}`); },
  fail(label, detail) { this.failed++; console.error(`  ✗ ${label}\n      ${detail || ''}`); },
};

function assertEq(label, actual, expected) {
  if (actual === expected) t.ok(label);
  else t.fail(label, `expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}
function assertTruthy(label, v, detail) { if (v) t.ok(label); else t.fail(label, detail); }
function assertNot(label, a, b) { if (a !== b) t.ok(label); else t.fail(label, `${JSON.stringify(a)} === ${JSON.stringify(b)}`); }

async function timed(fn) {
  const t0 = Date.now();
  const out = await fn();
  return { ms: Date.now() - t0, out };
}

async function offlineTests() {
  console.log('\n[offline] translation disabled — verifying soft-failure + detection');
  _resetCache();

  // --- Translation service kill-switch ---
  const { out: r1 } = await timed(() => translate('Hello world', { from: 'en', to: 'ar' }));
  assertEq('translate returns input string when disabled', r1.text, 'Hello world');
  assertEq('translate marks translated=false when disabled', r1.translated, false);
  assertEq('translate marks no cache hit when disabled', r1.fromCache, false);

  const r2 = await translateBatch([
    { text: 'Free shipping', from: 'en', to: 'ar' },
    { text: 'Sale ends today', from: 'en', to: 'ar' },
  ]);
  assertEq('batch returns array same length', r2.length, 2);
  assertEq('batch element 0 text preserved', r2[0].text, 'Free shipping');
  assertEq('batch element 1 text preserved', r2[1].text, 'Sale ends today');
  assertEq('batch element marks translated=false when disabled', r2[0].translated, false);

  // --- Language detector ---
  console.log('\n  detectLanguage');
  assertEq('detect EN: "Red roses"', detectLanguage('Red roses'), 'en');
  assertEq('detect AR: "ورود حمراء"', detectLanguage('ورود حمراء'), 'ar');
  assertEq('detect EN: empty string', detectLanguage(''), 'en');
  assertEq('detect EN: pure numbers', detectLanguage('12345'), 'en');
  assertEq('detect AR: mixed AR-dominant', detectLanguage('Roses ورود حمراء جميلة'), 'ar');
  assertEq('detect EN: mixed EN-dominant', detectLanguage('Red red red ورود'), 'en');

  // --- Offline routing: helper must leave admin input untouched when API is disabled ---
  console.log('\n  autoTranslate (disabled — preserves admin input as-is)');
  const t1 = { title: 'Roses bouquet', title_ar: null };
  await autoTranslate(t1, [{ src: 'title', dst: 'title_ar' }]);
  assertEq('disabled: title untouched', t1.title, 'Roses bouquet');
  assertEq('disabled: title_ar stays null', t1.title_ar, null);

  // AR text in EN slot — disabled mode should NOT move it (no translation = no routing)
  const t2 = { title: 'ورود حمراء', title_ar: null };
  await autoTranslate(t2, [{ src: 'title', dst: 'title_ar' }]);
  assertEq('disabled: AR-in-EN slot not moved', t2.title, 'ورود حمراء');
  assertEq('disabled: AR-in-EN slot, AR side stays null', t2.title_ar, null);
}

async function liveTests() {
  const provider = (process.env.TRANSLATION_PROVIDER || 'google').toLowerCase();
  console.log(`\n[live] ${provider} provider configured — running real round-trips`);
  _resetCache();

  // 1. Single translate, en → ar
  const { ms: ms1, out: r1 } = await timed(() => translate('Hello world', { from: 'en', to: 'ar' }));
  console.log(`    en→ar single call: ${ms1} ms  →  ${JSON.stringify(r1.text)}`);
  assertTruthy('en→ar produces non-empty Arabic', /\p{Script=Arabic}/u.test(r1.text), `got: ${r1.text}`);
  assertEq('first call is not from cache', r1.fromCache, false);

  // 2. Cache hit on repeat
  const { ms: ms2, out: r2 } = await timed(() => translate('Hello world', { from: 'en', to: 'ar' }));
  assertEq('second call is cache hit', r2.fromCache, true);
  assertEq('cache hit returns same text', r2.text, r1.text);
  assertTruthy('cache hit is faster than the network call', ms2 < ms1, `${ms2}ms vs ${ms1}ms`);

  // 3. Reverse direction
  const { out: r3 } = await timed(() => translate(r1.text, { from: 'ar', to: 'en' }));
  console.log(`    ar→en round-trip: ${JSON.stringify(r3.text)}`);
  assertTruthy('ar→en produces Latin text', /[A-Za-z]/.test(r3.text));

  // 4. Auto-detect
  const { out: r4 } = await timed(() => translate('مرحبا بالعالم', { to: 'en' }));
  console.log(`    auto-detect ar→en: ${JSON.stringify(r4.text)}  (detected: ${r4.sourceLang})`);
  assertEq('auto-detect identifies Arabic', r4.sourceLang, 'ar');

  // 5. Batch — measure that 10 items take ~one round-trip, not 10
  _resetCache();
  const items = [
    'Red roses', 'White lilies', 'Yellow tulips', 'Pink carnations', 'Purple orchids',
    'Sunflowers', 'Daisies', 'Peonies', 'Hydrangeas', 'Chrysanthemums',
  ];
  const { ms: msB, out: rBatch } = await timed(() =>
    translateBatch(items.map((text) => ({ text, from: 'en', to: 'ar' }))),
  );
  console.log(`    batch of 10 en→ar: ${msB} ms`);
  assertEq('batch returns 10 items', rBatch.length, 10);
  rBatch.forEach((r, i) => {
    assertTruthy(`batch[${i}] "${items[i]}" → arabic non-empty`, /\p{Script=Arabic}/u.test(r.text));
  });
  // Performance assertion: 10-item batch should be much faster than 10x single-call latency.
  // Rough heuristic — single-call took ~ms1, batch should be < 3x that.
  assertTruthy(
    `batch latency reasonable (${msB}ms < 3x single-call ${ms1}ms)`,
    msB < ms1 * 3 + 1000,
    `${msB}ms`,
  );

  // 6. Bilingual helper end-to-end — all 6 routing cases the admin can hit
  if (!skipBilingual) {
    const schema = [{ src: 'title', dst: 'title_ar' }];

    // CASE A: EN typed into EN column → keep, fill AR
    const a = { title: 'Premium gift bouquet', title_ar: null };
    await autoTranslate(a, schema);
    console.log(`    A) EN→EN slot: ${JSON.stringify(a)}`);
    assertEq('A: title kept', a.title, 'Premium gift bouquet');
    assertTruthy('A: title_ar filled with Arabic', /\p{Script=Arabic}/u.test(a.title_ar));

    // CASE B: AR typed into EN column → MOVE to AR column, fill EN with translation
    const b = { title: 'باقة ورود حمراء', title_ar: null };
    await autoTranslate(b, schema);
    console.log(`    B) AR→EN slot (routed): ${JSON.stringify(b)}`);
    assertEq('B: title_ar received the Arabic input', b.title_ar, 'باقة ورود حمراء');
    assertTruthy('B: title filled with English translation', /[A-Za-z]/.test(b.title));
    assertTruthy('B: title is not the original Arabic', !/\p{Script=Arabic}/u.test(b.title));

    // CASE C: AR typed into AR column (correct slot) → keep, fill EN
    const c = { title: null, title_ar: 'باقة ورود حمراء' };
    await autoTranslate(c, schema);
    console.log(`    C) AR→AR slot: ${JSON.stringify(c)}`);
    assertEq('C: title_ar preserved', c.title_ar, 'باقة ورود حمراء');
    assertTruthy('C: title filled with English', /[A-Za-z]/.test(c.title));

    // CASE D: EN typed into AR column → MOVE to EN column, fill AR with translation
    const d = { title: null, title_ar: 'Premium gift bouquet' };
    await autoTranslate(d, schema);
    console.log(`    D) EN→AR slot (routed): ${JSON.stringify(d)}`);
    assertEq('D: title received the English input', d.title, 'Premium gift bouquet');
    assertTruthy('D: title_ar filled with Arabic translation', /\p{Script=Arabic}/u.test(d.title_ar));

    // CASE E: both filled — manual override wins
    const e = { title: 'Custom EN', title_ar: 'Custom AR' };
    await autoTranslate(e, schema);
    assertEq('E: title untouched', e.title, 'Custom EN');
    assertEq('E: title_ar untouched', e.title_ar, 'Custom AR');

    // CASE F: both empty — nothing happens
    const f = { title: null, title_ar: null };
    await autoTranslate(f, schema);
    assertEq('F: title stays null', f.title, null);
    assertEq('F: title_ar stays null', f.title_ar, null);

    // String[] pair: EN array → fills options_ar
    const opts1 = { options: ['Small', 'Medium', 'Large'], options_ar: [] };
    await autoTranslate(opts1, [{ src: 'options', dst: 'options_ar', kind: 'arrayOfString' }]);
    console.log(`    arr) EN options → AR: ${JSON.stringify(opts1)}`);
    assertEq('options_ar length matches', opts1.options_ar.length, 3);
    opts1.options_ar.forEach((v, i) => assertTruthy(`options_ar[${i}] is Arabic`, /\p{Script=Arabic}/u.test(v)));

    // String[] pair: AR array in EN slot → MOVE
    const opts2 = { options: ['صغير', 'متوسط', 'كبير'], options_ar: [] };
    await autoTranslate(opts2, [{ src: 'options', dst: 'options_ar', kind: 'arrayOfString' }]);
    console.log(`    arr) AR options in EN slot (routed): ${JSON.stringify(opts2)}`);
    assertEq('arr-move: options_ar holds Arabic', opts2.options_ar.length, 3);
    opts2.options_ar.forEach((v, i) => assertTruthy(`arr-move: options_ar[${i}] Arabic`, /\p{Script=Arabic}/u.test(v)));
    assertEq('arr-move: options length matches', opts2.options.length, 3);
    opts2.options.forEach((v, i) => assertTruthy(`arr-move: options[${i}] is English`, /[A-Za-z]/.test(v)));

    // Bulk batched call
    const rows = [
      { title: 'Row 1', title_ar: null, description: 'First', description_ar: null },
      { title: 'Row 2', title_ar: null, description: 'Second', description_ar: null },
      { title: 'صف 3', title_ar: null, description: 'Third', description_ar: null }, // AR in EN slot
    ];
    const { ms: msMany } = await timed(() =>
      autoTranslateMany(rows, [
        { src: 'title', dst: 'title_ar' },
        { src: 'description', dst: 'description_ar' },
      ]),
    );
    console.log(`    autoTranslateMany on 3 rows × 2 fields: ${msMany} ms`);
    assertTruthy('row[0].title_ar Arabic', /\p{Script=Arabic}/u.test(rows[0].title_ar));
    assertTruthy('row[1].title_ar Arabic', /\p{Script=Arabic}/u.test(rows[1].title_ar));
    // Row 2: AR was in EN slot, should be routed
    assertEq('row[2] AR-in-EN moved to title_ar', rows[2].title_ar, 'صف 3');
    assertTruthy('row[2] title filled with English translation', /[A-Za-z]/.test(rows[2].title));
  }
}

async function main() {
  console.log('Translation service test — status:', getStatus());
  if (isEnabled()) await liveTests();
  else await offlineTests();

  console.log(`\nResults: ${t.passed} passed, ${t.failed} failed`);
  process.exit(t.failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('fatal:', e); process.exit(2); });
