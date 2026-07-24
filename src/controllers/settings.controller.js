const prisma = require('../config/db');
const { success, error } = require('../utils/response');
const {
  parseDeliveryLeadDays,
  invalidateDefaultDeliveryLeadDaysCache,
} = require('../utils/deliveryLeadDays');

// ============================================
// GET /api/settings
// Get current settings (admin)
// ============================================
const getSettings = async (req, res, next) => {
  try {
    let settings = await prisma.settings.findUnique({
      where: { id: 'default' },
    });

    if (!settings) {
      settings = await prisma.settings.create({
        data: { id: 'default' },
      });
    }

    return success(res, settings, 'Settings fetched successfully');
  } catch (err) {
    next(err);
  }
};

// ============================================
// GET /api/settings/public
// Get only public settings (hidden pages for navbar)
// ============================================
const getPublicSettings = async (req, res, next) => {
  try {
    // NOTE: Settings.defaultDeliveryLeadDays is deliberately NOT exposed here. Every
    // public product payload (product.service.js's mapProduct/attachResolvedDeliveryLeadDays)
    // already carries a per-product `resolvedDeliveryLeadDays` — the raw override already
    // folded through product -> category -> this global default. The storefront never needs
    // the bare global number itself, only the already-resolved per-product value, so we
    // don't widen the public surface with it. Revisit only if the frontend ever needs to
    // show the global fallback on its own (e.g. a generic "usually ships within X days"
    // banner unrelated to any specific product).
    let settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { hiddenPages: true, maintenanceMode: true, allowGuestReviews: true },
    });

    if (!settings) {
      settings = { hiddenPages: [], maintenanceMode: false, allowGuestReviews: true };
    }

    return success(res, settings, 'Public settings fetched successfully');
  } catch (err) {
    next(err);
  }
};

// ============================================
// PUT /api/settings
// Update settings (admin only)
// ============================================
const updateSettings = async (req, res, next) => {
  try {
    const {
      siteName,
      contactEmail,
      supportEmail,
      currency,
      maintenanceMode,
      hiddenPages,
      allowGuestReviews,
      defaultDeliveryLeadDays,
    } = req.body;

    const data = {};
    if (siteName !== undefined) data.siteName = siteName;
    if (contactEmail !== undefined) data.contactEmail = contactEmail;
    if (supportEmail !== undefined) data.supportEmail = supportEmail;
    if (currency !== undefined) data.currency = currency;
    if (maintenanceMode !== undefined) data.maintenanceMode = maintenanceMode;
    if (hiddenPages !== undefined) data.hiddenPages = hiddenPages;
    if (allowGuestReviews !== undefined) data.allowGuestReviews = Boolean(allowGuestReviews);
    // Global fallback prep/booking lead time (whole days). Unlike Category/Product's
    // override (nullable — null means "no override"), this is the end of the resolution
    // chain and must always resolve to a real number, so a null/empty input here is
    // rejected rather than silently accepted as "clear it" (there's nothing to fall back
    // to below it). parseDeliveryLeadDays still returns null for null/undefined/'' input;
    // we explicitly guard against writing that null onto this particular column.
    if (defaultDeliveryLeadDays !== undefined) {
      const parsed = parseDeliveryLeadDays(defaultDeliveryLeadDays);
      if (parsed === null) {
        return error(res, 'defaultDeliveryLeadDays must be a whole number between 0 and 30', 400);
      }
      data.defaultDeliveryLeadDays = parsed;
    }

    const settings = await prisma.settings.upsert({
      where: { id: 'default' },
      update: data,
      create: { id: 'default', ...data },
    });

    // Bust the in-process cache immediately so the very next product/order read in this
    // process resolves against the new default instead of a stale cached value.
    if (defaultDeliveryLeadDays !== undefined) invalidateDefaultDeliveryLeadDaysCache();

    return success(res, settings, 'Settings updated successfully');
  } catch (err) {
    if (err.code === 'VALIDATION') return error(res, err.message, 400);
    next(err);
  }
};

module.exports = {
  getSettings,
  getPublicSettings,
  updateSettings,
};
