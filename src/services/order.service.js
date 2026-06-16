const prisma = require('../config/db');
const cartService = require('../services/cart.service');
const notify = require('../notifications/notify');
const promoCodeService = require('../services/promoCode.service');
const paymentService = require('../services/payment.service');
const regionService = require('../services/region.service');

function decimalToNumber(v) {
  return v == null ? null : Number(v);
}

const orderProductInclude = {
  images: { orderBy: { sortOrder: 'asc' } },
  descriptions: { orderBy: { sortOrder: 'asc' } },
  productOptions: { orderBy: { sortOrder: 'asc' } },
};

function mapProductForDisplay(product) {
  if (!product) return null;
  const imgs = (product.images || []).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const urls = imgs.map((i) => i.url);
  const descs = (product.descriptions || []).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const descriptions = descs.map((d) => ({
    id: d.id,
    title: d.title ?? null,
    title_ar: d.title_ar ?? null,
    description: d.description,
    description_ar: d.description_ar ?? null,
  }));
  const productOptionsList = (product.productOptions || [])
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((o) => ({
      id: o.id,
      title: o.title,
      title_ar: o.title_ar ?? null,
      options: Array.isArray(o.options) ? o.options : [],
      options_ar: Array.isArray(o.options_ar) ? o.options_ar : [],
    }));
  return {
    id: product.id,
    title: product.title,
    title_ar: product.title_ar ?? null,
    subtitle: product.subtitle ?? null,
    subtitle_ar: product.subtitle_ar ?? null,
    image: urls[0] ?? null,
    images: urls,
    descriptions,
    productOptions: productOptionsList,
  };
}

function mapOrderItemProduct(item) {
  if (item.product) return mapProductForDisplay(item.product);
  if (item.productTitle) {
    return {
      id: null,
      title: item.productTitle,
      title_ar: item.productTitle_ar ?? null,
      subtitle: null,
      subtitle_ar: null,
      image: null,
      images: [],
      descriptions: [],
      productOptions: [],
      deleted: true,
    };
  }
  return null;
}

function toOrderResponsePayload(order) {
  const items = (order.items || []).map((i) => ({
    id: i.id,
    productId: i.productId,
    product: mapOrderItemProduct(i),
    quantity: i.quantity,
    perProductMessage: i.perProductMessage,
    price: decimalToNumber(i.price),
  }));
  return {
    id: order.id,
    userId: order.userId,
    orderMessage: order.orderMessage,
    totalAmount: decimalToNumber(order.totalAmount),
    discountAmount: decimalToNumber(order.discountAmount),
    appliedPromoCode: order.appliedPromoCode ?? null,
    paymentMethod: order.paymentMethod ?? 'COD',
    paymentStatus: order.paymentStatus ?? 'UNPAID',
    status: order.status,
    shippingAddress:
      order.shippingFullName
      || order.shippingPhone
      || order.shippingStreetAddress
      || order.shippingCity
      || order.shippingCountry
        ? {
            fullName: order.shippingFullName ?? null,
            phone: order.shippingPhone ?? null,
            streetAddress: order.shippingStreetAddress ?? null,
            apartment: order.shippingApartment ?? null,
            city: order.shippingCity ?? null,
            state: order.shippingState ?? null,
            postalCode: order.shippingPostalCode ?? null,
            country: order.shippingCountry ?? null,
          }
        : null,
    inventoryDeducted: Boolean(order.inventoryDeducted),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items,
  };
}

const VALID_PAYMENT_METHODS = ['COD', 'MYFATOORAH'];

// AWAITING_PAYMENT orders are unpaid online checkouts that aren't "placed" yet — they
// must not appear in customer history, admin lists, or analytics. This builds the
// status filter for list queries: honor an explicit status filter, otherwise exclude
// AWAITING_PAYMENT.
function listStatusFilter(status) {
  if (status) return { status };
  return { status: { not: 'AWAITING_PAYMENT' } };
}

// At checkout we no longer require name/phone in the address payload — they're
// pulled from the user profile (collected at signup / Google / Apple). The
// address payload only needs the location bits, and even those are now soft.
function validateShippingAddress(addr) {
  if (!addr || typeof addr !== 'object') return 'shippingAddress is required';
  if (!addr.streetAddress || !String(addr.streetAddress).trim()) return 'shippingAddress.streetAddress is required';
  return null;
}

function trimOrNullStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

