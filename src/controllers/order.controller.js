const orderService = require('../services/order.service');
const { success, error } = require('../utils/response');

async function createOrder(req, res, next) {
  try {
    const userId = req.userId;
    const { order, error: errMsg } = await orderService.createOrder(userId);
    if (errMsg) return error(res, errMsg, 400);
    return success(res, order, 'Order placed successfully', 201);
  } catch (err) {
    next(err);
  }
}

async function getOrderById(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const canViewAnyOrder = req.isAdmin === true || req.canViewAllOrders === true;
    const order = await orderService.getOrderById(id, canViewAnyOrder ? null : userId);
    if (!order) return error(res, 'Order not found', 404);
    return success(res, order, 'Order fetched successfully');
  } catch (err) {
    next(err);
  }
}

async function getAllOrdersAdmin(req, res, next) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const status = req.query.status || null;
    const result = await orderService.getAllOrdersAdmin(page, limit, status);
    return success(res, result.data, 'Orders fetched successfully', 200, {
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function updateOrderStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const order = await orderService.updateOrderStatus(id, status);
    if (!order) return error(res, 'Order not found or invalid status', 404);
    return success(res, order, 'Order status updated');
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'Order not found', 404);
    if (err.code === 'INSUFFICIENT_STOCK') {
      const errors = Array.isArray(err.details)
        ? err.details.map((d) => ({
            field: d.productId,
            message: `${d.title}: requested ${d.requested}, available ${d.available}`,
          }))
        : null;
      return error(res, err.message || 'Insufficient stock', 409, errors);
    }
    if (err.code === 'PRODUCT_MISSING') {
      return error(res, err.message || 'Product missing', 400, [
        { field: err.productId || 'productId', message: 'Product no longer exists for this order line' },
      ]);
    }
    next(err);
  }
}

async function getMyOrderHistory(req, res, next) {
  try {
    const userId = req.userId;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const status = req.query.status || null;
    const result = await orderService.getMyOrderHistory(userId, page, limit, status);
    return success(res, result.data, 'Order history fetched successfully', 200, {
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getAdminOrderHistory(req, res, next) {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const status = req.query.status || null;
    const userId = req.query.userId || null;
    const dateFrom = req.query.dateFrom || null;
    const dateTo = req.query.dateTo || null;
    const includeItems = req.query.includeItems === 'true' || req.query.includeItems === '1';

    if (dateFrom && Number.isNaN(Date.parse(dateFrom))) {
      return error(res, 'Invalid dateFrom; use ISO 8601 date or datetime', 400);
    }
    if (dateTo && Number.isNaN(Date.parse(dateTo))) {
      return error(res, 'Invalid dateTo; use ISO 8601 date or datetime', 400);
    }

    const result = await orderService.getAdminOrderHistory(page, limit, {
      status,
      userId,
      dateFrom,
      dateTo,
      includeItems,
    });

    return success(res, result.data, 'Order history fetched successfully', 200, {
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
      includeItems: result.meta.includeItems,
    });
  } catch (err) {
    next(err);
  }
}

async function getOrderStatusOnly(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const canViewAny = req.isAdmin === true || req.canViewAllOrders === true;
    const snapshot = await orderService.getOrderStatusOnly(id, canViewAny ? null : userId);
    if (!snapshot) return error(res, 'Order not found', 404);
    return success(res, snapshot, 'Order status fetched successfully');
  } catch (err) {
    next(err);
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
