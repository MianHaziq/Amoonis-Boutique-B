/**
 * Pure-math VAT verification — no DB required.
 *
 * Exercises vat.service.computeOrderVat + allocateDiscount across the scenarios that matter:
 * disabled, exclusive/inclusive, scoped (categories/products), promo-discount interaction,
 * and rounding invariants. Run: `npm run test:vat`.
 */
const vat = require('../src/utils/vatMath');

let passed = 0;
let failed = 0;

function approx(a, b, eps = 0.005) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}
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
  check(`${name} (=${expected}, got ${actual})`, approx(actual, expected));
}

// Fixtures: two lines, product p1 (cat A) @100x1, product p2 (cat B) @50x1 -> subtotal 150.
const LINES = [
  { productId: 'p1', categoryId: 'A', quantity: 1, unitPrice: 100 },
  { productId: 'p2', categoryId: 'B', quantity: 1, unitPrice: 50 },
];

console.log('VAT pure-math verification\n');

// 1) Disabled → no VAT.
console.log('1) Disabled config');
{
  const r = vat.computeOrderVat(LINES, 0, null);
  eq('vatAmount', r.vatAmount, 0);
  eq('total', r.total, 150);
  check('applied=false', r.applied === false);
}
{
  const r = vat.computeOrderVat(LINES, 0, { enabled: false, ratePercent: 5, inclusive: false, appliesTo: 'ALL_PRODUCTS' });
  eq('disabled flag → total', r.total, 150);
  eq('disabled flag → vat', r.vatAmount, 0);
}
{
  const r = vat.computeOrderVat(LINES, 0, { enabled: true, ratePercent: 0, inclusive: false, appliesTo: 'ALL_PRODUCTS' });
  eq('rate 0 → vat', r.vatAmount, 0);
}

// 2) Exclusive, ALL, 5%, no discount → VAT added on top.
console.log('\n2) Exclusive ALL 5%, no discount');
{
  const r = vat.computeOrderVat(LINES, 0, { enabled: true, ratePercent: 5, inclusive: false, appliesTo: 'ALL_PRODUCTS' });
  eq('subtotal', r.subtotal, 150);
  eq('vatAmount', r.vatAmount, 7.5);
  eq('addedVat', r.addedVat, 7.5);
  eq('total', r.total, 157.5);
  eq('line1 vat', r.lines[0].vatAmount, 5);
  eq('line2 vat', r.lines[1].vatAmount, 2.5);
  check('sum(line vat)=order vat', approx(r.lines[0].vatAmount + r.lines[1].vatAmount, r.vatAmount));
}

// 3) Inclusive, ALL, 5% → total unchanged, VAT extracted.
console.log('\n3) Inclusive ALL 5%');
{
  const r = vat.computeOrderVat(LINES, 0, { enabled: true, ratePercent: 5, inclusive: true, appliesTo: 'ALL_PRODUCTS' });
  eq('total unchanged', r.total, 150);
  eq('addedVat', r.addedVat, 0);
  // 150 - 150/1.05 = 7.142857...
  eq('vatAmount extracted', r.vatAmount, 7.14);
}

// 4) Exclusive, ALL, 5%, with a 20 discount → VAT on the NET (discounted) amount.
console.log('\n4) Exclusive ALL 5% + discount 20 (VAT on net)');
{
  const r = vat.computeOrderVat(LINES, 20, { enabled: true, ratePercent: 5, inclusive: false, appliesTo: 'ALL_PRODUCTS' });
  eq('discount clamped', r.discountAmount, 20);
  eq('taxableBase', r.taxableBase, 130); // 150 - 20
  eq('vatAmount ~ 6.50', r.vatAmount, 6.5);
  eq('total', r.total, 136.5); // 150 - 20 + 6.50
}

// 5) Scoped to categories → only lines in the category set are taxed.
console.log('\n5) SPECIFIC_CATEGORIES [A] exclusive 5%');
{
  const r = vat.computeOrderVat(LINES, 0, {
    enabled: true, ratePercent: 5, inclusive: false, appliesTo: 'SPECIFIC_CATEGORIES', categoryIds: ['A'],
  });
  eq('line1 (cat A) taxed', r.lines[0].vatAmount, 5);
  eq('line2 (cat B) untaxed', r.lines[1].vatAmount, 0);
  eq('vatAmount', r.vatAmount, 5);
  eq('total', r.total, 155);
}

// 6) Scoped to products → only listed product ids taxed.
console.log('\n6) SPECIFIC_PRODUCTS [p2] exclusive 5%');
{
  const r = vat.computeOrderVat(LINES, 0, {
    enabled: true, ratePercent: 5, inclusive: false, appliesTo: 'SPECIFIC_PRODUCTS', productIds: ['p2'],
  });
  eq('line1 (p1) untaxed', r.lines[0].vatAmount, 0);
  eq('line2 (p2) taxed', r.lines[1].vatAmount, 2.5);
  eq('vatAmount', r.vatAmount, 2.5);
  eq('total', r.total, 152.5);
}

// 7) Discount allocation invariant: allocated parts sum EXACTLY to the discount.
console.log('\n7) allocateDiscount rounding invariant');
{
  const parts = vat.allocateDiscount([33.33, 33.33, 33.34], 10);
  const sum = parts.reduce((s, p) => s + p, 0);
  eq('sum == discount', vat.round2(sum), 10);
  const parts2 = vat.allocateDiscount([100, 50, 25], 33.33);
  eq('sum2 == discount', vat.round2(parts2.reduce((s, p) => s + p, 0)), 33.33);
}

// 8) Quantity + inclusive rounding: 3 x 9.99 inclusive 5%.
console.log('\n8) Inclusive with quantity');
{
  const lines = [{ productId: 'x', categoryId: 'A', quantity: 3, unitPrice: 9.99 }];
  const r = vat.computeOrderVat(lines, 0, { enabled: true, ratePercent: 5, inclusive: true, appliesTo: 'ALL_PRODUCTS' });
  eq('subtotal', r.subtotal, 29.97);
  eq('total unchanged', r.total, 29.97);
  // 29.97 - 29.97/1.05 = 1.427...
  eq('vat extracted', r.vatAmount, 1.43);
}

// 9) Discount larger than subtotal is clamped; total floors at 0 (+ added vat 0).
console.log('\n9) Over-discount clamp');
{
  const r = vat.computeOrderVat(LINES, 999, { enabled: true, ratePercent: 5, inclusive: false, appliesTo: 'ALL_PRODUCTS' });
  eq('discount clamped to subtotal', r.discountAmount, 150);
  eq('taxableBase 0', r.taxableBase, 0);
  eq('vat 0', r.vatAmount, 0);
  eq('total 0', r.total, 0);
}

console.log(`\n${failed === 0 ? '✅' : '❌'} VAT math: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
