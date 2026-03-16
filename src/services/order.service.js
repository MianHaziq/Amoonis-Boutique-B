const prisma = require('../config/db');
const cartService = require('../services/cart.service');
const productService = require('../services/product.service');

function decimalToNumber(v) {
  return v == null ? null : Number(v);
}

function mapProductForDisplay(product) {
  if (!product) return null;
  const imgs = (product.images || []).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const urls = imgs.map((i) => i.url);
  return {
    id: product.id,
    title: product.title,
    subtitle: product.subtitle ?? null,
    image: urls[0] ?? null,
    images: urls,
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

    for (const item of cartData.items) {
      const price = item.lineTotal / item.quantity;
      await tx.orderItem.create({
        data: {
          orderId: orderRecord.id,
          productId: item.productId,
          quantity: item.quantity,
          perProductMessage: item.message ?? null,
          price,
        },
      });
    }

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
          include: { product: { include: { images: { orderBy: { sortOrder: 'asc' } } } } },
        },
      },
    });
  });

  const items = order.items.map((i) => ({
    id: i.id,
    productId: i.productId,
    product: mapProductForDisplay(i.product),
    quantity: i.quantity,
    perProductMessage: i.perProductMessage,
    price: decimalToNumber(i.price),
  }));

  return {
    order: {
      id: order.id,
      userId: order.userId,
      orderMessage: order.orderMessage,
      totalAmount: decimalToNumber(order.totalAmount),
      status: order.status,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      items,
    },
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
        include: { product: { include: { images: { orderBy: { sortOrder: 'asc' } } } } },
      },
    },
  });

  if (!order) return null;
  const items = order.items.map((i) => ({
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
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items,
  };
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

async function updateOrderStatus(orderId, status) {
  const valid = ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
  if (!valid.includes(status)) return null;
  const order = await prisma.order.update({
    where: { id: orderId },
    data: { status },
    include: {
      items: {
        include: { product: { include: { images: { orderBy: { sortOrder: 'asc' } } } } },
      },
    },
  });
  const items = order.items.map((i) => ({
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
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items,
  };
}

module.exports = {
  createOrder,
  getOrderById,
  getAllOrdersAdmin,
  updateOrderStatus,
};
