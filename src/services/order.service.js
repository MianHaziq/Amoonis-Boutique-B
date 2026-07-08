const prisma = require('../config/db');
const cartService = require('../services/cart.service');
const notify = require('../notifications/notify');
const promoCodeService = require('../services/promoCode.service');
const paymentService = require('../services/payment.service');
const regionService = require('../services/region.service');
const productService = require('../services/product.service');

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
    orderNumber: order.orderNumber ?? null,
    userId: order.userId,
    orderMessage: order.orderMessage,
    totalAmount: decimalToNumber(order.totalAmount),
    discountAmount: decimalToNumber(order.discountAmount),
    appliedPromoCode: order.appliedPromoCode ?? null,
    paymentMethod: order.paymentMethod ?? 'COD',
    paymentStatus: order.paymentStatus ?? 'UNPAID',
    status: order.status,
    // Currency the order was totaled in ("AED"/"SAR"); legacy orders predating
    // multi-currency have none, so default to the store's base currency.
    currency: order.currency ?? 'AED',
    regionId: order.regionId ?? null,
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

/**
 * Shared order-creation core used by BOTH cart checkout and "Buy Now". It takes a
 * normalized list of line items so the pricing / promo / region / address / stock /
 * transaction logic lives in exactly one place (no drift between the two flows).
 *
 * params:
 *   lineItems    [{ productId, quantity, message? }]  — what to order
 *   orderMessage string|null                          — order-level note
 *   addressId | shippingAddress                       — where to ship
 *   paymentMethod 'COD' | 'MYFATOORAH'
 *   promoCode    string|null
 *   clearCart    boolean  — clear the user's cart when the order is placed (true for cart
 *                           checkout, false for Buy Now so the cart is left untouched)
 */