async function createOrder(userId, checkoutInput = {}, opts = {}) {
  const { addressId, shippingAddress, paymentMethod = 'COD', promoCode } = checkoutInput;

  if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
    return { order: null, error: `Invalid paymentMethod. Supported: ${VALID_PAYMENT_METHODS.join(', ')}` };
  }

  // Online payment: the order is NOT "placed" yet — it starts AWAITING_PAYMENT (hidden
  // from order history / admin / analytics), the cart is kept, and no "order placed"
  // push fires. confirmOrderPayment turns it into a real CONFIRMED order once paid.
  // COD: placed instantly as PENDING, cart cleared, push sent (unchanged).
  const isOnlinePayment = paymentMethod === 'MYFATOORAH';
  const initialStatus = isOnlinePayment ? 'AWAITING_PAYMENT' : 'PENDING';

  // Recipient identity (fullName + phone) is sourced from the user profile so the
  // checkout payload doesn't need to re-collect what we already have from signup.
  // Falls back to whatever the address row carries (old saved addresses still have
  // name/phone populated and we don't want to wipe that on their orders).
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { fullName: true, phone: true, regionId: true },
  });
  const profileFullName = (userRow?.fullName && userRow.fullName.trim()) || null;
  const profilePhone = userRow?.phone || null;

  // Region the order is placed in: explicit X-Region header wins, then the user's
  // home region, then the system default. Stamped on the order for regional analytics.
  let orderRegionId = userRow?.regionId || null;
  if (opts.regionCode) {
    const resolved = await regionService.resolveRegion(opts.regionCode);
    if (resolved) orderRegionId = resolved.id;
  }
  if (!orderRegionId) {
    const def = await regionService.getDefaultRegion();
    orderRegionId = def?.id || null;
  }

  // Resolve address and fetch cart in parallel when addressId is provided
  let resolvedAddress = null;
  let cartData;

  if (addressId) {
    const [saved, cart] = await Promise.all([
      prisma.address.findFirst({ where: { id: addressId, userId } }),
      cartService.getCart(userId),
    ]);
    if (!saved) return { order: null, error: 'Address not found' };
    resolvedAddress = {
      addressId: saved.id,
      fullName: profileFullName ?? saved.fullName ?? null,
      phone: profilePhone ?? saved.phone ?? null,
      streetAddress: saved.streetAddress ?? null,
      apartment: saved.apartment ?? null,
      city: saved.city ?? null,
      state: saved.state ?? null,
      postalCode: saved.postalCode ?? null,
      country: saved.country ?? null,
    };
    cartData = cart;
  } else if (shippingAddress) {
    const addrError = validateShippingAddress(shippingAddress);
    if (addrError) return { order: null, error: addrError };
    resolvedAddress = {
      addressId: null,
      fullName: profileFullName ?? trimOrNullStr(shippingAddress.fullName),
      phone: profilePhone ?? trimOrNullStr(shippingAddress.phone),
      streetAddress: trimOrNullStr(shippingAddress.streetAddress),
      apartment: trimOrNullStr(shippingAddress.apartment),
      city: trimOrNullStr(shippingAddress.city),
      state: trimOrNullStr(shippingAddress.state),
      postalCode: trimOrNullStr(shippingAddress.postalCode),
      country: trimOrNullStr(shippingAddress.country),
    };
    cartData = await cartService.getCart(userId);
  } else {
    return { order: null, error: 'A shipping address is required. Provide addressId or shippingAddress.' };
  }

  if (!cartData.items || cartData.items.length === 0) {
    return { order: null, error: 'Cart is empty' };
  }

  const productIds = cartData.items.map((it) => it.productId);
  const productRows = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      title: true,
      title_ar: true,
      categoryId: true,
      price: true,
      discountedPrice: true,
      quantity: true,
    },
  });
  const productById = new Map(productRows.map((p) => [p.id, p]));

  // Early stock visibility check — surfaces OUT_OF_STOCK before order creation so the
  // mobile app can show a friendly message instead of completing checkout for unavailable
  // items. Final atomic enforcement still happens at PENDING→CONFIRMED.
  const outOfStock = [];
  for (const it of cartData.items) {
    const p = productById.get(it.productId);
    if (!p) {
      return { order: null, error: 'A product in your cart is no longer available' };
    }
    if (p.quantity < it.quantity) {
      outOfStock.push({
        productId: p.id,
        title: p.title,
        requested: it.quantity,
        available: p.quantity,
      });
    }
  }
  if (outOfStock.length > 0) {
    const first = outOfStock[0];
    return {
      order: null,
      error: `${first.title}: only ${first.available} in stock (you requested ${first.requested})`,
    };
  }

  // Compute server-trusted line prices from the live Product row instead of the cart's
  // snapshot. Closes the price-edit drift window between cart load and order commit.
  function livePrice(productRow) {
    const p = productRow?.discountedPrice ?? productRow?.price;
    return p == null ? 0 : Number(p);
  }
  const livePriceById = new Map(productRows.map((p) => [p.id, livePrice(p)]));

  const promoItems = cartData.items.map((item) => ({
    productId: item.productId,
    quantity: item.quantity,
    price: livePriceById.get(item.productId) ?? 0,
    categoryId: productById.get(item.productId)?.categoryId ?? null,
  }));

  // Validate and compute promo discount before the transaction (read-only)
  let promoResult = null;
  if (promoCode) {
    try {
      promoResult = await promoCodeService.validateAndCalculate(promoCode, userId, promoItems);
    } catch (err) {
      const promoErrors = new Set([
        'PROMO_NOT_FOUND', 'PROMO_INACTIVE', 'PROMO_EXPIRED', 'PROMO_NOT_STARTED',
        'PROMO_LIMIT_REACHED', 'PROMO_USER_LIMIT_REACHED', 'PROMO_MIN_ORDER_NOT_MET',
        'PROMO_MAX_ORDER_EXCEEDED', 'PROMO_NO_ELIGIBLE_ITEMS', 'PROMO_INVALID_INPUT',
      ]);
      if (promoErrors.has(err.code)) return { order: null, error: err.message };
      throw err;
    }
  }

  const provisionalDiscount = promoResult ? promoResult.discountAmount : null;

  let createdOrderId;
  try {
  await prisma.$transaction(async (tx) => {
    // Re-read prices inside the tx so the values written to OrderItem.price and
    // Order.totalAmount reflect the current catalog, not a cart snapshot. Stock isn't
    // deducted here (that happens at confirm), but a price edit between cart load and
    // tx commit must not cause customer/admin to disagree on what was paid.
    const livePriceRows = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, price: true, discountedPrice: true },
    });
    const txPriceById = new Map(
      livePriceRows.map((p) => [p.id, p.discountedPrice != null ? Number(p.discountedPrice) : Number(p.price)])
    );

    // Recompute line totals and order subtotal from live prices.
    let txSubtotal = 0;
    const itemPriceById = new Map();
    for (const item of cartData.items) {
      const livePriceVal = txPriceById.get(item.productId) ?? livePriceById.get(item.productId) ?? 0;
      itemPriceById.set(item.productId, livePriceVal);
      txSubtotal += livePriceVal * item.quantity;
    }
    txSubtotal = Math.round(txSubtotal * 100) / 100;

    // Promo discount stays as previewed unless the discount exceeds the (possibly lower)
    // recomputed subtotal, in which case we cap it. Avoids negative totals on price drops.
    let finalDiscount = provisionalDiscount;
    if (finalDiscount != null) {
      finalDiscount = Math.min(Number(finalDiscount), txSubtotal);
      finalDiscount = Math.round(finalDiscount * 100) / 100;
    }
    const finalTotal = Math.round(Math.max(0, txSubtotal - (finalDiscount ?? 0)) * 100) / 100;

    const orderRecord = await tx.order.create({
      data: {
        userId,
        orderMessage: cartData.orderMessage ?? null,
        totalAmount: finalTotal,
        discountAmount: finalDiscount,
        appliedPromoCode: promoResult?.promoCode.code ?? null,
        appliedPromoCodeId: promoResult?.promoCode.id ?? null,
        paymentMethod,
        addressId: resolvedAddress.addressId,
        shippingFullName: resolvedAddress.fullName,
        shippingPhone: resolvedAddress.phone,
        shippingStreetAddress: resolvedAddress.streetAddress,
        shippingApartment: resolvedAddress.apartment,
        shippingCity: resolvedAddress.city,
        shippingState: resolvedAddress.state,
        shippingPostalCode: resolvedAddress.postalCode,
        shippingCountry: resolvedAddress.country,
        regionId: orderRegionId,
        status: initialStatus,
      },
    });

    createdOrderId = orderRecord.id;

    // Atomic promo usage: an `UPDATE ... WHERE usageLimit IS NULL OR usageCount < usageLimit`
    // returning the affected-row count gives us race-safe global cap enforcement. Per-user
    // cap is checked by counting existing usages for this user inside the same tx.
    if (promoResult) {
      const promoId = promoResult.promoCode.id;

      // Re-read the promo inside the tx to catch toggles / window changes after pre-validation.
      const livePromo = await tx.promoCode.findUnique({
        where: { id: promoId },
        select: {
          isActive: true,
          startsAt: true,
          expiresAt: true,
          usageLimit: true,
          usageLimitPerUser: true,
        },
      });
      if (!livePromo) {
        const err = new Error('Promo code not found');
        err.code = 'PROMO_NOT_FOUND';
        throw err;
      }
      if (!livePromo.isActive) {
        const err = new Error('This promo code is not active');
        err.code = 'PROMO_INACTIVE';
        throw err;
      }
      const now = new Date();
      if (livePromo.startsAt && livePromo.startsAt > now) {
        const err = new Error('This promo code is not yet available');
        err.code = 'PROMO_NOT_STARTED';
        throw err;
      }
      if (livePromo.expiresAt && livePromo.expiresAt <= now) {
        const err = new Error('This promo code has expired');
        err.code = 'PROMO_EXPIRED';
        throw err;
      }

      // Per-user cap — count existing usages then assert. Race window narrowed but not
      // fully closed without a unique index; for stricter guarantees consider a unique
      // composite (promoCodeId, userId, orderId) and rely on the create call to fail.
      if (livePromo.usageLimitPerUser != null) {
        const mine = await tx.promoCodeUsage.count({ where: { promoCodeId: promoId, userId } });
        if (mine >= livePromo.usageLimitPerUser) {
          const err = new Error('You have already used this promo code the maximum number of times');
          err.code = 'PROMO_USER_LIMIT_REACHED';
          throw err;
        }
      }

      // Atomic global-cap increment: only succeeds if usageLimit allows it.
      // Cast the column to text on the WHERE side to match how Prisma binds the param
      // — matches the pattern used elsewhere in this service for raw queries.
      const affected = await tx.$executeRaw`
        UPDATE "PromoCode"
        SET "usageCount" = "usageCount" + 1, "updatedAt" = NOW()
        WHERE id::text = ${promoId}
          AND ("usageLimit" IS NULL OR "usageCount" < "usageLimit")
      `;
      if (affected === 0) {
        const err = new Error('This promo code has reached its usage limit');
        err.code = 'PROMO_LIMIT_REACHED';
        throw err;
      }

      await tx.promoCodeUsage.create({
        data: {
          promoCodeId: promoId,
          userId,
          orderId: orderRecord.id,
          discountAmount: promoResult.discountAmount,
        },
      });
    }

    // Parallel: insert items, clear cart — all depend only on orderRecord.id.
    // OrderItem.price uses the live tx price so the stored line snapshot matches the
    // server-trusted total above.
    await Promise.all([
      tx.orderItem.createMany({
        data: cartData.items.map((item) => ({
          orderId: orderRecord.id,
          productId: item.productId,
          productTitle: productById.get(item.productId)?.title ?? null,
          productTitle_ar: productById.get(item.productId)?.title_ar ?? null,
          quantity: item.quantity,
          perProductMessage: item.message ?? null,
          price: itemPriceById.get(item.productId) ?? 0,
        })),
      }),
      // Keep the cart for online payment until it's actually paid (so an abandoned /
      // failed payment doesn't lose the customer's items). Cleared in confirmOrderPayment.
      ...(isOnlinePayment
        ? []
        : [
            tx.cartItem.deleteMany({ where: { cart: { userId } } }),
            tx.cart.updateMany({ where: { userId }, data: { orderMessage: null } }),
          ]),
    ]);
  }, { maxWait: 5000, timeout: 15000 });
  } catch (err) {
    // Convert known business-rule errors thrown from inside the tx into the same
    // `{ order: null, error: msg }` shape the controller already maps to a 400.
    const userFacingPromoCodes = new Set([
      'PROMO_NOT_FOUND', 'PROMO_INACTIVE', 'PROMO_EXPIRED', 'PROMO_NOT_STARTED',
      'PROMO_LIMIT_REACHED', 'PROMO_USER_LIMIT_REACHED',
    ]);
    if (userFacingPromoCodes.has(err.code)) {
      return { order: null, error: err.message };
    }
    throw err;
  }

  // Heavy product-include read runs outside the transaction to minimize lock hold time
  const order = await prisma.order.findUnique({
    where: { id: createdOrderId },
    include: {
      items: { include: { product: { include: orderProductInclude } } },
      user: { select: { email: true } },
    },
  });

  const payload = toOrderResponsePayload(order);

  // Online payment isn't placed yet — defer the "order placed" notifications to payment
  // success. Both push and email go through the job queue (retried, off the request path).
  if (!isOnlinePayment) {
    notify.orderPlaced(userId, createdOrderId);
    notify.orderConfirmationEmail({
      id: createdOrderId,
      userEmail: order.user?.email,
      totalAmount: payload.totalAmount,
    });
  }

  return { order: payload, error: null };
}

