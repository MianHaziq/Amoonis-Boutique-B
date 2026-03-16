/**
 * Consistent API response helpers.
 * Success: { success: true, message?, data?, meta? }
 * Error:   { success: false, message, errors? }
 */

function success(res, data, message = 'Success', status = 200, meta = null) {
  const payload = { success: true, message };
  if (data !== undefined) payload.data = data;
  if (meta && typeof meta === 'object') payload.meta = meta;
  return res.status(status).json(payload);
}

function error(res, message = 'An error occurred', status = 500, errors = null) {
  const payload = { success: false, message };
  if (errors && Array.isArray(errors)) payload.errors = errors;
  return res.status(status).json(payload);
}

module.exports = { success, error };