async function createOrderCore(userId, params = {}, opts = {}) {
  const {
    lineItems,
    orderMessage = null,
    addressId,
    shippingAddress,
    paymentMethod = 'COD',
    promoCode,
    clearCart = true,
  } = params;

  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return { order: null, error: 'No items to order' };
  }

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
    select: { fullName: true, phone: true, regionId: true, createdAt: true },
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
  const orderRegion = orderRegionId ? await regionService.getRegionById(orderRegionId) : null;
  // Which currency this order is priced/charged in — drives priceSar vs price selection
  // (see productService.regionPriceFromRow) and the order's stamped Order.currency.
  const orderCurrency = orderRegion?.currency || 'AED';

  // Online payment currently only works for the gateway's configured currency (AED).
  // A region charging a different currency (e.g. Saudi/SAR) must use Cash on Delivery
  // until a region-specific payment setup exists.
  if (isOnlinePayment && orderCurrency !== paymentService.getConfiguredCurrency()) {
    return {
      order: null,
      error: 'Online payment isn’t available for this region yet — please choose Cash on Delivery.',
    };
  }

  // Resolve the shipping address: a saved addressId or an inline shippingAddress.
  let resolvedAddress = null;

  if (addressId) {
    const saved = await prisma.address.findFirst({ where: { id: addressId, userId } });
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
  } else {
    return { order: null, error: 'A shipping address is required. Provide addressId or shippingAddress.' };
  }

  const productIds = lineItems.map((it) => it.productId);
  const productRows = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      title: true,
      title_ar: true,
      categoryId: true,
      price: true,
      discountedPrice: true,
      priceSar: true,
      discountedPriceSar: true,
      quantity: true,
    },
  });
  const productById = new Map(productRows.map((p) => [p.id, p]));

  // Early stock visibility check — surfaces OUT_OF_STOCK before order creation so the
  // mobile app can show a friendly message instead of completing checkout for unavailable
  // items. Final atomic enforcement still happens at PENDING→CONFIRMED.
  const outOfStock = [];
  for (const it of lineItems) {
    const p = productById.get(it.productId);
    if (!p) {
      return { order: null, error: 'A product in your order is no longer available' };
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
  // Mirrors cart.service.effectivePrice EXACTLY (discounted only when it's actually lower
  // than the base price) so the order never charges more than the cart displayed (M2).
  // Resolves to the order's region currency (AED price/discountedPrice, or the manual
  // SAR override when set) via productService.regionPriceFromRow.
  function livePrice(productRow) {
    if (!productRow) return 0;
    const { price, discountedPrice } = productService.regionPriceFromRow(productRow, orderCurrency);
    return discountedPrice != null && discountedPrice < price ? discountedPrice : price;
  }
  const livePriceById = new Map(productRows.map((p) => [p.id, livePrice(p)]));

  const promoItems = lineItems.map((item) => ({
    productId: item.productId,
    quantity: item.quantity,
    price: livePriceById.get(item.productId) ?? 0,
    categoryId: productById.get(item.productId)?.categoryId ?? null,
  }));

  // Validate and compute promo discount before the transaction (read-only)
  let promoResult = null;
  if (promoCode) {
    try {
      promoResult = await promoCodeService.validateAndCalculate(promoCode, userId, promoItems, orderRegionId);
    } catch (err) {
      const promoErrors = new Set([
        'PROMO_NOT_FOUND', 'PROMO_INACTIVE', 'PROMO_EXPIRED', 'PROMO_NOT_STARTED',
        'PROMO_LIMIT_REACHED', 'PROMO_USER_LIMIT_REACHED', 'PROMO_MIN_ORDER_NOT_MET',
        'PROMO_MAX_ORDER_EXCEEDED', 'PROMO_NO_ELIGIBLE_ITEMS', 'PROMO_INVALID_INPUT',
        'PROMO_NEW_USERS_ONLY', 'PROMO_REGION_NOT_AVAILABLE',
      ]);
      if (promoErrors.has(err.code)) return { order: null, error: err.message };
      throw err;
    }
  }

  let createdOrderId;
  try {
  await prisma.$transaction(async (tx) => {
    // Re-read prices inside the tx so the values written to OrderItem.price and
    // Order.totalAmount reflect the current catalog, not a cart snapshot. Stock isn't
    // deducted here (that happens at confirm), but a price edit between cart load and
    // tx commit must not cause customer/admin to disagree on what was paid.
    const livePriceRows = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        price: true,
        discountedPrice: true,
        priceSar: true,
        discountedPriceSar: true,
      },
    });
    // Same effective-price rule as cart/livePrice (M2): discounted only when lower,
    // resolved to the order's region currency (AED or the manual SAR override).
    const txPriceById = new Map(
      livePriceRows.map((p) => {
        const { price, discountedPrice } = productService.regionPriceFromRow(p, orderCurrency);
        return [p.id, discountedPrice != null && discountedPrice < price ? discountedPrice : price];
      })
    );

    // Recompute line totals and order subtotal from live prices.
    let txSubtotal = 0;
    const itemPriceById = new Map();
    for (const item of lineItems) {
      const livePriceVal = txPriceById.get(item.productId) ?? livePriceById.get(item.productId) ?? 0;
      itemPriceById.set(item.productId, livePriceVal);
      txSubtotal += livePriceVal * item.quantity;
    }
    txSubtotal = Math.round(txSubtotal * 100) / 100;

    // Re-validate the promo and RECOMPUTE the discount against the live tx prices — never
    // trust the preview amount. This catches price edits, active/window toggles, cap
    // exhaustion, min/max-order drift, and account-age (new-users-only) changes between
    // preview and commit. Any failure throws a tagged PROMO_* error the outer catch maps
    // to a friendly 400 and rolls the whole order back.
    let finalDiscount = null;
    if (promoResult) {
      const promoId = promoResult.promoCode.id;

      // PROMO-1: take a row lock on this promo for the rest of the transaction. The
      // per-user usage check below is a COUNT, which under Read Committed two concurrent
      // orders could both pass before either commits — letting a user exceed
      // usageLimitPerUser (or re-redeem a single-use / new-user code). Locking the promo
      // row serializes all concurrent redemptions of THIS code so the count is accurate.
      // (The global cap is already race-safe via the conditional UPDATE further down.)
      await tx.$queryRaw`SELECT id FROM "PromoCode" WHERE id::text = ${promoId} FOR UPDATE`;

      const livePromo = await tx.promoCode.findUnique({
        where: { id: promoId },
        select: {
          isActive: true,
          startsAt: true,
          expiresAt: true,
          usageLimit: true,
          usageCount: true,
          usageLimitPerUser: true,
          newUsersOnly: true,
          newUserWithinDays: true,
          discountType: true,
          discountValue: true,
          maxDiscountAmount: true,
          appliesTo: true,
          minOrderAmount: true,
          maxOrderAmount: true,
          products: { select: { productId: true } },
          categories: { select: { categoryId: true } },
          regions: { select: { regionId: true } },
        },
      });
      if (!livePromo) {
        const err = new Error('Promo code not found');
        err.code = 'PROMO_NOT_FOUND';
        throw err;
      }

      // Per-user cap — count existing usages inside the tx, then assert all non-amount
      // rules (active/window/global cap/per-user cap/new-users-only) in one place. Race
      // window on the per-user cap is narrowed but not fully closed without a unique index;
      // the global cap is closed by the atomic conditional UPDATE below.
      const userPriorUsage =
        livePromo.usageLimitPerUser != null
          ? await tx.promoCodeUsage.count({ where: { promoCodeId: promoId, userId } })
          : 0;
      promoCodeService.assertPromoUsable(livePromo, {
        userPriorUsage,
        userCreatedAt: userRow?.createdAt ?? null,
        regionId: orderRegionId,
      });

      // Recompute the discount on the live tx prices. computeDiscount re-checks
      // min/maxOrderAmount and item eligibility, so a price drift that breaks those throws
      // here rather than silently applying a stale discount.
      const txItems = lineItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        price: itemPriceById.get(item.productId) ?? 0,
        categoryId: productById.get(item.productId)?.categoryId ?? null,
      }));
      finalDiscount = promoCodeService.computeDiscount(livePromo, txItems).discountAmount;
      // Belt-and-suspenders: never exceed the recomputed subtotal.
      finalDiscount = Math.round(Math.min(Number(finalDiscount), txSubtotal) * 100) / 100;
    }

    const finalTotal = Math.round(Math.max(0, txSubtotal - (finalDiscount ?? 0)) * 100) / 100;

    // Online payment cannot charge a 0 (or negative) amount — MyFatoorah rejects it. If a
    // promo wipes the entire total, the customer must use Cash on Delivery instead.
    if (isOnlinePayment && finalTotal <= 0) {
      const err = new Error('This order total is 0 after the discount; please choose Cash on Delivery.');
      err.code = 'PROMO_ZERO_TOTAL_ONLINE';
      throw err;
    }

    const orderRecord = await tx.order.create({
      data: {
        userId,
        orderMessage: orderMessage ?? null,
        clearCartOnPayment: clearCart,
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
        currency: orderCurrency,
        status: initialStatus,
        // Stock is reserved (deducted) below inside this same transaction (H1), so the
        // order is created already flagged as having deducted inventory. If the deduction
        // throws (concurrent order took the last unit) the whole transaction rolls back.
        inventoryDeducted: true,
      },
    });

    createdOrderId = orderRecord.id;

    // Reserve the promo: atomic global-cap increment + a usage row linked to this order.
    // Eligibility (active/window/caps/new-user) and the discount amount were already
    // re-validated above against live data; the conditional UPDATE here closes the race on
    // the global counter (only succeeds if usageLimit still allows it). The usage row is
    // released again if this order is later cancelled unpaid (see releasePromoUsageForOrder).
    if (promoResult) {
      const promoId = promoResult.promoCode.id;

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
          discountAmount: finalDiscount ?? 0,
        },
      });
    }

    // Parallel: insert items, clear cart — all depend only on orderRecord.id.
    // OrderItem.price uses the live tx price so the stored line snapshot matches the
    // server-trusted total above.
    await Promise.all([
      tx.orderItem.createMany({
        data: lineItems.map((item) => ({
          orderId: orderRecord.id,
          productId: item.productId,
          productTitle: productById.get(item.productId)?.title ?? null,
          productTitle_ar: productById.get(item.productId)?.title_ar ?? null,
          quantity: item.quantity,
          perProductMessage: item.message ?? null,
          price: itemPriceById.get(item.productId) ?? 0,
        })),
      }),
      // Clear the cart only for a cart checkout (clearCart) paid up front (COD). Online
      // orders keep the cart until paid (cleared in confirmOrderPayment, also gated on
      // clearCartOnPayment). Buy Now (clearCart=false) never touches the cart.
      ...(!isOnlinePayment && clearCart
        ? [
            tx.cartItem.deleteMany({ where: { cart: { userId } } }),
            tx.cart.updateMany({ where: { userId }, data: { orderMessage: null } }),
          ]
        : []),
    ]);

    // Reserve stock at placement (H1). One atomic conditional UPDATE per product (same
    // helper used at confirm). If a concurrent order already took the last unit this
    // throws INSUFFICIENT_STOCK and the whole order transaction rolls back — closing the
    // oversell window where many orders could be placed against the same last unit and
    // only fail later at confirm. Online (AWAITING_PAYMENT) orders therefore hold their
    // stock until paid; abandoned ones are released by the order.expire-unpaid job.
    await deductInventoryForOrder(tx, orderRecord.id);
  }, { maxWait: 5000, timeout: 15000 });
  } catch (err) {
    // Convert known business-rule errors thrown from inside the tx into the same
    // `{ order: null, error: msg }` shape the controller already maps to a 400.
    const userFacingPromoCodes = new Set([
      'PROMO_NOT_FOUND', 'PROMO_INACTIVE', 'PROMO_EXPIRED', 'PROMO_NOT_STARTED',
      'PROMO_LIMIT_REACHED', 'PROMO_USER_LIMIT_REACHED', 'PROMO_MIN_ORDER_NOT_MET',
      'PROMO_MAX_ORDER_EXCEEDED', 'PROMO_NO_ELIGIBLE_ITEMS', 'PROMO_EMPTY_CART',
      'PROMO_NEW_USERS_ONLY', 'PROMO_ZERO_TOTAL_ONLINE', 'PROMO_REGION_NOT_AVAILABLE',
    ]);
    if (userFacingPromoCodes.has(err.code)) {
      return { order: null, error: err.message };
    }
    // Stock reservation (H1) failed inside the tx — surface the same friendly shape the
    // pre-flight OUT_OF_STOCK check uses so the controller returns a 400, not a 500.
    if (err.code === 'INSUFFICIENT_STOCK') {
      const first = Array.isArray(err.details) ? err.details[0] : null;
      const msg = first
        ? `${first.title || 'An item'}: only ${first.available} in stock (you requested ${first.requested})`
        : 'Insufficient stock to place this order';
      return { order: null, error: msg };
    }
    if (err.code === 'PRODUCT_MISSING') {
      return { order: null, error: 'A product in your order is no longer available' };
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
    notify.adminNewOrder({
      orderId: createdOrderId,
      orderNumber: payload.orderNumber,
      totalAmount: payload.totalAmount,
      buyerId: userId,
    });
    notify.orderConfirmationEmail({ orderId: createdOrderId, to: order.user?.email });
  }

  return { order: payload, error: null };
}

