/**
 * Pure-math cash-arrangement verification — no DB required.
 *
 * Exercises cashArrangementMath.computeCashArrangementFee (the step/margin staircase
 * formula), resolveCashArrangementFeeInputs (the 6-tier precedence chain), and
 * parseCashArrangementFeeSchedule (the admin-write validator). Run: `npm run test:cash-arrangement-math`.
 */
const {
  computeCashArrangementFee,
  resolveCashArrangementFeeInputs,
  parseCashArrangementFeeSchedule,
} = require('../src/utils/cashArrangementMath');

let passed = 0;
let failed = 0;

function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}
function eq(name, actual, expected) {
  check(`${name} (=${expected}, got ${actual})`, actual === expected);
}
function throws(name, fn, expectedCode) {
  try {
    fn();
    check(name, false);
  } catch (err) {
    check(`${name} (code=${err.code})`, !expectedCode || err.code === expectedCode);
  }
}

console.log('Cash arrangement pure-math verification\n');

// 1) Confirmed worked examples: step=100, margin=20% → 100->20, 101->40, 350->80, 570->120.
console.log('1) Confirmed worked examples (step=100, margin=20%)');
{
  const schedule = { feeStepAmount: 100, feeMarginPercent: 20 };
  eq('100 -> 20 (step 1, upper-inclusive)', computeCashArrangementFee(100, schedule), 20);
  eq('101 -> 40 (step 2)', computeCashArrangementFee(101, schedule), 40);
  eq('200 -> 40 (step 2, upper-inclusive)', computeCashArrangementFee(200, schedule), 40);
  eq('350 -> 80 (step 4)', computeCashArrangementFee(350, schedule), 80);
  eq('570 -> 120 (step 6)', computeCashArrangementFee(570, schedule), 120);
}

// 2) Guards: zero/negative/non-finite cash amount, missing/malformed schedule.
console.log('\n2) Guards');
{
  const schedule = { feeStepAmount: 100, feeMarginPercent: 20 };
  eq('0 -> 0 (no request)', computeCashArrangementFee(0, schedule), 0);
  eq('negative -> 0', computeCashArrangementFee(-50, schedule), 0);
  eq('NaN -> 0', computeCashArrangementFee(NaN, schedule), 0);
  eq('null schedule -> 0', computeCashArrangementFee(100, null), 0);
  eq('undefined schedule -> 0', computeCashArrangementFee(100, undefined), 0);
  eq('zero step -> 0', computeCashArrangementFee(100, { feeStepAmount: 0, feeMarginPercent: 20 }), 0);
  eq('negative margin -> 0', computeCashArrangementFee(100, { feeStepAmount: 100, feeMarginPercent: -5 }), 0);
  eq('margin=0 -> fee 0 (valid schedule, zero increment)', computeCashArrangementFee(500, { feeStepAmount: 100, feeMarginPercent: 0 }), 0);
}

// 3) FP-boundary safety: verified real IEEE-754 drift case. Raw `0.07 / 0.01` in JS
// evaluates to 7.000000000000001 (not exactly 7) — a naive `Math.ceil(amount/step)` would
// wrongly ceil that to 8, overcharging by one whole step at an EXACT bracket boundary.
// (Confirmed by scanning step/amount combinations for `raw > n` drift; step=0.01 with
// n=7/14/28 and step=0.02 with n=7/14 are real, reproducible drift-above cases, not
// hypothetical.) The integer-cents division in computeCashArrangementFee must give the
// exact, correct step for all of these.
console.log('\n3) FP-boundary safety (integer-cents division avoids Math.ceil(amount/step) drift)');
{
  const schedule = { feeStepAmount: 0.01, feeMarginPercent: 100 }; // increment = 0.01 per step
  eq('0.07 / step 0.01 -> exactly step 7 (naive division ceils to 8)', computeCashArrangementFee(0.07, schedule), 0.07);
  eq('0.14 / step 0.01 -> exactly step 14', computeCashArrangementFee(0.14, schedule), 0.14);
  eq('0.28 / step 0.01 -> exactly step 28', computeCashArrangementFee(0.28, schedule), 0.28);
  const schedule2 = { feeStepAmount: 0.02, feeMarginPercent: 100 };
  eq('0.14 / step 0.02 -> exactly step 7', computeCashArrangementFee(0.14, schedule2), 0.14);
  // Sanity: one cent OVER an exact boundary must still bump to the next step.
  const atBoundary = computeCashArrangementFee(0.07, schedule);
  const overBoundary = computeCashArrangementFee(0.08, schedule);
  check('one cent over the boundary -> next step, strictly higher fee', overBoundary > atBoundary);
}

