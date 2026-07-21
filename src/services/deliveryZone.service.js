/**
 * Delivery zones are admin-managed sub-areas within a region (e.g. UAE's emirates:
 * Dubai, Abu Dhabi, Sharjah, ...). Scoped per-region — not a global list — so a
 * different region can get its own list later (e.g. Saudi provinces) with zero
 * schema change. Mirrors region.service.js's shape, minus the default/currency
 * concepts a zone doesn't have.
 */
const prisma = require('../config/db');

const ZONE_SELECT = {
  id: true,
  regionId: true,
  name: true,
  name_ar: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
};

async function getZoneById(id) {
  if (!id) return null;
  return prisma.deliveryZone.findUnique({ where: { id }, select: ZONE_SELECT });
}

/**
 * Validates that a submitted deliveryZoneId is a real, active zone belonging to
 * the order's region — guards against a stale id from a region switch mid-checkout,
 * or a tampered request. Throws ZONE_NOT_FOUND / ZONE_INACTIVE / ZONE_WRONG_REGION.
 */
async function assertValidZone(id, regionId) {
  const zone = await getZoneById(id);
  if (!zone) {
    throw Object.assign(new Error('Selected delivery zone was not found.'), { code: 'ZONE_NOT_FOUND' });
  }
  if (!zone.isActive) {
    throw Object.assign(new Error('Selected delivery zone is no longer available.'), { code: 'ZONE_INACTIVE' });
  }
  if (zone.regionId !== regionId) {
    throw Object.assign(new Error('Selected delivery zone does not belong to your region.'), {
      code: 'ZONE_WRONG_REGION',
    });
  }
  return zone;
}

// ---- Admin CRUD ----

async function listZones({ regionId, includeInactive = true } = {}) {
  return prisma.deliveryZone.findMany({
    where: {
      ...(regionId ? { regionId } : {}),
      ...(includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ regionId: 'asc' }, { sortOrder: 'asc' }],
    select: ZONE_SELECT,
  });
}

async function createZone(data) {
  const regionId = String(data.regionId ?? '').trim();
  if (!regionId) throw Object.assign(new Error('regionId is required'), { code: 'VALIDATION' });
  const name = String(data.name ?? '').trim();
  if (!name) throw Object.assign(new Error('Zone name is required'), { code: 'VALIDATION' });

  return prisma.deliveryZone.create({
    data: {
      regionId,
      name,
      name_ar: data.name_ar != null ? String(data.name_ar).trim() || null : null,
      isActive: data.isActive === undefined ? true : !!data.isActive,
      sortOrder: data.sortOrder != null ? Number(data.sortOrder) : 0,
    },
    select: ZONE_SELECT,
  });
}

async function updateZone(id, data) {
  const existing = await prisma.deliveryZone.findUnique({ where: { id } });
  if (!existing) return null;

  const payload = {};
  if (data.regionId !== undefined) {
    const regionId = String(data.regionId ?? '').trim();
    if (!regionId) throw Object.assign(new Error('regionId cannot be empty'), { code: 'VALIDATION' });
    payload.regionId = regionId;
  }
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw Object.assign(new Error('Zone name cannot be empty'), { code: 'VALIDATION' });
    payload.name = name;
  }
  if (data.name_ar !== undefined) payload.name_ar = data.name_ar ? String(data.name_ar).trim() || null : null;
  if (data.isActive !== undefined) payload.isActive = !!data.isActive;
  if (data.sortOrder !== undefined) payload.sortOrder = Number(data.sortOrder);

  return prisma.deliveryZone.update({ where: { id }, data: payload, select: ZONE_SELECT });
}

/**
 * Deletion is deliberately frictionless — no "in use" guard. A saved Address's
 * deliveryZoneId is onDelete: SetNull (never breaks), and historical Orders keep
 * their zone name as an immutable snapshot (never reference the zone row at all).
 */
async function deleteZone(id) {
  const zone = await prisma.deliveryZone.findUnique({ where: { id } });
  if (!zone) return null;
  await prisma.deliveryZone.delete({ where: { id } });
  return zone;
}

/**
 * Reorder zones by assigning explicit sortOrder values (admin drag-and-drop).
 * Accepts an array of { id, sortOrder }. Runs in a single transaction. Zones are
 * ordered per-region, so callers reorder within one region at a time — this only
 * writes the sortOrder each id was given. Mirrors sectionService.reorderSections.
 * @param {{ id: string, sortOrder: number }[]} items
 */
async function reorderZones(items) {
  const clean = (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it.id === 'string' && Number.isInteger(it.sortOrder))
    .map((it) => ({ id: it.id, sortOrder: it.sortOrder }));
  if (clean.length === 0) return { count: 0 };

  await prisma.$transaction(
    clean.map((it) =>
      prisma.deliveryZone.update({ where: { id: it.id }, data: { sortOrder: it.sortOrder } })
    )
  );
  return { count: clean.length };
}

module.exports = {
  getZoneById,
  assertValidZone,
  listZones,
  createZone,
  updateZone,
  deleteZone,
  reorderZones,
};
