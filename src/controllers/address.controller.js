const addressService = require('../services/address.service');
const { success, error } = require('../utils/response');

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
    const address = await addressService.createAddress(req.userId, req.body);
    return success(res, address, 'Address added successfully', 201);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const address = await addressService.updateAddress(req.userId, req.params.id, req.body);
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
