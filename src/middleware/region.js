/**
 * Resolves the storefront region for a request from the `X-Region` header
 * (fallback: `?region=` query param), validates it against the active regions,
 * and attaches it to the request. Falls back to the default region when the
 * client sends nothing or an unknown/inactive code, so downstream code can
 * always rely on `req.region` / `req.regionId` being present (when at least one
 * region exists).
 *
 * Never rejects — region selection should not break a request.
 */
const regionService = require('../services/region.service');

async function resolveRegion(req, res, next) {
  try {
    const code = req.headers['x-region'] || req.query.region || '';
    const region = await regionService.resolveRegion(code);
    req.region = region || null;
    req.regionId = region?.id || null;
    req.regionCode = region?.code || null;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { resolveRegion };
