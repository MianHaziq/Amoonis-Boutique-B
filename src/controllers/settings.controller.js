const prisma = require('../config/db');
const { success } = require('../utils/response');

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
    let settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { hiddenPages: true, maintenanceMode: true },
    });

    if (!settings) {
      settings = { hiddenPages: [], maintenanceMode: false };
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
    } = req.body;

    const data = {};
    if (siteName !== undefined) data.siteName = siteName;
    if (contactEmail !== undefined) data.contactEmail = contactEmail;
    if (supportEmail !== undefined) data.supportEmail = supportEmail;
    if (currency !== undefined) data.currency = currency;
    if (maintenanceMode !== undefined) data.maintenanceMode = maintenanceMode;
    if (hiddenPages !== undefined) data.hiddenPages = hiddenPages;

    const settings = await prisma.settings.upsert({
      where: { id: 'default' },
      update: data,
      create: { id: 'default', ...data },
    });

    return success(res, settings, 'Settings updated successfully');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getSettings,
  getPublicSettings,
  updateSettings,
};
