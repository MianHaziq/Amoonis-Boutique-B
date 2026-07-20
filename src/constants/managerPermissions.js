/**
 * Granular areas managers may access. Admins have full access to all of these.
 */
const MANAGER_PERMISSION_VALUES = Object.freeze([
  'PRODUCTS',
  'ORDERS',
  'CATEGORIES',
  'SECTIONS',
  'BANNERS',
  'CONTACT',
  'SETTINGS',
  'PROMO_CODES',
  'ANALYTICS',
  'REGIONS',
  'REVIEWS',
  'DELIVERY_ZONES',
  'VAT',
  'NOTIFICATIONS',
  'USERS',
  'MANAGERS',
]);

const MANAGER_PERMISSION_CATALOG = Object.freeze([
  { key: 'PRODUCTS', label: 'Products', description: 'Create, update, and delete products' },
  { key: 'ORDERS', label: 'Orders', description: 'List all orders, view any order, update order status' },
  { key: 'CATEGORIES', label: 'Categories', description: 'Create, update, and delete categories' },
  { key: 'SECTIONS', label: 'Sections', description: 'Manage panel sections and linked products or categories' },
  { key: 'BANNERS', label: 'Banners', description: 'Add, reorder, and delete landing banners' },
  { key: 'CONTACT', label: 'Contact', description: 'View and manage contact messages' },
  { key: 'SETTINGS', label: 'Settings', description: 'View and update site settings' },
  { key: 'PROMO_CODES', label: 'Promo codes', description: 'Create, update, and delete promotional / discount codes' },
  { key: 'ANALYTICS', label: 'Analytics', description: 'View region-wise sales, revenue, and KPI dashboards' },
  { key: 'REGIONS', label: 'Regions', description: 'Create, update, and delete delivery regions' },
  { key: 'REVIEWS', label: 'Reviews', description: 'View and delete customer product reviews' },
  { key: 'DELIVERY_ZONES', label: 'Delivery zones', description: 'Create, update, and delete delivery zones (e.g. emirates) within a region' },
  { key: 'VAT', label: 'Tax (VAT)', description: 'View and update per-region VAT / tax configuration' },
  { key: 'NOTIFICATIONS', label: 'Notifications', description: 'Broadcast promotional / announcement push notifications to customers' },
  { key: 'USERS', label: 'Users', description: 'View, create, edit, activate/deactivate, and delete customer accounts. Never grants access to admin accounts.' },
  { key: 'MANAGERS', label: 'Managers', description: 'View, create, edit, activate/deactivate, and delete manager accounts, including assigning their permissions. Never grants access to admin accounts.' },
]);

/** Permissions that imply a need to upload images (logos, product images, etc.) */
const UPLOAD_RELATED_PERMISSIONS = Object.freeze([
  'PRODUCTS',
  'CATEGORIES',
  'BANNERS',
  'SECTIONS',
  'SETTINGS',
]);

function isValidPermission(p) {
  return MANAGER_PERMISSION_VALUES.includes(p);
}

/**
 * @param {unknown} input
 * @returns {{ ok: true, value: string[] } | { ok: false, message: string, value: [] }}
 */
function normalizeManagerPermissions(input) {
  if (!Array.isArray(input)) {
    return { ok: false, message: 'managerPermissions must be a non-empty array of permission keys', value: [] };
  }
  const upper = [...new Set(input.map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
  const invalid = upper.filter((p) => !isValidPermission(p));
  if (invalid.length) {
    return {
      ok: false,
      message: `Invalid permission(s): ${invalid.join(', ')}. Valid keys: ${MANAGER_PERMISSION_VALUES.join(', ')}`,
      value: [],
    };
  }
  if (upper.length === 0) {
    return { ok: false, message: 'At least one permission is required for a manager', value: [] };
  }
  return { ok: true, value: upper };
}

module.exports = {
  MANAGER_PERMISSION_VALUES,
  MANAGER_PERMISSION_CATALOG,
  UPLOAD_RELATED_PERMISSIONS,
  isValidPermission,
  normalizeManagerPermissions,
};
