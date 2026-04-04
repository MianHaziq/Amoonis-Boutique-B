const pushDeviceService = require('../services/pushDevice.service');
const notificationPreferencesService = require('../services/notificationPreferences.service');
const { success, error } = require('../utils/response');

async function registerPushToken(req, res, next) {
  try {
    const userId = req.userId;
    const { fcmToken, platform } = req.body;
    const { device, error: errMsg } = await pushDeviceService.registerDevice(userId, fcmToken, platform);
    if (errMsg) return error(res, errMsg, 400);
    return success(
      res,
      {
        id: device.id,
        platform: device.platform,
        updatedAt: device.updatedAt,
      },
      'Device registered for push notifications',
      200
    );
  } catch (e) {
    next(e);
  }
}

async function unregisterPushToken(req, res, next) {
  try {
    const userId = req.userId;
    const { fcmToken } = req.body;
    const { removed, error: removeErr } = await pushDeviceService.removeDeviceByToken(userId, fcmToken);
    if (removeErr) return error(res, removeErr, 400);
    if (!removed) return error(res, 'Token not found for this user', 404);
    return success(res, null, 'Device unregistered');
  } catch (e) {
    next(e);
  }
}

async function getNotificationPreferences(req, res, next) {
  try {
    const data = await notificationPreferencesService.getOrCreate(req.userId);
    return success(res, data, 'Notification preferences');
  } catch (e) {
    next(e);
  }
}

async function patchNotificationPreferences(req, res, next) {
  try {
    const { orderStatus, promotions, announcements } = req.body;
    if (
      typeof orderStatus !== 'boolean' &&
      typeof promotions !== 'boolean' &&
      typeof announcements !== 'boolean'
    ) {
      return error(res, 'Send at least one of: orderStatus, promotions, announcements (booleans)', 400);
    }
    const data = await notificationPreferencesService.update(req.userId, {
      orderStatus,
      promotions,
      announcements,
    });
    return success(res, data, 'Notification preferences updated');
  } catch (e) {
    next(e);
  }
}

module.exports = {
  registerPushToken,
  unregisterPushToken,
  getNotificationPreferences,
  patchNotificationPreferences,
};