async function getOrderById(orderId, userId = null) {
  const where = { id: orderId };
  if (userId) where.userId = userId;

  const order = await prisma.order.findFirst({
    where,
    include: {
      items: {
        include: { product: { include: orderProductInclude } },
      },
    },
  });

  if (!order) return null;
  return toOrderResponsePayload(order);
}

async function getAllOrdersAdmin(page = 1, limit = 10, status = null) {
  const skip = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, limit));
  const take = Math.min(100, Math.max(1, limit));
  const where = listStatusFilter(status);

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, email: true, fullName: true } },
        _count: { select: { items: true } },
      },
    }),
    prisma.order.count({ where }),
  ]);

  const data = orders.map((o) => ({
    id: o.id,
    userId: o.userId,
    user: o.user,
    orderMessage: o.orderMessage,
    totalAmount: decimalToNumber(o.totalAmount),
    status: o.status,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    itemCount: o._count.items,
  }));

  return {
    data,
    total,
    page: Math.max(1, page),
    limit: take,
    totalPages: Math.ceil(total / take),
  };
}

function mapOrderListRow(order, { includeUser, includeItems, adminAudit }) {
  const base = {
    id: order.id,
    userId: order.userId,
    orderMessage: order.orderMessage,
    totalAmount: decimalToNumber(order.totalAmount),
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
  if (includeUser && order.user) {
    base.user = {
      id: order.user.id,
      email: order.user.email,
      fullName: order.user.fullName || null,
    };
  }
  if (order._count) {
    base.itemCount = order._count.items;
  }
  if (includeItems && order.items) {
    base.items = order.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      quantity: i.quantity,
      perProductMessage: i.perProductMessage,
      price: decimalToNumber(i.price),
      lineTotal: decimalToNumber(i.price) * i.quantity,
      product: mapOrderItemProduct(i),
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    }));
  }
  if (adminAudit) {
    base.audit = {
      lastUpdatedAt: order.updatedAt,
      placedAt: order.createdAt,
      note: 'Line items reflect current product catalog data where joined; prices are the values captured at order time.',
    };
  }
  return base;
}

