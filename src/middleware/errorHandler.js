const { error } = require('../utils/response');

/**
 * Global error handler. Logs errors and returns consistent JSON.
 * Format: { success: false, message, errors? }
 * Prisma P2002 → 409, P2025 → 404, P2003 → 400; preserves status and errors array.
 */
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const isProd = process.env.NODE_ENV === 'production';

  if (err.code === 'P2002') {
    return error(res, 'A record with this value already exists', 409);
  }

  if (err.code === 'P2025') {
    return error(res, 'Record not found', 404);
  }

  if (err.code === 'P2003') {
    return error(res, 'Referenced record does not exist', 400);
  }

  if (!isProd) {
    console.error('[ERROR]', err.stack || err.message);
  } else if (status >= 500) {
    console.error('[ERROR]', err.message);
  }

  // In production, never leak internal error details for 5xx responses. The JSON
  // structure stays identical — only the message string is genericized for 5xx in prod.
  const message = isProd && status >= 500
    ? 'Internal server error'
    : err.message || 'Internal Server Error';

  return error(res, message, status, err.errors);
}

module.exports = errorHandler;
