const { Prisma } = require('@prisma/client');
const prisma = require('../config/db');
const productService = require('./product.service');

function decimalToNumber(v) {
  return v == null ? null : Number(v);
}

// Resolves to the requesting region's price (base AED price, or that region's manual
// override when set) — same rule as order.service's livePrice. `product.regions` must
// already be scoped to the requesting region (0-1 row) by the caller.
function effectivePrice(product) {
  const { price, discountedPrice } = productService.regionPriceFromRow(product);
  return discountedPrice != null && discountedPrice < price ? discountedPrice : price;
}

// Product include for cart (images + descriptions + productOptions for display)
const cartProductInclude = {
  // deliveryLeadDays feeds the per-line "ships within N days" note the storefront shows
  // in the cart drawer / cart page / checkout review — resolved below via
  // attachResolvedDeliveryLeadDays so an authenticated user's server-hydrated cart
  // carries the same value the PDP snapshotted at add-to-cart time.
  category: { select: { id: true, title: true, deliveryLeadDays: true } },
  images: { orderBy: { sortOrder: 'asc' } },
  descriptions: { orderBy: { sortOrder: 'asc' } },
  productOptions: { orderBy: { sortOrder: 'asc' } },
};

const suggestionProductInclude = {
  category: { select: { id: true, title: true } },
  images: { orderBy: { sortOrder: 'asc' } },
  descriptions: { orderBy: { sortOrder: 'asc' } },
  productOptions: { orderBy: { sortOrder: 'asc' } },
};

/**
 * Random in-stock products (PostgreSQL). Preserves RANDOM() order in the result list.
 */
async function fetchRandomInStockProducts(limit, excludeIds = []) {
  const take = Math.min(48, Math.max(1, limit));
  const rows =
    excludeIds.length === 0
      ? await prisma.$queryRaw`
          SELECT id FROM "Product"
          WHERE quantity > 0
          ORDER BY RANDOM()
          LIMIT ${take}
        `
      : await prisma.$queryRaw`
          SELECT id FROM "Product"
          WHERE quantity > 0
            AND id NOT IN (${Prisma.join(excludeIds)})
          ORDER BY RANDOM()
          LIMIT ${take}
        `;

  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];

  const products = await prisma.product.findMany({
    where: { id: { in: ids } },
    include: suggestionProductInclude,
  });
  const order = new Map(ids.map((id, i) => [id, i]));
  products.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return products.map((row) => productService.mapProduct(row));
}

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

async function addToCart(userId, {
  productId,
  quantity = 1,
  message = null,
  selectedOptions = undefined,
  giftCardSelected = undefined,
  customName = undefined,
}) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return { cart: null, error: 'Product not found' };

  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const cart = await getOrCreateCart(userId);

  const existing = await prisma.cartItem.findUnique({
    where: {
      cartId_productId: { cartId: cart.id, productId },
    },
  });

  // Validate the resulting cart quantity against available stock (M11) so the user gets
  // early feedback instead of only failing at checkout. addToCart is additive, so the
  // check is against the existing line quantity plus the amount being added.
  const desiredQty = (existing ? existing.quantity : 0) + qty;
  if (product.quantity != null && desiredQty > product.quantity) {
    return {
      cart: null,
      error:
        product.quantity > 0
          ? `Only ${product.quantity} in stock`
          : 'This product is out of stock',
    };
  }

  // Only honor gift-card/custom-name selections the product actually offers — a
  // tampered request claiming an add-on the product doesn't have is silently dropped.
  const effectiveGiftCardSelected =
    giftCardSelected !== undefined ? !!giftCardSelected && !!product.giftCardEnabled : undefined;
  const effectiveCustomName =
    customName !== undefined ? (product.customNameEnabled ? (String(customName || '').trim() || null) : null) : undefined;

  if (existing) {
    await prisma.cartItem.update({
      where: { id: existing.id },
      data: {
        quantity: existing.quantity + qty,
        ...(message !== undefined && { message: message || null }),
        // Cart lines are still one-per-product (@@unique([cartId, productId])),
        // not variant-aware — adding a different variant of an already-cart'd
        // product overwrites the selection on that single line (last wins).
        ...(selectedOptions !== undefined && {
          selectedOptions: selectedOptions && Object.keys(selectedOptions).length > 0 ? selectedOptions : Prisma.DbNull,
        }),
        ...(effectiveGiftCardSelected !== undefined && { giftCardSelected: effectiveGiftCardSelected }),
        ...(effectiveCustomName !== undefined && { customName: effectiveCustomName }),
      },
    });
  } else {
    await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId,
        quantity: qty,
        message: message || null,
        selectedOptions: selectedOptions && Object.keys(selectedOptions).length > 0 ? selectedOptions : Prisma.DbNull,
        giftCardSelected: effectiveGiftCardSelected ?? false,
        customName: effectiveCustomName ?? null,
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
    // Validate the new absolute quantity against available stock (M11).
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { quantity: true },
    });
    if (!product) return { cart: null, error: 'Product not found' };
    if (product.quantity != null && qty > product.quantity) {
      return {
        cart: null,
        error:
          product.quantity > 0
            ? `Only ${product.quantity} in stock`
            : 'This product is out of stock',
      };
    }
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

