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
 * A cart LINE's full discriminator: the variant (colour/size) PLUS the two
 * per-line add-on selections that make a line distinct — the personalized custom
 * name and the "include a gift card?" toggle. They make a line distinct the same
 * way a colour does, so the same product+variant added with a DIFFERENT name
 * ("Osama" vs "Ali"), or one line with a gift card and one without, forms
 * separate lines (each with its own quantity, name & price) instead of the last
 * add overwriting the first. A blank name + no gift card falls back to the pure
 * variant key, leaving non-personalized products unaffected.
 *
 * Folded into the stored `variantKey` so every existing line-targeting path —
 * update/remove/message and the `@@unique([cartId, productId, variantKey])`
 * constraint — keeps working with no migration. Byte-for-byte identical to the
 * frontend's `lineVariantKey()`.
 */
function lineVariantKey(selectedOptions, customName, giftCardSelected) {
  const base = variantKeyOf(selectedOptions);
  const segments = [];
  const name = String(customName == null ? '' : customName).trim();
  // Encode the free-text name so it can't contain the segment delimiters ("|",
  // "=") and forge another segment — e.g. a literal name "X|__gc=1" must NOT
  // collide with name "X" + gift card. encodeURIComponent is identical in Node
  // and the browser, preserving client/server key parity.
  if (name) segments.push(`__name=${encodeURIComponent(name)}`);
  if (giftCardSelected) segments.push('__gc=1');
  if (segments.length === 0) return base;
  const extra = segments.join('|');
  return base ? `${base}|${extra}` : extra;
}

module.exports = { variantKeyOf, lineVariantKey };
