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

module.exports = { variantKeyOf };
