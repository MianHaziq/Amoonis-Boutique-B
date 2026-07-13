/**
 * Pure VAT math — NO dependencies, NO DB. Kept separate from vat.service so it can be unit
 * tested in isolation (scripts/vat-verify.js) and reused anywhere a total is previewed.
 *
 * VAT is charged on the NET (post-discount) amount. An order-level discount is allocated
 * across lines in proportion to each line's gross total, then VAT is applied per taxable line.
 *   • EXCLUSIVE (inclusive=false): VAT is ADDED on top → increases the total.
 *   • INCLUSIVE (inclusive=true): the price already contains the VAT → total unchanged, we
 *     only EXTRACT the tax portion for reporting.
 */

function round2(n) {
  // Guard against FP dust before rounding (e.g. 4.005 → 4.01, not 4.00).
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * @param {{appliesTo:string, productIds:Set<string>, categoryIds:Set<string>}} scope
 * @param {{productId:string|null, categoryId:string|null}} line
 */
function isLineTaxable(scope, line) {
  switch (scope.appliesTo) {
    case 'ALL_PRODUCTS':
      return true;
    case 'SPECIFIC_PRODUCTS':
      return line.productId != null && scope.productIds.has(line.productId);
    case 'SPECIFIC_CATEGORIES':
      return line.categoryId != null && scope.categoryIds.has(line.categoryId);
    default:
      return false;
  }
}

/**
 * Allocate a total discount across lines in proportion to each line's gross total. Uses the
 * largest-remainder method so the allocated parts sum EXACTLY to `discount` (no drift), and
 * never allocates more than a line's own gross.
 *
 * @param {number[]} lineGross per-line gross totals (price * qty)
 * @param {number} discount    total order discount (>= 0)
 * @returns {number[]} per-line discount, each 2dp, summing to round2(min(discount, total))
 */
function allocateDiscount(lineGross, discount) {
  const n = lineGross.length;
  const out = new Array(n).fill(0);
  const total = lineGross.reduce((s, g) => s + g, 0);
  const target = round2(Math.min(discount, total));
  if (n === 0 || target <= 0 || total <= 0) return out;

  const targetCents = Math.round(target * 100);
  const raw = lineGross.map((g) => (g / total) * targetCents);
  const floor = raw.map((r) => Math.floor(r));
  const allocated = floor.reduce((s, c) => s + c, 0);
  let leftover = targetCents - allocated;

  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);

  const cents = floor.slice();
  for (let k = 0; k < order.length && leftover > 0; k++) {
    cents[order[k].i] += 1;
    leftover -= 1;
  }
  for (let i = 0; i < n; i++) {
    const grossCents = Math.round(lineGross[i] * 100);
    out[i] = Math.min(cents[i], grossCents) / 100;
  }
  return out;
}

/**
 * PURE VAT computation.
 *
 * @param {Array<{productId:string|null, categoryId:string|null, quantity:number, unitPrice:number}>} lines
 * @param {number} discountAmount order-level discount already computed (>= 0)
 * @param {{enabled:boolean, ratePercent:number, inclusive:boolean, appliesTo:string,
 *          productIds?:Iterable<string>, categoryIds?:Iterable<string>}|null} config
 * @returns {{applied:boolean, ratePercent:number, inclusive:boolean, subtotal:number,
 *   discountAmount:number, taxableBase:number, vatAmount:number, addedVat:number, total:number,
 *   lines:Array<{vatRatePercent:number, vatAmount:number, taxable:boolean}>}}
 */
function computeOrderVat(lines, discountAmount = 0, config = null) {
  const rate = config ? Number(config.ratePercent) || 0 : 0;
  const inclusive = Boolean(config && config.inclusive);
  const enabled = Boolean(config && config.enabled) && rate > 0;

  const lineGross = lines.map((l) => round2(Number(l.unitPrice) * Number(l.quantity)));
  const subtotal = round2(lineGross.reduce((s, g) => s + g, 0));
  const discount = round2(Math.max(0, Math.min(Number(discountAmount) || 0, subtotal)));

  if (!enabled) {
    return {
      applied: false,
      ratePercent: 0,
      inclusive: false,
      subtotal,
      discountAmount: discount,
      taxableBase: 0,
      vatAmount: 0,
      addedVat: 0,
      total: round2(subtotal - discount),
      lines: lines.map(() => ({ vatRatePercent: 0, vatAmount: 0, taxable: false })),
    };
  }

  const scope = {
    appliesTo: config.appliesTo,
    productIds: new Set(config.productIds || []),
    categoryIds: new Set(config.categoryIds || []),
  };

  const perLineDiscount = allocateDiscount(lineGross, discount);
  const factor = 1 + rate / 100;

  const lineOut = lines.map((l, i) => {
    const taxable = isLineTaxable(scope, l);
    if (!taxable) return { vatRatePercent: 0, vatAmount: 0, taxable: false };
    const net = round2(lineGross[i] - perLineDiscount[i]);
    const vat = inclusive ? round2(net - net / factor) : round2(net * (rate / 100));
    return { vatRatePercent: rate, vatAmount: vat, taxable: true };
  });

  const vatAmount = round2(lineOut.reduce((s, l) => s + l.vatAmount, 0));
  const taxableBase = round2(
    lines.reduce((s, l, i) => (lineOut[i].taxable ? s + (lineGross[i] - perLineDiscount[i]) : s), 0)
  );
  const addedVat = inclusive ? 0 : vatAmount;
  const total = round2(subtotal - discount + addedVat);

  return {
    applied: vatAmount > 0,
    ratePercent: rate,
    inclusive,
    subtotal,
    discountAmount: discount,
    taxableBase,
    vatAmount,
    addedVat,
    total,
    lines: lineOut,
  };
}

module.exports = { round2, isLineTaxable, allocateDiscount, computeOrderVat };
