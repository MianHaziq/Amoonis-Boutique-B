const addressService = require('../services/address.service');
const regionService = require('../services/region.service');
const { success, error } = require('../utils/response');

// The region the shopper is currently in, from the X-Region header the client
// sends on every request (same source order.service trusts). Falls back to the
// default region. Used to tag a saved address with its region at create/update.
async function currentRegionId(req) {
  const region = await regionService.resolveRegion(req.headers['x-region']);
  return region?.id ?? null;
}

async function list(req, res, next) {
  try {
    const addresses = await addressService.listAddresses(req.userId);
    return success(res, addresses, 'Addresses fetched successfully');
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const address = await addressService.createAddress(req.userId, req.body, await currentRegionId(req));
    return success(res, address, 'Address added successfully', 201);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const address = await addressService.updateAddress(req.userId, req.params.id, req.body, await currentRegionId(req));
    if (!address) return error(res, 'Address not found', 404);
    return success(res, address, 'Address updated successfully');
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const deleted = await addressService.deleteAddress(req.userId, req.params.id);
    if (!deleted) return error(res, 'Address not found', 404);
    return success(res, null, 'Address deleted successfully');
  } catch (err) {
    next(err);
  }
}

async function setDefault(req, res, next) {
  try {
    const address = await addressService.setDefault(req.userId, req.params.id);
    if (!address) return error(res, 'Address not found', 404);
    return success(res, address, 'Default address updated');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, update, remove, setDefault };