/**
 * Paginated order history for the authenticated customer.
 */
async function getMyOrderHistory(userId, page = 1, limit = 10, status = null) {
  const skip = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, limit));
  const take = Math.min(100, Math.max(1, limit));
  const where = { userId, ...listStatusFilter(status) };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { items: true } },
      },
    }),
    prisma.order.count({ where }),
  ]);

  const data = orders.map((o) => mapOrderListRow(o, { includeUser: false, includeItems: false }));

  return {
    data,
    total,
    page: Math.max(1, page),
    limit: take,
    totalPages: Math.ceil(total / take),
  };
}

/**
 * Admin/manager: full order log with optional line-item detail for support and auditing.
 */
async function getAdminOrderHistory(page = 1, limit = 10, filters = {}) {
  const skip = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, limit));
  const take = Math.min(100, Math.max(1, limit));
  const where = listStatusFilter(filters.status);

  if (filters.userId) where.userId = filters.userId;
  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {};
    if (filters.dateFrom) where.createdAt.gte = new Date(filters.dateFrom);
    if (filters.dateTo) where.createdAt.lte = new Date(filters.dateTo);
  }

  const includeItems = filters.includeItems === true || filters.includeItems === 'true';

  const include = {
    user: { select: { id: true, email: true, fullName: true } },
    _count: { select: { items: true } },
    ...(includeItems
      ? {
          items: {
            orderBy: { createdAt: 'asc' },
            include: { product: { include: orderProductInclude } },
          },
        }
      : {}),
  };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include,
    }),
    prisma.order.count({ where }),
  ]);

  const data = orders.map((o) =>
    mapOrderListRow(o, { includeUser: true, includeItems, adminAudit: true })
  );

  return {
    data,
    total,
    page: Math.max(1, page),
    limit: take,
    totalPages: Math.ceil(total / take),
    meta: { includeItems },
  };
}

