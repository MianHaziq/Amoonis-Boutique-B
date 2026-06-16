const { getMessaging } = require('../config/firebase');
const pushDeviceService = require('./pushDevice.service');
const notificationPreferencesService = require('./notificationPreferences.service');

const BRAND = 'Amoon Bloom';

// firebase-admin rejects any sendEachForMulticast call with more than 500 tokens,
// so multicast sends must be chunked.
const FCM_MULTICAST_MAX = 500;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * In-app copy for order lifecycle pushes (FCM notification + data payload for deep links).
 */
const STATUS_COPY = {
  CONFIRMED: { title: 'Order confirmed', body: 'Your Amoon Bloom order is confirmed.' },
  PROCESSING: { title: 'Preparing your order', body: "We're getting your items ready." },
  SHIPPED: { title: 'On the way', body: 'Your order has shipped.' },
  DELIVERED: { title: 'Delivered', body: 'Your order was delivered. Enjoy!' },
  CANCELLED: { title: 'Order cancelled', body: 'Your order has been cancelled.' },
};

async function preferenceAllows(userId, key) {
  const prefs = await notificationPreferencesService.getOrCreate(userId);
  return prefs[key] === true;
}

/**
 * Send FCM to all devices for a user when a preference channel is enabled.
 * @param {'orderStatus'|'promotions'|'announcements'} prefKey
 */
async function sendToUser(userId, prefKey, title, body, data = {}) {
  const messaging = getMessaging();
  if (!messaging) return { sent: 0, skipped: 'firebase_unavailable' };

  const allowed = await preferenceAllows(userId, prefKey);
  if (!allowed) return { sent: 0, skipped: 'preference_off' };

  const tokens = await pushDeviceService.listTokensForUser(userId);
  if (tokens.length === 0) return { sent: 0, skipped: 'no_tokens' };

  const dataStrings = Object.fromEntries(
    Object.entries({ brand: BRAND, ...data }).map(([k, v]) => [k, v == null ? '' : String(v)])
  );

  const messageBase = {
    notification: { title, body },
    data: dataStrings,
    android: { priority: 'high' },
    apns: {
      payload: {
        aps: {
          sound: 'default',
        },
      },
    },
  };

  // FCM multicast is capped at 500 tokens per call. Chunk the tokens and aggregate
  // results so invalid-token cleanup runs across every batch. A batch that throws
  // must not abort the others or skip cleanup for the batches that succeeded.
  const batches = chunk(tokens, FCM_MULTICAST_MAX);
  let successCount = 0;
  let failureCount = 0;
  const invalid = [];

  for (const batchTokens of batches) {
    try {
      const res = await messaging.sendEachForMulticast({
        tokens: batchTokens,
        ...messageBase,
      });
      successCount += res.successCount;
      failureCount += res.failureCount;
      res.responses.forEach((r, i) => {
        if (!r.success && r.error) {
          const c = r.error.code;
          if (
            c === 'messaging/invalid-registration-token' ||
            c === 'messaging/registration-token-not-registered'
          ) {
            invalid.push(batchTokens[i]);
          }
        }
      });
    } catch (err) {
      // One bad batch shouldn't sink the rest. Count it as failed and keep going so
      // remaining batches still send and their invalid tokens still get pruned.
      failureCount += batchTokens.length;
      console.error('[push] multicast batch failed:', err.message);
    }
  }

  await Promise.all(invalid.map((t) => pushDeviceService.deleteInvalidToken(t)));

  return { sent: successCount, failed: failureCount };
}

/** After checkout — respects orderStatus preference. */
function notifyOrderPlaced(userId, orderId) {
  return sendToUser(
    userId,
    'orderStatus',
    'Order placed',
    'Thank you! Your Amoon Bloom order was received.',
    { type: 'ORDER_PLACED', orderId, status: 'PENDING' }
  );
}

/**
 * Admin/manager status updates. PENDING skipped (already covered by checkout push).
 */
function notifyOrderStatusChange(userId, orderId, status) {
  if (status === 'PENDING') {
    return Promise.resolve({ sent: 0, skipped: 'use_order_placed' });
  }
  const copy = STATUS_COPY[status] || {
    title: 'Order update',
    body: `Your order status is now ${status}.`,
  };
  return sendToUser(userId, 'orderStatus', copy.title, copy.body, {
    type: 'ORDER_STATUS',
    orderId,
    status,
  });
}

/** Future: sales, new arrivals, campaigns — call from admin jobs or routes. */
function notifyPromotion(userId, title, body, extraData = {}) {
  return sendToUser(userId, 'promotions', title, body, { type: 'PROMOTION', ...extraData });
}

/** Future: maintenance, policy, app news. */
function notifyAnnouncement(userId, title, body, extraData = {}) {
  return sendToUser(userId, 'announcements', title, body, { type: 'ANNOUNCEMENT', ...extraData });
}

module.exports = {
  notifyOrderPlaced,
  notifyOrderStatusChange,
  notifyPromotion,
  notifyAnnouncement,
  sendToUser,
};
