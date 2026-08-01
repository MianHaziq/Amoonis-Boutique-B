/**
 * Stable, normalized serialization of a `selectedOptions` map, used as the cart's
 * variant discriminator so the SAME product chosen in different variants (e.g.
 * Black vs White) forms distinct cart lines instead of overwriting one line.
 *
 * Deterministic — keys are sorted and empty values dropped — and byte-for-byte
 * identical to the frontend's `variantKeyOf()` so client and server always agree
 * on a line's identity. Returns "" when there is no meaningful selection, which
 * also matches legacy rows (added before this existed) and no-variant products.
 */
function variantKeyOf(selectedOptions) {
  if (
    !selectedOptions ||
    typeof selectedOptions !== 'object' ||
    Array.isArray(selectedOptions)
  ) {
    return '';
  }
  const keys = Object.keys(selectedOptions)
    .filter((k) => selectedOptions[k] != null && String(selectedOptions[k]).trim() !== '')
    .sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${String(selectedOptions[k]).trim()}`).join('|');
}

/**
 * A cart LINE's full discriminator: the variant (colour/size) PLUS the per-line
 * add-on selections that make a line distinct — the personalized custom name, the
 * "include a gift card?" toggle, the gift card's message, AND the per-unit cash
 * arrangement (amount / denomination / note). They make a line distinct the same
 * way a colour does, so the same product+variant added with a DIFFERENT name
 * ("Osama" vs "Ali"), a DIFFERENT gift-card message, one line with a gift card and
 * one without, or a DIFFERENT cash amount (500 vs 1000 vs none), forms separate
 * lines instead of the last add overwriting the first. This is what makes
 * personalization PER-UNIT: qty-N is added as N one-quantity configs, and identical
 * configs merge back into one line while distinct ones stay separate.
 *
 * Folded into the stored `variantKey` so every existing line-targeting path —
 * update/remove/message and the `@@unique([cartId, productId, variantKey])`
 * constraint — keeps working with no migration. Byte-for-byte identical to the
 * frontend's `lineVariantKey()` (same segment order + encoding).
 *
 * @param {{cashAmount?: number, denomination?: number|null, note?: string|null}|null} [cashArrangement]
 */
function lineVariantKey(selectedOptions, customName, giftCardSelected, giftMessage, cashArrangement) {
  const base = variantKeyOf(selectedOptions);
  const segments = [];
  const name = String(customName == null ? '' : customName).trim();
  // Encode the free-text name/message so they can't contain the segment
  // delimiters ("|", "=") and forge another segment — e.g. a literal name
  // "X|__gc=1" must NOT collide with name "X" + gift card. encodeURIComponent is
  // identical in Node and the browser, preserving client/server key parity.
  if (name) segments.push(`__name=${encodeURIComponent(name)}`);
  if (giftCardSelected) segments.push('__gc=1');
  const message = String(giftMessage == null ? '' : giftMessage).trim();
  if (message) segments.push(`__gm=${encodeURIComponent(message)}`);
  // Per-unit cash arrangement. Amount normalized to 2dp integer-cents-then-back so
  // 500 and 500.00 collapse to the same segment (identical Math on both runtimes).
  if (cashArrangement && Number(cashArrangement.cashAmount) > 0) {
    const amt = Math.round(Number(cashArrangement.cashAmount) * 100) / 100;
    segments.push(`__ca=${amt}`);
    if (cashArrangement.denomination != null && Number(cashArrangement.denomination) > 0) {
      segments.push(`__cad=${Math.trunc(Number(cashArrangement.denomination))}`);
    }
    const cnote = String(cashArrangement.note == null ? '' : cashArrangement.note).trim();
    if (cnote) segments.push(`__can=${encodeURIComponent(cnote)}`);
  }
  if (segments.length === 0) return base;
  const extra = segments.join('|');
  return base ? `${base}|${extra}` : extra;
}

module.exports = { variantKeyOf, lineVariantKey };
