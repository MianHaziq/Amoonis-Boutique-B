const deliveryConfigService = require('../services/deliveryConfig.service');
const regionService = require('../services/region.service');
const { success, error } = require('../utils/response');

/**
 * GET /delivery-config?region=CODE&zoneId=&subtotal=
 *
 * Public, storefront-facing. Returns the fully RESOLVED delivery configuration for a
 * (region, zone) pair — fee, free-delivery threshold + effective fee for the given
 * subtotal, delivery days, same-day availability (computed in the region's timezone),
 * cutoff, standard lead time, COD availability, min/max order, active time slots, blackout
 * dates, and the earliest schedulable date. One call gives the checkout everything it
 * needs, with the zone→region→default inheritance already applied server-side.
 *
 * `region` accepts a region code (X-Region style) or id; falls back to the request's
 * resolved region, then the default region, so a bare call still returns something usable.
 */
async function getDeliveryConfig(req, res, next) {
  try {
    const regionRef =
      req.query.region ||
      req.region?.code ||
      req.region?.id ||
      (await regionService.getDefaultRegion())?.code;
    if (!regionRef) return error(res, 'No region available', 404);

    const subtotalRaw = req.query.subtotal;
    const subtotal =
      subtotalRaw !== undefined && subtotalRaw !== '' && Number.isFinite(Number(subtotalRaw))
        ? Number(subtotalRaw)
        : null;

    const result = await deliveryConfigService.loadAndResolve({
      regionRef,
      zoneId: req.query.zoneId || null,
      subtotal,
    });
    if (!result) return error(res, 'Region not found', 404);

    return success(res, result.config, 'Delivery configuration resolved', 200);
  } catch (err) {
    next(err);
  }
}

module.exports = { getDeliveryConfig };