/**
 * Cart checkout: turn the user's whole cart into one order (clears the cart on placement).
 * Thin wrapper over createOrderCore.
 */
async function createOrder(userId, checkoutInput = {}, opts = {}) {
  const { addressId, shippingAddress, paymentMethod = 'COD', promoCode } = checkoutInput;

  const cartData = await cartService.getCart(userId);
  if (!cartData.items || cartData.items.length === 0) {
    return { order: null, error: 'Cart is empty' };
  }

  const lineItems = cartData.items.map((it) => ({
    productId: it.productId,
    quantity: it.quantity,
    message: it.message ?? null,
  }));

  return createOrderCore(
    userId,
    { lineItems, orderMessage: cartData.orderMessage ?? null, addressId, shippingAddress, paymentMethod, promoCode, clearCart: true },
    opts
  );
}

/**
 * Buy Now: order a SINGLE product directly from the product page WITHOUT touching the cart.
 * The product must exist and be PUBLISHED (the client sends an arbitrary productId, so we
 * never let a draft/archived item be bought directly). Everything else — pricing, promo,
 * region, address, stock, the AWAITING_PAYMENT/COD split — is identical to cart checkout
 * because it runs through the same createOrderCore.
 */
async function buyNow(userId, input = {}, opts = {}) {
  const { productId, quantity = 1, addressId, shippingAddress, paymentMethod = 'COD', promoCode, message } = input;

  if (!productId || typeof productId !== 'string') {
    return { order: null, error: 'productId is required' };
  }
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1) {
    return { order: null, error: 'quantity must be a positive integer' };
  }

  // Guard: only a published product can be bought directly (cart items were already visible;
  // a Buy Now productId comes straight from the client and must be validated).
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, status: true },
  });
  if (!product || product.status !== 'PUBLISHED') {
    return { order: null, error: 'Product is not available for purchase' };
  }

  return createOrderCore(
    userId,
    {
      lineItems: [{ productId, quantity: qty, message: message ?? null }],
      orderMessage: null,
      addressId,
      shippingAddress,
      paymentMethod,
      promoCode,
      clearCart: false, // never touch the user's cart for a direct purchase
    },
    opts
  );
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