// 4) Precedence chain: productZone ?? productRegion ?? product ?? categoryZone ??
// categoryRegion ?? category ?? zoneFlat ?? regionFlat ?? null.
console.log('\n4) Precedence chain (resolveCashArrangementFeeInputs)');
{
  const full = {
    productZone: { feeStepAmount: 10, feeMarginPercent: 1 },
    productRegion: { feeStepAmount: 20, feeMarginPercent: 2 },
    product: { feeStepAmount: 30, feeMarginPercent: 3 },
    categoryZone: { feeStepAmount: 40, feeMarginPercent: 4 },
    categoryRegion: { feeStepAmount: 50, feeMarginPercent: 5 },
    category: { feeStepAmount: 60, feeMarginPercent: 6 },
    zoneFlat: { feeStepAmount: 70, feeMarginPercent: 7 },
    regionFlat: { feeStepAmount: 80, feeMarginPercent: 8 },
  };
  const drop = (...keys) => {
    const o = { ...full };
    for (const k of keys) o[k] = null;
    return o;
  };
  eq('productZone wins over everything', resolveCashArrangementFeeInputs(full).feeStepAmount, 10);
  eq('productRegion wins when no productZone', resolveCashArrangementFeeInputs(drop('productZone')).feeStepAmount, 20);
  eq('product wins when no zone/region', resolveCashArrangementFeeInputs(drop('productZone', 'productRegion')).feeStepAmount, 30);
  eq('categoryZone wins when no product tier at all', resolveCashArrangementFeeInputs(
    drop('productZone', 'productRegion', 'product')
  ).feeStepAmount, 40);
  eq('categoryRegion wins when no product tier, no categoryZone', resolveCashArrangementFeeInputs(
    drop('productZone', 'productRegion', 'product', 'categoryZone')
  ).feeStepAmount, 50);
  eq('category beats the flat tiers', resolveCashArrangementFeeInputs(
    drop('productZone', 'productRegion', 'product', 'categoryZone', 'categoryRegion')
  ).feeStepAmount, 60);
  eq('zoneFlat wins when no product/category tier at all', resolveCashArrangementFeeInputs(
    drop('productZone', 'productRegion', 'product', 'categoryZone', 'categoryRegion', 'category')
  ).feeStepAmount, 70);
  eq('regionFlat is the true last resort (below zoneFlat)', resolveCashArrangementFeeInputs(
    drop('productZone', 'productRegion', 'product', 'categoryZone', 'categoryRegion', 'category', 'zoneFlat')
  ).feeStepAmount, 80);
  eq('regionFlat alone resolves when it is the ONLY tier set', resolveCashArrangementFeeInputs({
    regionFlat: { feeStepAmount: 80, feeMarginPercent: 8 },
  }).feeStepAmount, 80);
  eq('zoneFlat beats regionFlat when both (and nothing else) set', resolveCashArrangementFeeInputs({
    zoneFlat: { feeStepAmount: 70, feeMarginPercent: 7 },
    regionFlat: { feeStepAmount: 80, feeMarginPercent: 8 },
  }).feeStepAmount, 70);
  check('nothing set anywhere -> null (fail closed, never a made-up default)', resolveCashArrangementFeeInputs({}) === null);
  check('all tiers explicitly null -> null', resolveCashArrangementFeeInputs({
    productZone: null, productRegion: null, product: null, categoryZone: null, categoryRegion: null, category: null, zoneFlat: null, regionFlat: null,
  }) === null);
}

// 5) Malformed/partial tier (only one of the pair set) is SKIPPED, not treated as a hard
// failure of the whole chain — the resolver keeps walking to the next tier.
console.log('\n5) Malformed tier is skipped, not fatal');
{
  const resolved = resolveCashArrangementFeeInputs({
    product: { feeStepAmount: 100, feeMarginPercent: null }, // malformed: lone step, no margin
    category: { feeStepAmount: 50, feeMarginPercent: 10 },
  });
  check('falls through past malformed product tier to category', resolved && resolved.feeStepAmount === 50);
  const resolvedZero = resolveCashArrangementFeeInputs({
    product: { feeStepAmount: 0, feeMarginPercent: 10 }, // malformed: step must be > 0
    category: { feeStepAmount: 50, feeMarginPercent: 10 },
  });
  check('falls through past invalid (step<=0) product tier to category', resolvedZero && resolvedZero.feeStepAmount === 50);
}

// 6) Admin-write validator: both-or-neither, positive step, non-negative margin, clearing.
console.log('\n6) parseCashArrangementFeeSchedule (admin-write validator)');
{
  const cleared = parseCashArrangementFeeSchedule({});
  check('both omitted -> {null, null} (no override)', cleared.feeStepAmount === null && cleared.feeMarginPercent === null);
  const clearedExplicit = parseCashArrangementFeeSchedule({ feeStepAmount: null, feeMarginPercent: null });
  check('both explicitly null -> {null, null} (clears an existing override)', clearedExplicit.feeStepAmount === null);
  const valid = parseCashArrangementFeeSchedule({ feeStepAmount: '100', feeMarginPercent: '20' });
  check('valid pair parses to numbers', valid.feeStepAmount === 100 && valid.feeMarginPercent === 20);
  throws('lone step (no margin) throws VALIDATION', () => parseCashArrangementFeeSchedule({ feeStepAmount: 100 }), 'VALIDATION');
  throws('lone margin (no step) throws VALIDATION', () => parseCashArrangementFeeSchedule({ feeMarginPercent: 20 }), 'VALIDATION');
  throws('zero step throws VALIDATION', () => parseCashArrangementFeeSchedule({ feeStepAmount: 0, feeMarginPercent: 20 }), 'VALIDATION');
  throws('negative step throws VALIDATION', () => parseCashArrangementFeeSchedule({ feeStepAmount: -10, feeMarginPercent: 20 }), 'VALIDATION');
  throws('negative margin throws VALIDATION', () => parseCashArrangementFeeSchedule({ feeStepAmount: 100, feeMarginPercent: -1 }), 'VALIDATION');
  const marginZeroOk = parseCashArrangementFeeSchedule({ feeStepAmount: 100, feeMarginPercent: 0 });
  check('margin=0 is a VALID schedule (free arrangement)', marginZeroOk.feeMarginPercent === 0);
}

console.log(`\n${failed === 0 ? '✅' : '❌'} Cash arrangement math: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
