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
    const isAdmin = req.isAdmin === true;
    const order = await orderService.getOrderById(id, isAdmin ? null : userId);
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
    next(err);
  }
}

module.exports = {
  createOrder,
  getOrderById,
  getAllOrdersAdmin,
  updateOrderStatus,
};
