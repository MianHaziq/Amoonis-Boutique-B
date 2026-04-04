const cartService = require('../services/cart.service');
const { success, error } = require('../utils/response');

async function addToCart(req, res, next) {
  try {
    const userId = req.userId;
    const { productId, quantity, message } = req.body;
    const { cart, error: errMsg } = await cartService.addToCart(userId, {
      productId,
      quantity,
      message,
    });
    if (errMsg) return error(res, errMsg, 404);
    const data = await cartService.getCart(userId);
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
    const data = await cartService.getCart(userId);
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
    const data = await cartService.getCart(userId);
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
    const data = await cartService.getCart(userId);
    return success(res, data, 'Product removed from cart');
  } catch (err) {
    next(err);
  }
}

async function getCart(req, res, next) {
  try {
    const userId = req.userId;
    const data = await cartService.getCart(userId);
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
    const data = await cartService.getCart(userId);
    return success(res, data, 'Cart message updated');
  } catch (err) {
    next(err);
  }
}

async function clearCart(req, res, next) {
  try {
    const userId = req.userId;
    const data = await cartService.clearCart(userId);
    return success(res, data, 'Cart cleared');
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
};