async function getCart(userId, currency = 'AED', regionId = null) {
  const cart = await getOrCreateCart(userId);
  const productIds = cart.items.map((i) => i.productId);
  const overrides = regionId && productIds.length > 0
    ? await prisma.productRegion.findMany({
        where: { productId: { in: productIds }, regionId },
        select: { productId: true, price: true, discountedPrice: true },
      })
    : [];
  const overrideByProductId = new Map(overrides.map((r) => [r.productId, r]));

  const items = cart.items.map((i) => {
    const override = overrideByProductId.get(i.productId);
    // Same "0-1 row, no nested `.region`" shape productService.mapProduct/
    // regionPriceFromRow already expect from a region-scoped ProductRegion lookup.
    const productRow = { ...i.product, regions: override ? [override] : [] };
    return {
      id: i.id,
      productId: i.productId,
      product: productService.applyRegionCurrency(productService.mapProduct(productRow)),
      quantity: i.quantity,
      message: i.message,
      selectedOptions: i.selectedOptions ?? null,
      giftCardSelected: i.giftCardSelected,
      customName: i.customName,
      lineTotal:
        (effectivePrice(productRow) +
          productService.optionExtraCharge(productRow, { giftCardSelected: i.giftCardSelected, customName: i.customName })) *
        i.quantity,
    };
  });
  // Resolve each line's "ships within N days" lead time (product -> category -> global
  // default). Mutates the product objects in place; one Settings fetch for the whole
  // cart (cached), not one per line.
  await productService.attachResolvedDeliveryLeadDays(items.map((i) => i.product));
  const totalAmount = items.reduce((sum, i) => sum + i.lineTotal, 0);
  return {
    id: cart.id,
    items,
    totalAmount: Math.round(totalAmount * 100) / 100,
    currency,
    orderMessage: cart.orderMessage,
  };
}

async function clearCart(userId, currency = 'AED', regionId = null) {
  const cart = await getOrCreateCart(userId);
  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  await prisma.cart.update({
    where: { id: cart.id },
    data: { orderMessage: null },
  });
  return getCart(userId, currency, regionId);
}

/**
 * Recommendations from categories represented in the cart (excludes cart line product IDs).
 * Adds a **discover** block from other in-stock categories when possible.
 * Empty cart: **discover** is a random sample of in-stock products (same query params size the pool).
 */
async function getCartSuggestions(userId, options = {}) {
  const limitPerCategory = Math.min(24, Math.max(1, parseInt(options.limitPerCategory, 10) || 8));
  const discoverLimit = Math.min(24, Math.max(1, parseInt(options.discoverLimit, 10) || 10));

  const cart = await prisma.cart.findUnique({
    where: { userId },
    include: {
      items: {
        include: {
          product: {
            include: {
              ...cartProductInclude,
              category: { select: { id: true, title: true } },
            },
          },
        },
      },
    },
  });

  if (!cart || !cart.items.length) {
    const randomPool = Math.min(48, Math.max(discoverLimit, limitPerCategory, 12));
    const discover = await fetchRandomInStockProducts(randomPool, []);
    return {
      sections: [],
      discover,
      headline: 'Discover',
      hint:
        discover.length > 0
          ? 'Your cart is empty — here is a fresh mix of in-stock products. Add items to get category-based suggestions.'
          : 'No in-stock products are available to suggest right now.',
    };
  }

  const excludeIds = cart.items.map((i) => i.productId);
  const categoryAgg = new Map();

  for (const item of cart.items) {
    const p = item.product;
    if (!p || !p.categoryId || !p.category) continue;
    if (!categoryAgg.has(p.categoryId)) {
      categoryAgg.set(p.categoryId, {
        id: p.categoryId,
        title: p.category.title,
        sampleProductTitle: p.title || null,
      });
    }
  }

  const categoryList = [...categoryAgg.values()];
  const cartCategoryIds = [...categoryAgg.keys()];

  const sectionWhere = (categoryId) => ({
    categoryId,
    id: { notIn: excludeIds },
    quantity: { gt: 0 },
  });

  const discoverWhere =
    cartCategoryIds.length > 0
      ? {
          id: { notIn: excludeIds },
          quantity: { gt: 0 },
          categoryId: { not: null, notIn: cartCategoryIds },
        }
      : {
          id: { notIn: excludeIds },
          quantity: { gt: 0 },
        };

  const [discoverRows, ...categoryRowSets] = await Promise.all([
    prisma.product.findMany({
      where: discoverWhere,
      take: discoverLimit,
      orderBy: [{ createdAt: 'desc' }],
      include: suggestionProductInclude,
    }),
    ...categoryList.map((cat) =>
      prisma.product.findMany({
        where: sectionWhere(cat.id),
        take: limitPerCategory,
        orderBy: [{ updatedAt: 'desc' }],
        include: suggestionProductInclude,
      })
    ),
  ]);

  const sections = [];
  categoryList.forEach((cat, i) => {
    const rows = categoryRowSets[i];
    if (!rows.length) return;
    const sample = cat.sampleProductTitle ? `"${cat.sampleProductTitle}"` : 'items';
    sections.push({
      category: { id: cat.id, title: cat.title },
      headline: `More from ${cat.title}`,
      subhead: `You have ${sample} in your cart — here are other picks from this category.`,
      products: rows.map((row) => productService.mapProduct(row)),
    });
  });

  return {
    sections,
    discover: discoverRows.map((row) => productService.mapProduct(row)),
    headline: 'Complete your look',
    hint:
      sections.length === 0
        ? 'Here are popular in-stock picks you may like.'
        : 'Curated in-stock picks from categories you have not added yet.',
  };
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
  getCartSuggestions,
  effectivePrice,
};