const FULFILLING_STATUSES = ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

function aggregateOrderLineQtyByProduct(items) {
  const map = new Map();
  for (const row of items) {
    map.set(row.productId, (map.get(row.productId) || 0) + row.quantity);
  }
  return map;
}

/**
 * Subtract Product.quantity for each distinct product on the order using one atomic
 * conditional UPDATE per product. The `WHERE quantity >= n` clause + affected-row check
 * makes this safe under concurrent confirms — two transactions trying to deduct the
 * last unit cannot both succeed; the loser's UPDATE returns 0 rows and we throw.
 *
 * Falls back to per-product validation BEFORE the writes so we can produce the same
 * INSUFFICIENT_STOCK / PRODUCT_MISSING shapes the controllers already handle.
 */
async function deductInventoryForOrder(tx, orderId) {
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: { productId: true, quantity: true },
  });
  if (items.length === 0) return;

  const qtyByProduct = aggregateOrderLineQtyByProduct(items);
  const productIds = [...qtyByProduct.keys()];

  // Pre-flight check so the error response includes per-product `available` (used by
  // existing handlers / clients). Concurrent confirms can still slip past this snapshot
  // — the atomic UPDATE below is the actual safety net.
  const products = await tx.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, quantity: true, title: true },
  });
  const productMap = new Map(products.map((p) => [p.id, p]));

  const shortages = [];
  for (const [productId, requested] of qtyByProduct) {
    const product = productMap.get(productId);
    if (!product) {
      const err = new Error('Order references a product that no longer exists');
      err.code = 'PRODUCT_MISSING';
      err.productId = productId;
      throw err;
    }
    if (product.quantity < requested) {
      shortages.push({
        productId: product.id,
        title: product.title,
        requested,
        available: product.quantity,
      });
    }
  }
  if (shortages.length > 0) {
    const err = new Error('Insufficient stock to confirm this order');
    err.code = 'INSUFFICIENT_STOCK';
    err.details = shortages;
    throw err;
  }

  // Atomic deduction: one row-conditional UPDATE per product. If the affected row count
  // is 0, somebody else won the race for the last units between our read and write,
  // so abort with INSUFFICIENT_STOCK and let the transaction roll back.
  // Cast column to text on WHERE side to match Prisma's parameter binding (consistent
  // with other raw queries in this service).
  for (const [productId, requested] of qtyByProduct) {
    const updated = await tx.$executeRaw`
      UPDATE "Product"
      SET quantity = quantity - ${requested}
      WHERE id::text = ${productId} AND quantity >= ${requested}
    `;
    if (updated === 0) {
      const product = productMap.get(productId);
      // Re-read current quantity for an accurate error payload (best-effort).
      const fresh = await tx.product.findUnique({
        where: { id: productId },
        select: { quantity: true },
      });
      const err = new Error('Insufficient stock to confirm this order');
      err.code = 'INSUFFICIENT_STOCK';
      err.details = [{
        productId,
        title: product?.title ?? null,
        requested,
        available: fresh?.quantity ?? 0,
      }];
      throw err;
    }
  }
}

