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

/**
 * Next sortOrder for a region = one past its current max, so new zones always
 * append to the end of that region's list. Sort is automatic — the admin sets
 * the visible order by drag-and-drop (reorderZones), never by typing a number.
 */
async function nextSortOrder(regionId, client = prisma) {
  const agg = await client.deliveryZone.aggregate({
    where: { regionId },
    _max: { sortOrder: true },
  });
  return (agg._max.sortOrder ?? -1) + 1;
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
      // sortOrder is automatic (append) unless an explicit value is passed.
      sortOrder: data.sortOrder != null ? Number(data.sortOrder) : await nextSortOrder(regionId),
    },
    select: ZONE_SELECT,
  });
}

/**
 * Create several zones for ONE region in a single transaction. Names that
 * already exist in the region (or repeat within the batch) are skipped, not
 * failed, so re-submitting a partially-created list is safe. sortOrder is
 * assigned sequentially from the region's current max, so the new zones append
 * in the order given.
 * @param {string} regionId
 * @param {{ name: string, name_ar?: string|null, isActive?: boolean }[]} zones
 * @returns {Promise<{ created: object[], skipped: string[], count: number }>}
 */
async function createZonesBulk(regionId, zones) {
  regionId = String(regionId ?? '').trim();
  if (!regionId) throw Object.assign(new Error('regionId is required'), { code: 'VALIDATION' });

  const cleaned = (Array.isArray(zones) ? zones : [])
    .map((z) => ({
      name: String(z?.name ?? '').trim(),
      name_ar: z?.name_ar != null ? String(z.name_ar).trim() || null : null,
      isActive: z?.isActive === undefined ? true : !!z.isActive,
    }))
    .filter((z) => z.name);
  if (cleaned.length === 0) {
    throw Object.assign(new Error('At least one zone name is required'), { code: 'VALIDATION' });
  }

  // Skip names already present in the region (exact match — mirrors the
  // @@unique([regionId, name]) constraint) or repeated within this batch.
  const existing = await prisma.deliveryZone.findMany({
    where: { regionId },
    select: { name: true, sortOrder: true },
  });
  const taken = new Set(existing.map((z) => z.name));
  let next = existing.reduce((m, z) => Math.max(m, z.sortOrder), -1) + 1;

  const toCreate = [];
  const skipped = [];
  for (const z of cleaned) {
    if (taken.has(z.name)) {
      skipped.push(z.name);
      continue;
    }
    taken.add(z.name);
    toCreate.push({ ...z, regionId, sortOrder: next++ });
  }

  if (toCreate.length === 0) return { created: [], skipped, count: 0 };

  const created = await prisma.$transaction(
    toCreate.map((d) => prisma.deliveryZone.create({ data: d, select: ZONE_SELECT }))
  );
  return { created, skipped, count: created.length };
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
  createZonesBulk,
  updateZone,
  deleteZone,
  reorderZones,
};
