/**
 * Global error handler. Logs errors and returns consistent JSON.
 * Prisma errors (P2002, P2025) and validation/JWT status codes are mapped.
 */
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const isProd = process.env.NODE_ENV === 'production';

  if (err.code === 'P2002') {
    return res.status(409).json({
      success: false,
      message: 'A record with this value already exists',
    });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({
      success: false,
      message: 'Record not found',
    });
  }

  if (!isProd) {
    console.error('[ERROR]', err.stack || err.message);
  } else if (status >= 500) {
    console.error('[ERROR]', err.message);
  }

  const payload = {
    success: false,
    message: err.message || 'Internal Server Error',
  };
  if (err.errors && Array.isArray(err.errors)) payload.errors = err.errors;
  res.status(status).json(payload);
}

module.exports = errorHandler;