/**
 * Restore catalog stock for all lines on this order (one SQL UPDATE). Used on cancel or revert after deduction.
 */
async function restoreInventoryForOrder(tx, orderId) {
  await tx.$executeRaw`
    UPDATE "Product" AS p
    SET quantity = p.quantity + sub.sum_qty
    FROM (
      SELECT "productId", SUM(quantity)::int AS sum_qty
      FROM "OrderItem"
      WHERE "orderId"::text = ${orderId}
      GROUP BY "productId"
    ) AS sub
    WHERE p.id = sub."productId"
  `;
}

/**
 * Lightweight status payload for post-checkout polling (customer or staff).
 */
async function getOrderStatusOnly(orderId, userId = null) {
  const where = { id: orderId };
  if (userId) where.userId = userId;

  const order = await prisma.order.findFirst({
    where,
    select: {
      id: true,
      userId: true,
      status: true,
      paymentStatus: true,
      totalAmount: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!order) return null;

  const statusOrder = ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'];
  const terminal = order.status === 'CANCELLED';
  const idx = statusOrder.indexOf(order.status);
  const progressIndex = terminal ? -1 : idx >= 0 ? idx : 0;

  return {
    id: order.id,
    status: order.status,
    paymentStatus: order.paymentStatus,
    totalAmount: decimalToNumber(order.totalAmount),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    progress: {
      currentStep: order.status,
      isTerminal: terminal || order.status === 'DELIVERED',
      typicalFlow: statusOrder,
      stepIndex: terminal ? null : progressIndex,
    },
  };
}

async function updateOrderStatus(orderId, status) {
  const valid = ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
  if (!valid.includes(status)) return null;

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        // Lock the order row for the life of the transaction. Without this, two
        // concurrent confirms (payment webhook + admin "Confirm", or callback +
        // reconcile job) both read inventoryDeducted=false under Read Committed and
        // each deducts stock — silently halving inventory. FOR UPDATE forces the second
        // caller to block, then re-read inventoryDeducted=true so needCommit is false.
        const locked = await tx.$queryRaw`SELECT id FROM "Order" WHERE id::text = ${orderId} FOR UPDATE`;
        if (!Array.isArray(locked) || locked.length === 0) return { notFound: true };

        const prev = await tx.order.findUnique({
          where: { id: orderId },
          select: { status: true, userId: true, inventoryDeducted: true },
        });
        if (!prev) return { notFound: true };

        if (prev.status === status) {
          const full = await tx.order.findUnique({
            where: { id: orderId },
            include: {
              items: { include: { product: { include: orderProductInclude } } },
            },
          });
          if (!full) return { notFound: true };
          return { payload: toOrderResponsePayload(full), notify: false };
        }

        // Deduct stock on first confirm — both COD (PENDING→CONFIRMED) and online
        // payment (AWAITING_PAYMENT→CONFIRMED, driven by confirmOrderPayment).
        const needCommit =
          !prev.inventoryDeducted &&
          (prev.status === 'PENDING' || prev.status === 'AWAITING_PAYMENT') &&
          status === 'CONFIRMED';
        // CANCELLED: always restore if stock was deducted (any prior status). PENDING: restore only when reverting from fulfilment.
        const needRelease =
          prev.inventoryDeducted &&
          (status === 'CANCELLED' ||
            (status === 'PENDING' && FULFILLING_STATUSES.includes(prev.status)));

        if (needCommit) await deductInventoryForOrder(tx, orderId);
        if (needRelease) await restoreInventoryForOrder(tx, orderId);

        const updated = await tx.order.update({
          where: { id: orderId },
          data: {
            status,
            ...(needCommit ? { inventoryDeducted: true } : {}),
            ...(needRelease ? { inventoryDeducted: false } : {}),
          },
          include: {
            items: { include: { product: { include: orderProductInclude } } },
          },
        });

        return {
          payload: toOrderResponsePayload(updated),
          notify: true,
          notifyUserId: prev.userId,
          notifyStatus: status,
        };
      },
      { maxWait: 5000, timeout: 10000 }
    );

    if (result.notFound) return null;
    if (result.notify && result.notifyUserId && result.notifyStatus) {
      notify.orderStatusChange(result.notifyUserId, orderId, result.notifyStatus);
    }
    return result.payload;
  } catch (err) {
    if (err.code === 'INSUFFICIENT_STOCK' || err.code === 'PRODUCT_MISSING') throw err;
    throw err;
  }
}

/**
 * Start an online payment for an existing order. Loads the order, asks MyFatoorah
 * to create a payment, stores the InvoiceId on the order, and returns the hosted
 * payment URL for the app to open. Caller must own the order.
 *
 * Returns { error } on a guard failure (wrong owner / state / method), otherwise
 * { paymentUrl, invoiceId }.
 */
