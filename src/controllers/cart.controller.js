const cartService = require('../services/cart.service');
const regionService = require('../services/region.service');
const { success, error } = require('../utils/response');

// Cart isn't behind the region middleware (it's user-only), so resolve the
// requesting region directly from the X-Region header. Falls back to the
// default region (via resolveRegion's fallback) when absent/unknown. Returns
// the full region so callers get both its currency (for display) and id (for
// per-region price override lookups in cartService).
async function regionFromReq(req) {
  return regionService.resolveRegion(req.headers['x-region']);
}

async function addToCart(req, res, next) {
  try {
    const userId = req.userId;
    const { productId, quantity, message, selectedOptions, giftCardSelected, customName } = req.body;
    const { cart, error: errMsg } = await cartService.addToCart(userId, {
      productId,
      quantity,
      message,
      selectedOptions,
      giftCardSelected,
      customName,
    });
    if (errMsg) return error(res, errMsg, 404);
    const region = await regionFromReq(req);
    const data = await cartService.getCart(userId, region?.currency || 'AED', region?.id || null);
    return success(res, data, 'Product added to cart', 200);
  } catch (err) {
    next(err);
  }
}

async function updateQuantity(req, res, next) {
  try {
    const userId = req.userId;
    const { productId, quantity } = req.body;
    const { cart, error: errMsg } = await cartService.updateQuantity(userId, {
      productId,
      quantity,
    });
    if (errMsg) return error(res, errMsg, 400);
    const region = await regionFromReq(req);
    const data = await cartService.getCart(userId, region?.currency || 'AED', region?.id || null);
    return success(res, data, 'Cart updated');
  } catch (err) {
    next(err);
  }
}

async function updateItemMessage(req, res, next) {
  try {
    const userId = req.userId;
    const { productId, message } = req.body;
    const { error: errMsg } = await cartService.updateItemMessage(userId, {
      productId,
      message,
    });
    if (errMsg) return error(res, errMsg, 404);
    const region = await regionFromReq(req);
    const data = await cartService.getCart(userId, region?.currency || 'AED', region?.id || null);
    return success(res, data, 'Item message updated');
  } catch (err) {
    next(err);
  }
}

async function removeFromCart(req, res, next) {
  try {
    const userId = req.userId;
    const { productId } = req.params;
    await cartService.removeFromCart(userId, productId);
    const region = await regionFromReq(req);
    const data = await cartService.getCart(userId, region?.currency || 'AED', region?.id || null);
    return success(res, data, 'Product removed from cart');
  } catch (err) {
    next(err);
  }
}

async function getCart(req, res, next) {
  try {
    const userId = req.userId;
    const region = await regionFromReq(req);
    const data = await cartService.getCart(userId, region?.currency || 'AED', region?.id || null);
    return success(res, data, 'Cart fetched successfully');
  } catch (err) {
    next(err);
  }
}

async function updateOrderMessage(req, res, next) {
  try {
    const userId = req.userId;
    const { orderMessage } = req.body;
    await cartService.updateCartMessage(userId, orderMessage);
    const region = await regionFromReq(req);
    const data = await cartService.getCart(userId, region?.currency || 'AED', region?.id || null);
    return success(res, data, 'Cart message updated');
  } catch (err) {
    next(err);
  }
}

async function clearCart(req, res, next) {
  try {
    const userId = req.userId;
    const region = await regionFromReq(req);
    const data = await cartService.clearCart(userId, region?.currency || 'AED', region?.id || null);
    return success(res, data, 'Cart cleared');
  } catch (err) {
    next(err);
  }
}

async function getCartSuggestions(req, res, next) {
  try {
    const userId = req.userId;
    const limitPerCategory = req.query.limitPerCategory;
    const discoverLimit = req.query.discoverLimit;
    const data = await cartService.getCartSuggestions(userId, {
      limitPerCategory,
      discoverLimit,
    });
    return success(res, data, 'Suggestions fetched successfully');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  addToCart,
  updateQuantity,
  updateItemMessage,
  removeFromCart,
  getCart,
  updateOrderMessage,
  clearCart,
  getCartSuggestions,
};
