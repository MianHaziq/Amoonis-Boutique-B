/**
 * Landing page banner images. Admin adds/reorders/deletes/edits; storefront gets the
 * ordered list filtered to its region and to PUBLISHED banners only.
 * Images stored by URL in DB (Bunny CDN URLs can be used later).
 */
const prisma = require('../config/db');
const regionService = require('./region.service');
const { buildVisibilityWhere } = require('../utils/regionVisibility');

const REGION_INCLUDE = {
  regions: { include: { region: { select: { id: true, code: true, name: true, name_ar: true } } } },
};

function normalizeStatus(value, fallback = 'DRAFT') {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toUpperCase();
  return v === 'PUBLISHED' ? 'PUBLISHED' : v === 'DRAFT' ? 'DRAFT' : fallback;
}

// MOBILE is the safe default: any banner without an explicit platform stays on the
// mobile app (matching pre-platform behavior); WEB is opt-in for the website.
function normalizePlatform(value, fallback = 'MOBILE') {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toUpperCase();
  return v === 'WEB' ? 'WEB' : v === 'MOBILE' ? 'MOBILE' : fallback;
}

async function resolveWriteRegionIds(regionIds) {
  if (Array.isArray(regionIds) && regionIds.length > 0) {
    return regionService.assertValidRegionIds(regionIds);
  }
  const def = await regionService.getDefaultRegion();
  return def ? [def.id] : [];
}

function mapBanner(banner) {
  if (!banner) return null;
  const { regions, ...rest } = banner;
  if (!Array.isArray(regions)) return { ...rest };
  const regionList = regions.map((r) => r.region).filter(Boolean);
  return { ...rest, regions: regionList, regionIds: regionList.map((r) => r.id) };
}

async function getBanners(visibility = {}) {
  const banners = await prisma.bannerImage.findMany({
    where: buildVisibilityWhere(visibility),
    orderBy: { sortOrder: 'asc' },
    include: visibility.isStaff ? REGION_INCLUDE : undefined,
  });
  return banners.map(mapBanner);
}

/**
 * Add one or more banner images. New items get sortOrder at the end. All added
 * banners share the given status (default DRAFT) and region set (default region).
 * @param {string | string[]} urlOrUrls
 * @param {{ status?: string, regionIds?: string[] }} opts
 */
async function addBanners(urlOrUrls, opts = {}) {
  const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
  if (urls.length === 0) return { count: 0, items: [] };

  const status = normalizeStatus(opts.status);
  const platform = normalizePlatform(opts.platform);
  const regionIds = await resolveWriteRegionIds(opts.regionIds);

  const maxOrder = await prisma.bannerImage
    .aggregate({ _max: { sortOrder: true } })
    .then((r) => (r._max.sortOrder ?? -1) + 1);

  const created = await prisma.$transaction(async (tx) => {
    const rows = [];
    for (let i = 0; i < urls.length; i++) {
      const banner = await tx.bannerImage.create({
        data: {
          url: String(urls[i]).trim(),
          sortOrder: maxOrder + i,
          status,
          platform,
          ...(regionIds.length > 0
            ? { regions: { create: regionIds.map((regionId) => ({ regionId })) } }
            : {}),
        },
        include: REGION_INCLUDE,
      });
      rows.push(banner);
    }
    return rows;
  });

  return { count: created.length, items: created.map(mapBanner) };
}

/**
 * Update a single banner's url / status / region set (admin edit).
 */
async function updateBanner(id, data) {
  const existing = await prisma.bannerImage.findUnique({ where: { id } });
  if (!existing) return null;

  const newRegionIds = data.regionIds !== undefined
    ? await regionService.assertValidRegionIds(Array.isArray(data.regionIds) ? data.regionIds : [])
    : null;

  await prisma.$transaction(async (tx) => {
    const payload = {};
    if (data.url !== undefined) payload.url = String(data.url).trim();
    if (data.status !== undefined) payload.status = normalizeStatus(data.status, existing.status);
    if (data.platform !== undefined) payload.platform = normalizePlatform(data.platform, existing.platform);
    if (Object.keys(payload).length > 0) {
      await tx.bannerImage.update({ where: { id }, data: payload });
    }
    if (newRegionIds !== null) {
      await tx.bannerRegion.deleteMany({ where: { bannerId: id } });
      if (newRegionIds.length > 0) {
        await tx.bannerRegion.createMany({
          data: newRegionIds.map((regionId) => ({ bannerId: id, regionId })),
          skipDuplicates: true,
        });
      }
    }
  });

  const banner = await prisma.bannerImage.findUnique({ where: { id }, include: REGION_INCLUDE });
  return mapBanner(banner);
}

async function updateOrder(orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return getBanners({ isStaff: true });
  }

  const updates = orderedIds.map((id, index) =>
    prisma.bannerImage.update({
      where: { id },
      data: { sortOrder: index },
    })
  );

  await prisma.$transaction(updates);
  return getBanners({ isStaff: true });
}

async function deleteBanner(id) {
  await prisma.bannerImage.delete({ where: { id } });
  return getBanners({ isStaff: true });
}

module.exports = {
  getBanners,
  addBanners,
  updateBanner,
  updateOrder,
  deleteBanner,
};
