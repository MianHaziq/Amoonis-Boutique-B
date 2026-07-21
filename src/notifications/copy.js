/**
 * Localized notification copy (push + persisted inbox).
 *
 * The app stores each user's `preferredLanguage`; notifications resolve their text
 * from here so an Arabic-region customer reads Arabic and everyone else reads English.
 * Add a language by adding a top-level key; missing keys fall back to English so a
 * partial translation never produces a blank notification.
 */

const BRAND = 'Amoon Bloom';

const COPY = {
  en: {
    ORDER_PLACED: { title: 'Order placed', body: 'Thank you! Your Amoon Bloom order was received.' },
    ORDER_PROCESSING: { title: 'Processing your order', body: "We're getting your items ready." },
    ORDER_ON_HOLD: { title: 'Order on hold', body: 'Your order is on hold while we review it.' },
    ORDER_COMPLETED: { title: 'Order complete', body: 'Your order is complete. Enjoy!' },
    ORDER_CANCELLED: { title: 'Order cancelled', body: 'Your order has been cancelled.' },
    ORDER_REFUNDED: { title: 'Order refunded', body: 'Your order has been refunded.' },
    ORDER_FAILED: { title: 'Order issue', body: 'There was an issue with your order. We’ll be in touch.' },
  },
  ar: {
    ORDER_PLACED: { title: 'تم استلام الطلب', body: 'شكراً لك! تم استلام طلبك من أمون بلوم.' },
    ORDER_PROCESSING: { title: 'طلبك قيد المعالجة', body: 'نقوم بتجهيز منتجاتك الآن.' },
    ORDER_ON_HOLD: { title: 'الطلب معلّق', body: 'طلبك معلّق مؤقتاً ريثما تتم مراجعته.' },
    ORDER_COMPLETED: { title: 'اكتمل الطلب', body: 'تم إتمام طلبك. نتمنى لك تجربة سعيدة!' },
    ORDER_CANCELLED: { title: 'تم إلغاء الطلب', body: 'تم إلغاء طلبك.' },
    ORDER_REFUNDED: { title: 'تم استرداد الطلب', body: 'تم استرداد قيمة طلبك.' },
    ORDER_FAILED: { title: 'مشكلة في الطلب', body: 'حدثت مشكلة في طلبك، سنتواصل معك قريباً.' },
  },
};

// Map an order lifecycle status to its copy key. PENDING_PAYMENT/DRAFT are intentionally
// absent — PENDING_PAYMENT is already covered by the "order placed" push (see
// notify.orderStatusChange), and DRAFT is a pre-order state that never notifies a customer.
const STATUS_KEY = {
  PROCESSING: 'ORDER_PROCESSING',
  ON_HOLD: 'ORDER_ON_HOLD',
  COMPLETED: 'ORDER_COMPLETED',
  CANCELLED: 'ORDER_CANCELLED',
  REFUNDED: 'ORDER_REFUNDED',
  FAILED: 'ORDER_FAILED',
};

function normalizeLang(lang) {
  if (!lang) return 'en';
  const base = String(lang).toLowerCase().split(/[-_]/)[0];
  return COPY[base] ? base : 'en';
}

/**
 * Resolve { title, body } for a copy key in the given language, falling back to
 * English and finally to a generic line so we never send an empty notification.
 */
function resolve(key, lang) {
  const l = normalizeLang(lang);
  const entry = (COPY[l] && COPY[l][key]) || COPY.en[key];
  if (entry) return { ...entry };
  return { title: BRAND, body: `${BRAND} update.` };
}

function resolveOrderStatus(status, lang) {
  const key = STATUS_KEY[status];
  if (!key) return { title: 'Order update', body: `Your order status is now ${status}.` };
  return resolve(key, lang);
}

module.exports = { BRAND, COPY, STATUS_KEY, normalizeLang, resolve, resolveOrderStatus };
