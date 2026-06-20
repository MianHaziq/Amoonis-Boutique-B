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

/**
 * Resolve the title/body for this notification in the recipient's language.
 *  - title+body present     → fixed, single-language copy (operational/admin alerts)
 *  - localized {en,ar}      → per-user localized copy built by the producer (broadcasts)
 *  - status / copyKey       → looked up in the i18n copy table
 */
function resolveCopy(data, lang) {
  const { title, body, status, copyKey, localized } = data;
  if (title && body) return { title, body };

  if (localized) {
    const l = copy.normalizeLang(lang);
    return localized[l] || localized.en || { title: copy.BRAND, body: `${copy.BRAND} update.` };
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

  // Load the recipient once: this both discards jobs for a user who was deleted between
  // enqueue and processing (no noisy FK errors, no pointless retries) and gives us their
  // language for localized copy. A DB error here is safe to retry — nothing has been
  // written yet — so we let it throw.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferredLanguage: true },
  });
  if (!user) {
    console.log(`[jobs] push.send skipped — user ${userId} no longer exists`);
    return;
  }
  const lang = user.preferredLanguage || 'en';

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

  const { title, body } = resolveCopy(data, lang);

  // Persist to the inbox (best-effort — must not block the push).
  try {
    await notificationService.create({ userId, type, title, body, data: payload });
  } catch (err) {
    console.error('[jobs] push.send inbox persist failed:', err.message);
  }

  // Deliver to devices only if the channel is enabled (sendToUser also re-checks).
  // The inbox row is already persisted above, so a delivery error must NOT bubble up and
  // trigger a pg-boss retry of the whole job — that would write a duplicate inbox row and
  // re-send the push. FCM transport errors are already handled per-batch inside
  // sendToUser; this catch covers transient DB errors in the preference/token lookups.
  if (allowed) {
    try {
      await pushService.sendToUser(userId, prefKey, title, body, payload);
    } catch (err) {
      console.error('[jobs] push.send delivery failed (inbox already saved):', err.message);
    }
  }
}

module.exports = {
  queue: QUEUES.PUSH_SEND,
  handler: handle,
  // Pushes are time-sensitive; retry a few times quickly then give up (inbox copy persists).
  options: { retryLimit: 3, retryDelay: 15, retryBackoff: true },
};