async function initiateOrderPayment(orderId, userId) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: {
      id: true,
      totalAmount: true,
      status: true,
      paymentStatus: true,
      paymentMethod: true,
      shippingFullName: true,
      shippingPhone: true,
      user: { select: { email: true } },
    },
  });

  if (!order) return { error: 'Order not found' };
  if (order.paymentMethod !== 'MYFATOORAH') {
    return { error: 'This order is not set up for online payment' };
  }
  if (order.paymentStatus === 'PAID') return { error: 'Order is already paid' };
  // Payable only while awaiting payment (covers first attempt and retry after a failed one).
  if (order.status !== 'AWAITING_PAYMENT') return { error: 'Order can no longer be paid' };
  if (Number(order.totalAmount) <= 0) return { error: 'Order total must be greater than zero' };

  const { invoiceId, paymentUrl } = await paymentService.createPaymentInvoice(order, {
    name: order.shippingFullName,
    phone: order.shippingPhone,
    email: order.user?.email,
  });

  // Store the new invoice id and reset paymentStatus to UNPAID so a retry after a
  // previous FAILED attempt starts clean.
  await prisma.order.update({
    where: { id: order.id },
    data: { paymentInvoiceId: invoiceId, paymentStatus: 'UNPAID' },
  });

  return { paymentUrl, invoiceId };
}

/**
 * Verify a MyFatoorah payment (authoritative server-side check) and, if genuinely paid,
 * place the order: atomically mark it PAID, clear the cart, fire the "order placed" push,
 * and move AWAITING_PAYMENT → CONFIRMED (reusing updateOrderStatus, which deducts stock +
 * notifies). `key` is the PaymentId from the callback or InvoiceId from a webhook;
 * `keyType` selects which.
 *
 * Idempotent and race-safe: the PAID flip is a single conditional UPDATE, so only one of
 * N concurrent callers (callback + webhook + retries) ever places the order.
 *
 * Returns { isPaid, orderId, status, ...flags }.
 */
/**
 * Native Apple Pay — step 1. Create a MyFatoorah session for an order the caller owns.
 * Returns { sessionId, countryCode } for the mobile app, or { error } on a guard failure.
 * Same payable-state guards as initiateOrderPayment.
 */
async function createPaymentSession(orderId, userId) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: { id: true, status: true, paymentStatus: true, paymentMethod: true, totalAmount: true },
  });
  if (!order) return { error: 'Order not found' };
  if (order.paymentMethod !== 'MYFATOORAH') return { error: 'This order is not set up for online payment' };
  if (order.paymentStatus === 'PAID') return { error: 'Order is already paid' };
  if (order.status !== 'AWAITING_PAYMENT') return { error: 'Order can no longer be paid' };
  if (Number(order.totalAmount) <= 0) return { error: 'Order total must be greater than zero' };

  const session = await paymentService.initiateSession();
  return { sessionId: session.sessionId, countryCode: session.countryCode };
}

/**
 * Native Apple Pay — step 2. The app sends back the SessionId (now carrying the Apple
 * Pay token). We execute the charge server-side, then re-verify via GetPaymentStatus and
 * place the order through the same idempotent confirmOrderPayment path used by the
 * callback/webhook. Returns { isPaid, orderId, status, ... } or { error }.
 */
async function executeOrderPayment(orderId, userId, sessionId) {
  if (!sessionId) return { error: 'sessionId is required' };

  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      paymentMethod: true,
      totalAmount: true,
      shippingFullName: true,
      shippingPhone: true,
      user: { select: { email: true } },
    },
  });
  if (!order) return { error: 'Order not found' };
  if (order.paymentMethod !== 'MYFATOORAH') return { error: 'This order is not set up for online payment' };
  if (order.paymentStatus === 'PAID') return { isPaid: true, orderId, status: 'Paid', alreadyProcessed: true };
  if (order.status !== 'AWAITING_PAYMENT') return { error: 'Order can no longer be paid' };

  const exec = await paymentService.executePayment({
    sessionId,
    order,
    customer: { name: order.shippingFullName, email: order.user?.email, phone: order.shippingPhone },
  });

  if (exec.invoiceId) {
    await prisma.order.update({ where: { id: orderId }, data: { paymentInvoiceId: exec.invoiceId } });
  } else {
    return { isPaid: false, orderId, status: 'Failed', reason: 'No invoice returned by gateway' };
  }

  // Authoritative server-side confirmation (idempotent; deducts stock + places order on Paid).
  const result = await confirmOrderPayment(exec.invoiceId, 'InvoiceId');
  // paymentUrl is set for non-direct methods (e.g. a card needing 3-D Secure); for Apple
  // Pay it is normally null because the charge settles directly.
  return { ...result, paymentUrl: exec.paymentUrl || null, isDirectPayment: exec.isDirectPayment };
}

