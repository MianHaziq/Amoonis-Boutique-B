const notificationService = require('../services/notification.service');
const { success, error } = require('../utils/response');

// GET /notifications — the authenticated user's inbox (newest first).
async function list(req, res, next) {
  try {
    const unreadOnly = req.query.unreadOnly === 'true' || req.query.unreadOnly === '1';
    const result = await notificationService.list(req.userId, {
      page: req.query.page,
      limit: req.query.limit,
      unreadOnly,
    });
    return success(res, result.data, 'Notifications fetched', 200, {
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
      unreadCount: result.unreadCount,
    });
  } catch (err) {
    next(err);
  }
}

// GET /notifications/unread-count — for the app badge.
async function unreadCount(req, res, next) {
  try {
    const count = await notificationService.unreadCount(req.userId);
    return success(res, { unreadCount: count }, 'Unread count fetched');
  } catch (err) {
    next(err);
  }
}

// PATCH /notifications/:id/read — mark a single notification read.
async function markRead(req, res, next) {
  try {
    const count = await notificationService.markRead(req.userId, req.params.id);
    if (count === 0) return error(res, 'Notification not found or already read', 404);
    return success(res, null, 'Notification marked read');
  } catch (err) {
    next(err);
  }
}

// POST /notifications/read-all — mark every unread notification read.
async function markAllRead(req, res, next) {
  try {
    const count = await notificationService.markAllRead(req.userId);
    return success(res, { updated: count }, 'All notifications marked read');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, unreadCount, markRead, markAllRead };
