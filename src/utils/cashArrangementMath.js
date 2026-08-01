/**
 * Pure cash-arrangement fee math — NO dependencies, NO DB (mirrors vatMath.js's separation
 * of pure math from DB-backed resolution). Kept separate so it can be unit tested directly
 * (see scripts/cash-arrangement-math-verify.js) and reused anywhere a fee is previewed.
 *
 * FEE FORMULA (confirmed by the business): the admin sets a step size and a margin %, and
 * the fee grows in a flat staircase — NOT a single flat rate on the whole amount:
 *   incrementPerStep = feeStepAmount * feeMarginPercent / 100
 *   stepNumber        = ceil(cashAmount / feeStepAmount)   — UPPER-INCLUSIVE brackets, i.e.
 *                        an amount exactly equal to feeStepAmount is step 1, not step 2
 *   fee               = round2(stepNumber * incrementPerStep)
 * Verified examples (feeStepAmount=100, feeMarginPercent=20): 100->20, 101->40, 350->80, 570->120.
 *
 * PRECEDENCE CHAIN for resolving WHICH schedule applies (most specific wins, never
 * combined/averaged):
 *   productZone ?? productRegion ?? product ?? categoryZone ?? categoryRegion ?? category
 *     ?? zoneFlat ?? regionFlat
 * The last two are the admin's simple, item-agnostic setup: a FLAT per-zone fee
 * (DeliveryZone) and a FLAT per-region fee (CashArrangementConfig), set right on the Cash
 * Arrangement admin page. They form the base of the chain — any of the six product/category
 * tiers above (edited on the product/category pages) overrides them when present. A tier only
 * counts when BOTH feeStepAmount AND feeMarginPercent are set (a matched pair the admin chose
 * together) — a malformed single-field tier is skipped, not a failure of the whole chain.
 * Every tier is optional; if nothing resolves, cash arrangement is simply not offered.
 */
const { round2 } = require('./vatMath');

/**
 * @param {number} cashAmount
 * @param {{feeStepAmount: number, feeMarginPercent: number}|null|undefined} schedule
 * @returns {number} the fee, rounded to 2dp. 0 if cashAmount/schedule is missing or invalid.
 */
