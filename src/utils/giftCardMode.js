/**
 * Gift-card input mode resolution. A product's effective mode is its own
 * `giftCardMode`, else its category's, else the historical MESSAGE default — the same
 * product ?? category ?? default shape as deliveryLeadDays. Keeping it here means the
 * cart snapshot, the order snapshot, and the storefront all agree on one rule.
 */

const GIFT_CARD_MODES = ['MESSAGE', 'NAME'];
const DEFAULT_GIFT_CARD_MODE = 'MESSAGE';

/** Normalize a raw value to a valid mode or null (null = "inherit / no override"). */
function normalizeGiftCardMode(value) {
  if (value === undefined || value === null || value === '') return null;
  const v = String(value).trim().toUpperCase();
  return GIFT_CARD_MODES.includes(v) ? v : null;
}

/**
 * Resolve the effective gift-card mode for a product.
 * @param {string|null|undefined} productMode  Product.giftCardMode
 * @param {string|null|undefined} categoryMode Category.giftCardMode
 * @returns {'MESSAGE'|'NAME'}
 */
function resolveGiftCardMode(productMode, categoryMode) {
  return (
    normalizeGiftCardMode(productMode) ||
    normalizeGiftCardMode(categoryMode) ||
    DEFAULT_GIFT_CARD_MODE
  );
}

module.exports = {
  GIFT_CARD_MODES,
  DEFAULT_GIFT_CARD_MODE,
  normalizeGiftCardMode,
  resolveGiftCardMode,
};
