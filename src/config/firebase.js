const admin = require('firebase-admin');

let initAttempted = false;
let available = false;

function parseServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (b64 && b64.trim()) {
    const json = Buffer.from(b64.trim(), 'base64').toString('utf8');
    return JSON.parse(json);
  }
  if (raw && raw.trim()) {
    return JSON.parse(raw);
  }
  return null;
}

/**
 * Lazy-init Firebase Admin for FCM HTTP v1. Safe to call multiple times.
 * @returns {boolean} whether messaging can be used
 */
function initFirebaseAdmin() {
  if (initAttempted) return available;
  initAttempted = true;
  try {
    if (admin.apps.length > 0) {
      available = true;
      return true;
    }
    const sa = parseServiceAccount();
    if (!sa) {
      if (process.env.NODE_ENV === 'production') {
        console.warn('[FCM] Firebase credentials not set; push notifications are disabled.');
      } else {
        console.warn('[FCM] Firebase not configured (FIREBASE_SERVICE_ACCOUNT_JSON or _BASE64). Push disabled in dev.');
      }
      return false;
    }
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    available = true;
    return true;
  } catch (e) {
    console.error('[FCM] Firebase init failed:', e.message);
    return false;
  }
}

function getMessaging() {
  if (!initFirebaseAdmin()) return null;
  return admin.messaging();
}

function isPushAvailable() {
  return initFirebaseAdmin();
}

module.exports = { getMessaging, isPushAvailable, initFirebaseAdmin };