function computeCashArrangementFee(cashAmount, schedule) {
  const amount = Number(cashAmount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (!schedule) return 0;

  const step = Number(schedule.feeStepAmount);
  const margin = Number(schedule.feeMarginPercent);
  if (!Number.isFinite(step) || step <= 0) return 0;
  if (!Number.isFinite(margin) || margin < 0) return 0;

  // FP-safety: dividing in integer CENTS means an exact bracket boundary (e.g. cashAmount
  // === feeStepAmount * 3) can never drift to the wrong step from float dust — the same
  // class of guard vatMath.round2's own doc comment calls out for money math.
  const amountCents = Math.round(round2(amount) * 100);
  const stepCents = Math.round(round2(step) * 100);
  const stepNumber = Math.ceil(amountCents / stepCents);
  const incrementPerStep = round2((step * margin) / 100);
  return round2(stepNumber * incrementPerStep);
}

/**
 * Atomic-pair override chain — see file header. Returns the first tier (in precedence
 * order) where BOTH fields are a valid, positive/non-negative pair, else null.
 * @param {{productZone?, productRegion?, product?, categoryZone?, categoryRegion?, category?, zoneFlat?, regionFlat?}} tiers
 *   each tier is `{feeStepAmount, feeMarginPercent}|null|undefined`
 * @returns {{feeStepAmount: number, feeMarginPercent: number}|null}
 */
function resolveCashArrangementFeeInputs({
  productZone = null,
  productRegion = null,
  product = null,
  categoryZone = null,
  categoryRegion = null,
  category = null,
  zoneFlat = null,
  regionFlat = null,
} = {}) {
  const tiers = [productZone, productRegion, product, categoryZone, categoryRegion, category, zoneFlat, regionFlat];
  for (const tier of tiers) {
    if (!tier || tier.feeStepAmount == null || tier.feeMarginPercent == null) continue;
    const step = Number(tier.feeStepAmount);
    const margin = Number(tier.feeMarginPercent);
    if (Number.isFinite(step) && step > 0 && Number.isFinite(margin) && margin >= 0) {
      return { feeStepAmount: round2(step), feeMarginPercent: round2(margin) };
    }
    // Malformed/partial tier (shouldn't happen if writes are validated via
    // parseCashArrangementFeeSchedule below, but never let a corrupt row abort the
    // whole chain) — keep walking to the next tier instead.
  }
  return null;
}

/**
 * Admin-write validator for a {feeStepAmount, feeMarginPercent} pair (Product, Category, and
 * each ProductRegion/CategoryRegion/ProductZone/CategoryZone entry). Both-or-neither: a lone
 * step or lone margin is rejected rather than silently saved as a half-valid schedule.
 * @returns {{feeStepAmount: number|null, feeMarginPercent: number|null}}
 */
function parseCashArrangementFeeSchedule({ feeStepAmount, feeMarginPercent } = {}) {
  const hasStep = feeStepAmount !== null && feeStepAmount !== undefined && feeStepAmount !== '';
  const hasMargin = feeMarginPercent !== null && feeMarginPercent !== undefined && feeMarginPercent !== '';
  if (!hasStep && !hasMargin) return { feeStepAmount: null, feeMarginPercent: null };
  if (hasStep !== hasMargin) {
    throw Object.assign(
      new Error('feeStepAmount and feeMarginPercent must be set together (both or neither)'),
      { code: 'VALIDATION' }
    );
  }
  const step = Number(feeStepAmount);
  const margin = Number(feeMarginPercent);
  if (!Number.isFinite(step) || step <= 0) {
    throw Object.assign(new Error('cashArrangementFeeStepAmount must be a positive number'), { code: 'VALIDATION' });
  }
  // Matches the Decimal(10,2) column's real capacity (mirrors the same max: 99999999.99
  // bound already used for price-like fields elsewhere, e.g. product.routes.js) — catches
  // an obvious fat-finger value at save time with a clear message, rather than a raw
  // Postgres "numeric field overflow" the next time this row is read/written.
  if (step > 99999999.99) {
    throw Object.assign(new Error('cashArrangementFeeStepAmount must be 99999999.99 or less'), { code: 'VALIDATION' });
  }
  if (!Number.isFinite(margin) || margin < 0) {
    throw Object.assign(new Error('cashArrangementFeeMarginPercent must be zero or a positive number'), { code: 'VALIDATION' });
  }
  // No natural 100% ceiling here (unlike a discount rate) — a margin > 100% is a legitimate
  // way to make the fee grow faster than the step size. Still cap it well below anything
  // that could realistically combine with a valid cash amount to overflow the order total
  // (that overflow is ALSO caught at order-creation time regardless — see order.service.js —
  // this is just an earlier, clearer error for an obvious admin typo).
  if (margin > 1000) {
    throw Object.assign(new Error('cashArrangementFeeMarginPercent must be 1000 or less'), { code: 'VALIDATION' });
  }
  return { feeStepAmount: round2(step), feeMarginPercent: round2(margin) };
}

/**
 * Admin-write validator for a quick-pick-amounts / denominations list — shared by
 * cashArrangement.service.js (region-level CashArrangementConfig) and
 * deliveryZone.service.js (zone-level override on DeliveryZone). Dedupes, sorts, and
 * requires positive whole numbers. Returns undefined (not present in the payload —
 * caller should not touch the field) when `value` itself is undefined, so both callers
 * can use their own "only set if present" partial-update convention.
 * @param {unknown} value
 * @param {{fieldName: string, max?: number}} opts
 * @returns {number[]|undefined}
 */
function parseCashArrangementAmountList(value, { fieldName, max = 20 }) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw Object.assign(new Error(`${fieldName} must be an array of positive whole numbers`), {
      code: 'CASH_ARRANGEMENT_INVALID_LIST',
      status: 400,
    });
  }
  const nums = [...new Set(value.map((v) => Number(v)))];
  if (nums.length > max) {
    throw Object.assign(new Error(`${fieldName} may contain at most ${max} values`), {
      code: 'CASH_ARRANGEMENT_INVALID_LIST',
      status: 400,
    });
  }
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw Object.assign(new Error(`${fieldName} must contain only positive whole numbers`), {
      code: 'CASH_ARRANGEMENT_INVALID_LIST',
      status: 400,
    });
  }
  return nums.sort((a, b) => a - b);
}

module.exports = {
  computeCashArrangementFee,
  resolveCashArrangementFeeInputs,
  parseCashArrangementFeeSchedule,
  parseCashArrangementAmountList,
};
