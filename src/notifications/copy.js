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
    ORDER_CONFIRMED: { title: 'Order confirmed', body: 'Your Amoon Bloom order is confirmed.' },
    ORDER_PROCESSING: { title: 'Preparing your order', body: "We're getting your items ready." },
    ORDER_SHIPPED: { title: 'On the way', body: 'Your order has shipped.' },
    ORDER_DELIVERED: { title: 'Delivered', body: 'Your order was delivered. Enjoy!' },
    ORDER_CANCELLED: { title: 'Order cancelled', body: 'Your order has been cancelled.' },
  },
  ar: {
    ORDER_PLACED: { title: 'تم استلام الطلب', body: 'شكراً لك! تم استلام طلبك من أمون بلوم.' },
    ORDER_CONFIRMED: { title: 'تم تأكيد الطلب', body: 'تم تأكيد طلبك من أمون بلوم.' },
    ORDER_PROCESSING: { title: 'جارٍ تجهيز طلبك', body: 'نقوم بتجهيز منتجاتك الآن.' },
    ORDER_SHIPPED: { title: 'في الطريق إليك', body: 'تم شحن طلبك.' },
    ORDER_DELIVERED: { title: 'تم التوصيل', body: 'تم توصيل طلبك. نتمنى لك تجربة سعيدة!' },
    ORDER_CANCELLED: { title: 'تم إلغاء الطلب', body: 'تم إلغاء طلبك.' },
  },
};

// Map an order lifecycle status to its copy key.
const STATUS_KEY = {
  CONFIRMED: 'ORDER_CONFIRMED',
  PROCESSING: 'ORDER_PROCESSING',
  SHIPPED: 'ORDER_SHIPPED',
  DELIVERED: 'ORDER_DELIVERED',
  CANCELLED: 'ORDER_CANCELLED',
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
