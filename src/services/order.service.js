const prisma = require('../config/db');
const cartService = require('../services/cart.service');
const pushNotificationService = require('../services/pushNotification.service');

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
  const descriptions = descs.map((d) => ({ id: d.id, title: d.title ?? null, description: d.description }));
  const productOptionsList = (product.productOptions || [])
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((o) => ({ id: o.id, title: o.title, options: Array.isArray(o.options) ? o.options : [] }));
  return {
    id: product.id,
    title: product.title,
    subtitle: product.subtitle ?? null,
    image: urls[0] ?? null,
    images: urls,
    descriptions,
    productOptions: productOptionsList,
  };
}

function toOrderResponsePayload(order) {
  const items = (order.items || []).map((i) => ({
    id: i.id,
    productId: i.productId,
    product: mapProductForDisplay(i.product),
    quantity: i.quantity,
    perProductMessage: i.perProductMessage,
    price: decimalToNumber(i.price),
  }));
  return {
    id: order.id,
    userId: order.userId,
    orderMessage: order.orderMessage,
    totalAmount: decimalToNumber(order.totalAmount),
    status: order.status,
    inventoryDeducted: Boolean(order.inventoryDeducted),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items,
  };
}

async function createOrder(userId) {
  const cartData = await cartService.getCart(userId);
  if (!cartData.items || cartData.items.length === 0) {
    return { order: null, error: 'Cart is empty' };
  }

  const order = await prisma.$transaction(async (tx) => {
    const orderRecord = await tx.order.create({
      data: {
        userId,
        orderMessage: cartData.orderMessage ?? null,
        totalAmount: cartData.totalAmount,
        status: 'PENDING',
      },
    });

    await tx.orderItem.createMany({
      data: cartData.items.map((item) => ({
        orderId: orderRecord.id,
        productId: item.productId,
        quantity: item.quantity,
        perProductMessage: item.message ?? null,
        price: item.lineTotal / item.quantity,
      })),
    });

    const cart = await tx.cart.findUnique({ where: { userId } });
    if (cart) {
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      await tx.cart.update({
        where: { id: cart.id },
        data: { orderMessage: null },
      });
    }

    return tx.order.findUnique({
      where: { id: orderRecord.id },
      include: {
        items: {
          include: { product: { include: orderProductInclude } },
        },
      },
    });
  });

  const payload = toOrderResponsePayload(order);

  pushNotificationService.notifyOrderPlaced(userId, order.id).catch((err) => {
    console.error('[push] notifyOrderPlaced:', err.message);
  });

  return {
    order: payload,
    error: null,
  };
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
  const where = status ? { status } : {};

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
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
      firstName: order.user.firstName,
      lastName: order.user.lastName,
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
      product: mapProductForDisplay(i.product),
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
  const where = { userId, ...(status ? { status } : {}) };

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
  const where = {};

  if (filters.status) where.status = filters.status;
  if (filters.userId) where.userId = filters.userId;
  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {};
    if (filters.dateFrom) where.createdAt.gte = new Date(filters.dateFrom);
    if (filters.dateTo) where.createdAt.lte = new Date(filters.dateTo);
  }

  const includeItems = filters.includeItems === true || filters.includeItems === 'true';

  const include = {
    user: { select: { id: true, email: true, firstName: true, lastName: true } },
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
 * Subtract Product.quantity for each distinct product on the order (single validation query + one SQL UPDATE).
 */
async function deductInventoryForOrder(tx, orderId) {
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: { productId: true, quantity: true },
  });
  if (items.length === 0) return;

  const qtyByProduct = aggregateOrderLineQtyByProduct(items);
  const productIds = [...qtyByProduct.keys()];

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

  await tx.$executeRaw`
    UPDATE "Product" AS p
    SET quantity = p.quantity - sub.sum_qty
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

        const needCommit = !prev.inventoryDeducted && prev.status === 'PENDING' && status === 'CONFIRMED';
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
      pushNotificationService
        .notifyOrderStatusChange(result.notifyUserId, orderId, result.notifyStatus)
        .catch((err) => console.error('[push] notifyOrderStatusChange:', err.message));
    }
    return result.payload;
  } catch (err) {
    if (err.code === 'INSUFFICIENT_STOCK' || err.code === 'PRODUCT_MISSING') throw err;
    throw err;
  }
}

module.exports = {
  createOrder,
  getOrderById,
  getAllOrdersAdmin,
  getMyOrderHistory,
  getAdminOrderHistory,
  getOrderStatusOnly,
  updateOrderStatus,
};