async function confirmOrderPayment(key, keyType = 'PaymentId') {
  const result = await paymentService.verifyPayment(key, keyType);
  const orderId = result.orderId;

  if (!orderId) {
    return { isPaid: false, orderId: null, status: result.status, reason: 'No order reference on payment' };
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      userId: true,
      totalAmount: true,
      status: true,
      paymentStatus: true,
      user: { select: { email: true } },
    },
  });
  if (!order) return { isPaid: false, orderId, status: result.status, reason: 'Order not found' };

  // Already settled — don't double-process (callback + webhook can both fire).
  if (order.paymentStatus === 'PAID') {
    return { isPaid: true, orderId, status: 'Paid', alreadyProcessed: true };
  }

  if (!result.isPaid) {
    // Mark FAILED only while still unpaid; never clobber a PAID order (race) or a
    // status set elsewhere. A later retry can still succeed (initiate resets to UNPAID).
    await prisma.order.updateMany({
      where: { id: orderId, paymentStatus: { in: ['UNPAID', 'FAILED'] } },
      data: { paymentStatus: 'FAILED' },
    });
    return { isPaid: false, orderId, status: result.status };
  }

  // Amount verification.
  //
  // UNDERPAYMENT (fatal): if the gateway settled in the SAME currency we charged in and
  // the paid value is materially LESS than the order total, do NOT confirm — that means
  // a partial/tampered payment and must never deliver goods. We withhold confirmation and
  // mark the order for manual review. We only enforce this when the currencies match, so a
  // legitimate cross-currency payer (different numeric value) is never wrongly stranded.
  const chargedCurrency = process.env.MYFATOORAH_CURRENCY || 'AED';
  const sameCurrency = !!result.currency && result.currency === chargedCurrency;
  if (
    result.invoiceValue != null &&
    sameCurrency &&
    result.invoiceValue + 0.01 < Number(order.totalAmount)
  ) {
    console.error(
      `[payment] order ${orderId} UNDERPAID: gateway ${result.invoiceValue} ${result.currency} vs order total ${order.totalAmount} — withholding confirmation for manual review`
    );
    await prisma.order.updateMany({
      where: { id: orderId, paymentStatus: { in: ['UNPAID', 'FAILED'] } },
      data: { paymentStatus: 'FAILED' },
    });
    return { isPaid: false, orderId, status: result.status, reason: 'amount_mismatch_underpaid' };
  }

  // OVERPAYMENT or cross-currency difference (non-fatal): the customer is not short-changed,
  // so we log and proceed rather than strand a genuinely-paid order.
  if (result.invoiceValue != null && Math.abs(result.invoiceValue - Number(order.totalAmount)) > 0.01) {
    console.warn(
      `[payment] amount/currency note for order ${orderId}: gateway value ${result.invoiceValue} ${result.currency || ''} vs order total ${order.totalAmount}`
    );
  }

  // Atomic claim: only the caller that flips a non-PAID order to PAID proceeds to place it.
  const claim = await prisma.order.updateMany({
    where: { id: orderId, paymentStatus: { not: 'PAID' } },
    data: { paymentStatus: 'PAID', paymentTransactionId: result.transactionId },
  });
  if (claim.count === 0) {
    // Lost the race — another caller already placed it. Idempotent success.
    return { isPaid: true, orderId, status: 'Paid', alreadyProcessed: true };
  }

  // Paid, but the order was already CANCELLED (e.g. admin cancelled before the payment
  // landed). Do NOT confirm/deduct stock — flag loudly for a manual refund.
  if (order.status === 'CANCELLED') {
    console.error(`[payment] order ${orderId} PAID but already CANCELLED — manual refund required`);
    return { isPaid: true, orderId, status: 'Paid', warning: 'order_cancelled_needs_refund' };
  }

  // Now placed: clear the cart (kept until now) and fire the "order placed" push.
  if (order.status === 'AWAITING_PAYMENT') {
    await prisma.cartItem.deleteMany({ where: { cart: { userId: order.userId } } }).catch((err) =>
      console.error(`[payment] order ${orderId} paid but cart clear failed: ${err.message}`)
    );
    await prisma.cart.updateMany({ where: { userId: order.userId }, data: { orderMessage: null } }).catch(() => {});
    notify.orderPlaced(order.userId, orderId);
    notify.orderConfirmationEmail({
      id: orderId,
      userEmail: order.user?.email,
      totalAmount: Number(order.totalAmount),
    });
  }

  // Auto-confirm (transactional stock deduction + status push). Payment is already
  // captured, so a stock shortfall here must not fail — the order stays PAID for staff
  // to resolve manually.
  if (order.status === 'AWAITING_PAYMENT' || order.status === 'PENDING') {
    try {
      await updateOrderStatus(orderId, 'CONFIRMED');
    } catch (err) {
      console.error(`[payment] order ${orderId} paid but could not auto-confirm: ${err.message}`);
    }
  }

  return { isPaid: true, orderId, status: 'Paid' };
}

module.exports = {
  createOrder,
  getOrderById,
  getAllOrdersAdmin,
  getMyOrderHistory,
  getAdminOrderHistory,
  getOrderStatusOnly,
  updateOrderStatus,
  initiateOrderPayment,
  createPaymentSession,
  executeOrderPayment,
  confirmOrderPayment,
};
