const { validationResult, body } = require('express-validator');
const { error } = require('../utils/response');

/**
 * Middleware that returns 400 with validation errors if any.
 * Format: { success: false, message: 'Validation failed', errors: [{ field, message }] }
 */
function handleValidationErrors(req, res, next) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    const errors = result.array().map((e) => ({ field: e.path, message: e.msg }));
    return error(res, 'Validation failed', 400, errors);
  }
  next();
}

/**
 * Validator: "at least one of `enField` or `arField` must be a non-empty string".
 *
 * Lets bilingual fields accept input in either language — admin can fill the English
 * column, the Arabic column, or both. Backend auto-translates the empty side; this
 * validator only enforces that the request isn't blank.
 *
 * Pass the human label for nicer error messages, e.g. requireEitherBilingual('title', 'title_ar', 'Title').
 */
function requireEitherBilingual(enField, arField, label) {
  return body().custom((_value, { req }) => {
    const en = String(req.body?.[enField] ?? '').trim();
    const ar = String(req.body?.[arField] ?? '').trim();
    if (!en && !ar) {
      throw new Error(`${label} is required — provide either "${enField}" or "${arField}"`);
    }
    return true;
  });
}

module.exports = { handleValidationErrors, requireEitherBilingual };
