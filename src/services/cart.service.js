const prisma = require('../config/db');
const productService = require('./product.service');

function decimalToNumber(v) {
  return v == null ? null : Number(v);
}

function effectivePrice(product) {
  const discounted = product.discountedPrice != null ? Number(product.discountedPrice) : null;
  const price = Number(product.price);
  return discounted != null && discounted < price ? discounted : price;
}

// Product include for cart (images + descriptions + productOptions for display)
const cartProductInclude = {
  images: { orderBy: { sortOrder: 'asc' } },
  descriptions: { orderBy: { sortOrder: 'asc' } },
  productOptions: { orderBy: { sortOrder: 'asc' } },
};

async function getOrCreateCart(userId) {
  let cart = await prisma.cart.findUnique({
    where: { userId },
    include: {
      items: {
        include: {
          product: { include: cartProductInclude },
        },
      },
    },
  });
  if (!cart) {
    cart = await prisma.cart.create({
      data: { userId },
      include: {
        items: {
          include: { product: { include: cartProductInclude } },
        },
      },
    });
  }
  return cart;
}

async function addToCart(userId, { productId, quantity = 1, message = null }) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return { cart: null, error: 'Product not found' };

  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const cart = await getOrCreateCart(userId);

  const existing = await prisma.cartItem.findUnique({
    where: {
      cartId_productId: { cartId: cart.id, productId },
    },
  });

  if (existing) {
    await prisma.cartItem.update({
      where: { id: existing.id },
      data: {
        quantity: existing.quantity + qty,
        ...(message !== undefined && { message: message || null }),
      },
    });
  } else {
    await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId,
        quantity: qty,
        message: message || null,
      },
    });
  }

  return { cart: await getOrCreateCart(userId), error: null };
}

async function updateQuantity(userId, { productId, quantity }) {
  const cart = await getOrCreateCart(userId);
  const qty = Math.max(0, parseInt(quantity, 10));
  if (qty === 0) {
    await prisma.cartItem.deleteMany({
      where: {
        cartId: cart.id,
        productId,
      },
    });
  } else {
    const item = await prisma.cartItem.findUnique({
      where: {
        cartId_productId: { cartId: cart.id, productId },
      },
    });
    if (!item) return { cart: null, error: 'Product not in cart' };
    await prisma.cartItem.update({
      where: { id: item.id },
      data: { quantity: qty },
    });
  }
  return { cart: await getOrCreateCart(userId), error: null };
}

async function removeFromCart(userId, productId) {
  const cart = await getOrCreateCart(userId);
  await prisma.cartItem.deleteMany({
    where: { cartId: cart.id, productId },
  });
  return getOrCreateCart(userId);
}

async function updateCartMessage(userId, orderMessage) {
  const cart = await getOrCreateCart(userId);
  await prisma.cart.update({
    where: { id: cart.id },
    data: { orderMessage: orderMessage ?? null },
  });
  return getOrCreateCart(userId);
}

/**
 * Update the per-item message (e.g. gift note, engraving) for a product in the cart.
 * @param {string} userId - Authenticated user ID
 * @param {{ productId: string, message: string | null }} payload
 * @returns {{ cart: object | null, error: string | null }}
 */
async function updateItemMessage(userId, { productId, message }) {
  const cart = await getOrCreateCart(userId);
  const item = await prisma.cartItem.findUnique({
    where: {
      cartId_productId: { cartId: cart.id, productId },
    },
  });
  if (!item) return { cart: null, error: 'Product not in cart' };
  const newMessage = message !== undefined && message !== null ? (String(message).trim() || null) : item.message;
  await prisma.cartItem.update({
    where: { id: item.id },
    data: { message: newMessage },
  });
  return { cart: await getOrCreateCart(userId), error: null };
}

async function getCart(userId) {
  const cart = await getOrCreateCart(userId);
  const items = cart.items.map((i) => ({
    id: i.id,
    productId: i.productId,
    product: productService.mapProduct(i.product),
    quantity: i.quantity,
    message: i.message,
    lineTotal: effectivePrice(i.product) * i.quantity,
  }));
  const totalAmount = items.reduce((sum, i) => sum + i.lineTotal, 0);
  return {
    id: cart.id,
    items,
    totalAmount: Math.round(totalAmount * 100) / 100,
    orderMessage: cart.orderMessage,
  };
}

async function clearCart(userId) {
  const cart = await getOrCreateCart(userId);
  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  await prisma.cart.update({
    where: { id: cart.id },
    data: { orderMessage: null },
  });
  return getCart(userId);
}

module.exports = {
  getOrCreateCart,
  addToCart,
  updateQuantity,
  updateItemMessage,
  removeFromCart,
  updateCartMessage,
  getCart,
  clearCart,
  effectivePrice,
};
