/**
 * push.send — resolve localized copy, persist to the in-app inbox, send FCM.
 *
 * Data shape (built by src/notifications/notify.js):
 *   {
 *     userId, prefKey,                 // prefKey: orderStatus|promotions|announcements
 *     type,                            // stored on the inbox row + data.type
 *     copyKey?,                        // key into the i18n copy table
 *     status?,                         // for ORDER_STATUS → localized per-status copy
 *     title?, body?,                   // explicit override (promotions/announcements)
 *     data?,                           // FCM data payload (deep-link info)
 *   }
 *
 * Inbox vs device push are deliberately decoupled: we ALWAYS persist the notification
 * (so the in-app history/badge is complete), but only deliver an FCM push if the user's
 * preference for that channel is on (sendToUser enforces this). Throwing triggers a
 * pg-boss retry, e.g. when FCM is briefly unreachable.
 */

const prisma = require('../../config/db');
const pushService = require('../../services/pushNotification.service');
const notificationService = require('../../services/notification.service');
const prefsService = require('../../services/notificationPreferences.service');
const copy = require('../../notifications/copy');
const { QUEUES } = require('../queues');

async function resolveCopy({ title, body, status, copyKey, userId }) {
  if (title && body) return { title, body };

  // Localize to the user's preferred language.
  let lang = 'en';
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferredLanguage: true },
    });
    lang = user?.preferredLanguage || 'en';
  } catch (_) {
    /* fall back to English */
  }

  if (status) return copy.resolveOrderStatus(status, lang);
  if (copyKey) return copy.resolve(copyKey, lang);
  return { title: copy.BRAND, body: `${copy.BRAND} update.` };
}

async function handle(data) {
  const { userId, prefKey = 'orderStatus', type = 'GENERAL', data: payload = {} } = data;
  if (!userId) {
    console.warn('[jobs] push.send skipped — no userId');
    return;
  }

  // `prefKey: null` marks an OPERATIONAL notification (e.g. a staff "new order" alert)
  // that bypasses the per-user customer channel preferences entirely — it must always
  // be delivered. Otherwise check the channel preference once. Order-status
  // notifications are transactional, so we always write them to the inbox even if
  // device push is off; promotional and announcement channels are skipped entirely when
  // the user opted out (no inbox spam, no wasted token lookups under a big broadcast).
  const operational = prefKey == null;
  const allowed = operational
    ? true
    : await prefsService.getOrCreate(userId).then((p) => p[prefKey] === true).catch(() => true);
  if (!allowed && prefKey !== 'orderStatus') return;

  const { title, body } = await resolveCopy(data);

  // Persist to the inbox (best-effort — must not block the push).
  try {
    await notificationService.create({ userId, type, title, body, data: payload });
  } catch (err) {
    console.error('[jobs] push.send inbox persist failed:', err.message);
  }

  // Deliver to devices only if the channel is enabled (sendToUser also re-checks).
  if (allowed) {
    await pushService.sendToUser(userId, prefKey, title, body, payload);
  }
}

module.exports = {
  queue: QUEUES.PUSH_SEND,
  handler: handle,
  // Pushes are time-sensitive; retry a few times quickly then give up (inbox copy persists).
  options: { retryLimit: 3, retryDelay: 15, retryBackoff: true },
};