async function getAllOrdersAdmin(page = 1, limit = 10, status = null, regionId = null) {
  const skip = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, limit));
  const take = Math.min(100, Math.max(1, limit));
  const where = { ...listStatusFilter(status), ...(regionId ? { regionId } : {}) };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, email: true, fullName: true } },
        region: { select: { id: true, code: true, name: true } },
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
    currency: o.currency ?? 'AED',
    status: o.status,
    region: o.region ? { id: o.region.id, code: o.region.code, name: o.region.name } : null,
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
    currency: order.currency ?? 'AED',
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
  if (order.region) {
    base.region = { id: order.region.id, code: order.region.code, name: order.region.name };
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
  if (filters.regionId) where.regionId = filters.regionId;
  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {};
    if (filters.dateFrom) where.createdAt.gte = new Date(filters.dateFrom);
    if (filters.dateTo) where.createdAt.lte = new Date(filters.dateTo);
  }

  const includeItems = filters.includeItems === true || filters.includeItems === 'true';

  const include = {
    user: { select: { id: true, email: true, fullName: true } },
    region: { select: { id: true, code: true, name: true } },
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
 * Release the promo reservation held by an order that is being cancelled. Promo usage is
 * reserved at placement (so the global/per-user caps hold the slot through the
 * AWAITING_PAYMENT window), mirroring how stock is reserved at placement. When the order is
 * cancelled — unpaid-expiry, admin cancel, or a failed online payment — that reservation
 * must be returned: delete the usage row(s) for this order and decrement each affected
 * promo's usageCount (floored at 0). Idempotent: a no-promo order or an already-released
 * order deletes nothing and decrements nothing. Must run inside the same transaction that
 * flips the order to CANCELLED so the two can't diverge.
 */
async function releasePromoUsageForOrder(tx, orderId) {
  const usages = await tx.promoCodeUsage.findMany({
    where: { orderId },
    select: { promoCodeId: true },
  });
  if (usages.length === 0) return;

  await tx.promoCodeUsage.deleteMany({ where: { orderId } });

  const countByPromo = new Map();
  for (const u of usages) {
    countByPromo.set(u.promoCodeId, (countByPromo.get(u.promoCodeId) || 0) + 1);
  }
  for (const [promoCodeId, n] of countByPromo) {
    await tx.$executeRaw`
      UPDATE "PromoCode"
      SET "usageCount" = GREATEST(0, "usageCount" - ${n}), "updatedAt" = NOW()
      WHERE id::text = ${promoCodeId}
    `;
  }
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

        // Cancelling returns any promo reservation this order held (independent of stock —
        // a code can be released even on an order whose inventory wasn't deducted). The
        // helper is a no-op for orders without a promo or already released.
        if (status === 'CANCELLED' && prev.status !== 'CANCELLED') {
          await releasePromoUsageForOrder(tx, orderId);
        }

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

  // Double-charge guard (H5). ExecutePayment is NOT idempotent — a double-tap (or retry
  // while the first charge is still in flight) could charge the card twice. Atomically
  // claim an in-flight execution by writing a transient marker into paymentTransactionId
  // (which is otherwise null until a payment is confirmed PAID). The single-statement
  // conditional UPDATE means only ONE concurrent caller wins the `IS NULL` claim; the
  // others bail without charging. The marker is always cleared below unless the order ends
  // up PAID, so a genuine retry after a failed charge is never blocked.
  const EXEC_MARKER = 'EXECUTING';
  const claim = await prisma.order.updateMany({
    where: { id: orderId, paymentStatus: { not: 'PAID' }, paymentTransactionId: null },
    data: { paymentTransactionId: EXEC_MARKER },
  });
  if (claim.count === 0) {
    // Either it was just paid, or another execute is already in flight for this order.
    const cur = await prisma.order.findUnique({ where: { id: orderId }, select: { paymentStatus: true } });
    if (cur?.paymentStatus === 'PAID') return { isPaid: true, orderId, status: 'Paid', alreadyProcessed: true };
    return { isPaid: false, orderId, status: 'Processing', reason: 'payment_already_in_progress' };
  }

  try {
    const exec = await paymentService.executePayment({
      sessionId,
      order,
      customer: { name: order.shippingFullName, email: order.user?.email, phone: order.shippingPhone },
    });

    if (!exec.invoiceId) {
      // The gateway may still have charged the card but returned no InvoiceId, so we cannot
      // verify or reconcile it automatically. Escalate loudly with the order reference.
      console.error(
        `[payment] order ${orderId} ExecutePayment returned NO InvoiceId — the card may have been charged; manual reconciliation required (CustomerReference=${orderId})`
      );
      return { isPaid: false, orderId, status: 'Failed', reason: 'No invoice returned by gateway' };
    }

    await prisma.order.update({ where: { id: orderId }, data: { paymentInvoiceId: exec.invoiceId } });

    // Authoritative server-side confirmation (idempotent; places order + advances status on Paid).
    const result = await confirmOrderPayment(exec.invoiceId, 'InvoiceId');
    // paymentUrl is set for non-direct methods (e.g. a card needing 3-D Secure); for Apple
    // Pay it is normally null because the charge settles directly.
    return { ...result, paymentUrl: exec.paymentUrl || null, isDirectPayment: exec.isDirectPayment };
  } finally {
    // Release the in-flight marker unless the order is now PAID (in which case confirmOrderPayment
    // already overwrote paymentTransactionId with the real gateway transaction id). This lets a
    // failed/unconfirmed attempt be retried, and never clobbers a real transaction id.
    await prisma.order
      .updateMany({
        where: { id: orderId, paymentTransactionId: EXEC_MARKER, paymentStatus: { not: 'PAID' } },
        data: { paymentTransactionId: null },
      })
      .catch(() => {});
  }
}

/**
 * Place a now-PAID order: clear the cart (unless a Buy Now order), fire the "order placed"
 * notifications, and auto-confirm (AWAITING_PAYMENT/PENDING → CONFIRMED). Idempotent and
 * safe to call again on a stranded-but-PAID order (recovery): cart clear is a no-op on an
 * empty cart, updateOrderStatus won't re-deduct already-reserved stock, and notifications
 * are only sent on the first placement. Payment is already captured, so a confirm failure
 * must never throw — the order stays PAID for staff/reconcile to resolve.
 *
 * @param {object} order  the order row (status/userId/clearCartOnPayment/email)
 * @param {{ firstPlacement: boolean }} opts  send "order placed" notifications only when true
 */
async function finalizePaidOrder(order, { firstPlacement } = {}) {
  const orderId = order.id;

  // Paid, but already CANCELLED (e.g. admin cancelled before payment landed). Do NOT
  // confirm/deduct — flag loudly for a manual refund.
  if (order.status === 'CANCELLED') {
    console.error(`[payment] order ${orderId} PAID but already CANCELLED — manual refund required`);
    return;
  }

  // Clear the cart (kept until now) for a normal online checkout. Buy Now orders
  // (clearCartOnPayment=false) must NOT wipe the user's real cart.
  if (order.status === 'AWAITING_PAYMENT') {
    if (order.clearCartOnPayment !== false) {
      await prisma.cartItem.deleteMany({ where: { cart: { userId: order.userId } } }).catch((err) =>
        console.error(`[payment] order ${orderId} paid but cart clear failed: ${err.message}`)
      );
      await prisma.cart.updateMany({ where: { userId: order.userId }, data: { orderMessage: null } }).catch(() => {});
    }
    if (firstPlacement) {
      // Online orders auto-confirm immediately below, which sends the customer an
      // "Order confirmed" push — so we deliberately do NOT also send "Order placed"
      // (that would be two near-identical pushes within a second). COD keeps "Order
      // placed" because it's confirmed manually later. Staff alert + email still fire.
      notify.adminNewOrder({
        orderId,
        orderNumber: order.orderNumber,
        totalAmount: Number(order.totalAmount),
        buyerId: order.userId,
      });
      notify.orderConfirmationEmail({ orderId, to: order.user?.email });
    }
  }

  // Auto-confirm. Stock was already reserved at placement (H1), so this only moves the
  // status forward (no re-deduction). A failure here must not propagate.
  if (order.status === 'AWAITING_PAYMENT' || order.status === 'PENDING') {
    try {
      await updateOrderStatus(orderId, 'CONFIRMED');
    } catch (err) {
      console.error(`[payment] order ${orderId} paid but could not auto-confirm: ${err.message}`);
    }
  }
}

/**
 * Verify a MyFatoorah payment (authoritative server-side check) and, if genuinely paid,
 * place the order: atomically mark it PAID, clear the cart, fire the "order placed" push,
 * and move AWAITING_PAYMENT → CONFIRMED. `key` is the PaymentId from the callback or the
 * InvoiceId from a webhook / session execute; `keyType` selects which.
 *
 * Idempotent and race-safe: the PAID flip is a single conditional UPDATE, so only one of
 * N concurrent callers (callback + webhook + SDK execute + retries) ever places the order.
 *
 * Returns { isPaid, orderId, status, ...flags }.
 */
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
      orderNumber: true,
      userId: true,
      totalAmount: true,
      status: true,
      paymentStatus: true,
      clearCartOnPayment: true,
      inventoryDeducted: true,
      user: { select: { email: true } },
    },
  });
  if (!order) return { isPaid: false, orderId, status: result.status, reason: 'Order not found' };

  // Already settled — don't double-process (callback + webhook can both fire). BUT a prior
  // attempt may have flipped the order PAID and then crashed/failed before it was actually
  // placed (the PAID flip and the CONFIRMED transition are separate steps). If the order is
  // PAID yet still sitting in AWAITING_PAYMENT/PENDING, re-drive placement idempotently so it
  // can never be stranded "PAID but never confirmed" (C1). Stock was already reserved at
  // placement (H1), so this only advances the status; it does not re-deduct.
  if (order.paymentStatus === 'PAID') {
    if (order.status === 'AWAITING_PAYMENT' || order.status === 'PENDING') {
      await finalizePaidOrder(order, { firstPlacement: false });
    }
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
  const currencyKnown = !!result.currency;
  const sameCurrency = currencyKnown && result.currency === chargedCurrency;
  const underpaid =
    result.invoiceValue != null && result.invoiceValue + 0.01 < Number(order.totalAmount);
  // Fail CLOSED (C2): reject a short payment whenever the currency is the SAME as charged
  // OR the gateway did not report a currency at all. Only a *known, different* currency
  // (a genuine cross-currency settlement whose numeric value legitimately differs) is
  // allowed to pass. A missing/unknown currency must never let an underpayment through.
  if (underpaid && (sameCurrency || !currencyKnown)) {
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

  // Won the claim — place the order (cart clear + "order placed" notifications + auto-confirm).
  await finalizePaidOrder(order, { firstPlacement: true });

  // Paid, but the order was already CANCELLED (e.g. admin cancelled before the payment
  // landed). finalizePaidOrder flagged it for manual refund and did not confirm/deduct.
  if (order.status === 'CANCELLED') {
    return { isPaid: true, orderId, status: 'Paid', warning: 'order_cancelled_needs_refund' };
  }

  return { isPaid: true, orderId, status: 'Paid' };
}

module.exports = {
  createOrder,
  buyNow,
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
