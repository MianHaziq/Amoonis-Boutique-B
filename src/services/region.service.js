/**
 * Regions are the backbone of multi-region support. They are stored as DATA (not an
 * enum) so the admin can add a new region at runtime with zero schema changes.
 *
 * Reads are served from a short-lived in-memory cache because regions change very
 * rarely but are consulted on (almost) every storefront request. Any write
 * invalidates the cache so a new/edited/removed region propagates within the request.
 */
const prisma = require('../config/db');

const CACHE_TTL_MS = 60 * 1000;
let cache = { fetchedAt: 0, all: [], byCode: new Map(), byId: new Map(), defaultRegion: null };
// Shared promise so a burst of requests hitting an expired cache triggers ONE DB read,
// not one per request (avoids a thundering-herd query stampede on cache expiry).
let inflight = null;

const REGION_SELECT = {
  id: true,
  code: true,
  name: true,
  name_ar: true,
  currency: true,
  legalEntity: true,
  shippingFlatRate: true,
  isDefault: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
};

function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase();
}

/** Blank/null/undefined -> null (no fee configured); otherwise a non-negative number. */
function parseShippingFlatRate(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw Object.assign(new Error('shippingFlatRate must be a non-negative number'), { code: 'VALIDATION' });
  }
  return n;
}

async function loadCache(force = false) {
  if (!force && cache.fetchedAt && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache;
  }
  if (!force && inflight) return inflight;

  inflight = (async () => {
    try {
      const all = await prisma.region.findMany({
        orderBy: { sortOrder: 'asc' },
        select: REGION_SELECT,
      });
      const byCode = new Map();
      const byId = new Map();
      let defaultRegion = null;
      for (const r of all) {
        byCode.set(r.code.toUpperCase(), r);
        byId.set(r.id, r);
        if (r.isDefault && r.isActive) defaultRegion = r;
      }
      // Fall back to the first active region if no explicit default is flagged.
      if (!defaultRegion) defaultRegion = all.find((r) => r.isActive) || null;
      cache = { fetchedAt: Date.now(), all, byCode, byId, defaultRegion };
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function invalidateCache() {
  cache = { fetchedAt: 0, all: [], byCode: new Map(), byId: new Map(), defaultRegion: null };
  inflight = null;
}

/**
 * Resolve a region from a code sent by the client (X-Region header / ?region=).
 * Only ACTIVE regions are honored. Returns the default region when the code is
 * missing, unknown, or inactive — so the storefront always has a region.
 */
async function resolveRegion(code) {
  const { byCode, defaultRegion } = await loadCache();
  const normalized = normalizeCode(code);
  if (normalized) {
    const match = byCode.get(normalized);
    if (match && match.isActive) return match;
  }
  return defaultRegion;
}

async function getRegionById(id) {
  if (!id) return null;
  const { byId } = await loadCache();
  return byId.get(id) || null;
}

/**
 * Exact lookup by code with NO default fallback. Used for admin filtering where an
 * unknown code should mean "no match" rather than silently falling back to default.
 */
async function getRegionByCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const { byCode } = await loadCache();
  return byCode.get(normalized) || null;
}

async function getDefaultRegion() {
  const { defaultRegion } = await loadCache();
  return defaultRegion;
}

/**
 * Validate that every id in the list is a real region. Returns the de-duplicated
 * list of valid ids, or throws REGION_NOT_FOUND with the offending ids.
 */
async function assertValidRegionIds(regionIds) {
  const ids = [...new Set((regionIds || []).map((x) => String(x).trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const { byId } = await loadCache();
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    const err = new Error(`Unknown region id(s): ${missing.join(', ')}`);
    err.code = 'REGION_NOT_FOUND';
    err.missing = missing;
    throw err;
  }
  return ids;
}

// ---- Admin CRUD ----

async function listRegions({ includeInactive = true } = {}) {
  return prisma.region.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: REGION_SELECT,
  });
}

async function createRegion(data) {
  const code = normalizeCode(data.code);
  if (!code) throw Object.assign(new Error('Region code is required'), { code: 'VALIDATION' });
  const name = String(data.name ?? '').trim();
  if (!name) throw Object.assign(new Error('Region name is required'), { code: 'VALIDATION' });

  const region = await prisma.$transaction(async (tx) => {
    const makeDefault = data.isDefault === true;
    if (makeDefault) {
      await tx.region.updateMany({ data: { isDefault: false }, where: { isDefault: true } });
    }
    return tx.region.create({
      data: {
        code,
        name,
        name_ar: data.name_ar != null ? String(data.name_ar).trim() || null : null,
        currency: data.currency ? String(data.currency).trim().toUpperCase() : 'AED',
        legalEntity: data.legalEntity != null ? String(data.legalEntity).trim() || null : null,
        shippingFlatRate: parseShippingFlatRate(data.shippingFlatRate),
        isDefault: makeDefault,
        isActive: data.isActive === undefined ? true : !!data.isActive,
        sortOrder: data.sortOrder != null ? Number(data.sortOrder) : 0,
      },
      select: REGION_SELECT,
    });
  });
  invalidateCache();
  return region;
}

async function updateRegion(id, data) {
  const existing = await prisma.region.findUnique({ where: { id } });
  if (!existing) return null;

  const payload = {};
  if (data.code !== undefined) {
    const code = normalizeCode(data.code);
    if (!code) throw Object.assign(new Error('Region code cannot be empty'), { code: 'VALIDATION' });
    payload.code = code;
  }
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw Object.assign(new Error('Region name cannot be empty'), { code: 'VALIDATION' });
    payload.name = name;
  }
  if (data.name_ar !== undefined) payload.name_ar = data.name_ar ? String(data.name_ar).trim() || null : null;
  if (data.currency !== undefined) {
    const currency = String(data.currency).trim().toUpperCase();
    if (!currency) throw Object.assign(new Error('Region currency cannot be empty'), { code: 'VALIDATION' });
    payload.currency = currency;
  }
  if (data.legalEntity !== undefined) {
    payload.legalEntity = data.legalEntity != null ? String(data.legalEntity).trim() || null : null;
  }
  if (data.shippingFlatRate !== undefined) {
    payload.shippingFlatRate = parseShippingFlatRate(data.shippingFlatRate);
  }
  if (data.isActive !== undefined) payload.isActive = !!data.isActive;
  if (data.sortOrder !== undefined) payload.sortOrder = Number(data.sortOrder);

  const nextActive = data.isActive !== undefined ? !!data.isActive : existing.isActive;
  const isDeactivating = existing.isActive && !nextActive;

  // Reject only a genuine contradiction: explicitly promoting a region that ISN'T
  // already default to default while it is (or is becoming) inactive. Re-submitting
  // the existing default flag unchanged while deactivating a region that was already
  // default is NOT a contradiction — the admin form always echoes both checkboxes on
  // every save, so that combination just means "hide it", and is auto-resolved below
  // by promoting a replacement default rather than rejected.
  if (data.isDefault === true && !existing.isDefault && !nextActive) {
    throw Object.assign(
      new Error('An inactive region cannot be set as the default region.'),
      { code: 'VALIDATION' }
    );
  }

  // A region can only be hidden while at least one other region stays visible —
  // otherwise the storefront would have nowhere to fall back to.
  if (isDeactivating) {
    const otherActiveCount = await prisma.region.count({ where: { isActive: true, id: { not: id } } });
    if (otherActiveCount === 0) {
      throw Object.assign(
        new Error('Cannot hide the only active region. Activate another region first.'),
        { code: 'LAST_ACTIVE_REGION' }
      );
    }
  }

  const region = await prisma.$transaction(async (tx) => {
    if (data.isDefault === true) {
      await tx.region.updateMany({ data: { isDefault: false }, where: { isDefault: true, id: { not: id } } });
      payload.isDefault = true;
    } else if (data.isDefault === false) {
      payload.isDefault = false;
    }

    if (isDeactivating) {
      // A default region can never sit inactive — if this one was default, promote a
      // replacement (lowest sortOrder among the remaining active regions) before it
      // loses isActive. Overrides whatever the Case A/B logic above set.
      if (existing.isDefault) {
        payload.isDefault = false;
        const replacement = await tx.region.findFirst({
          where: { isActive: true, id: { not: id } },
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        });
        if (!replacement) {
          // Race: another request deactivated the last other region between our
          // pre-check above and here — abort, the transaction rolls back atomically.
          throw Object.assign(
            new Error('Cannot hide the only active region. Activate another region first.'),
            { code: 'LAST_ACTIVE_REGION' }
          );
        }
        await tx.region.update({ where: { id: replacement.id }, data: { isDefault: true } });
      }

      // Anyone whose home region is the one being hidden moves to wherever the
      // default now lands — never leave a user pointed at an invisible region.
      const currentDefault =
        (await tx.region.findFirst({ where: { isDefault: true, isActive: true, id: { not: id } } })) ??
        (await tx.region.findFirst({
          where: { isActive: true, id: { not: id } },
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        }));
      if (currentDefault) {
        await tx.user.updateMany({ where: { regionId: id }, data: { regionId: currentDefault.id } });
      }
    }

    return tx.region.update({ where: { id }, data: payload, select: REGION_SELECT });
  });
  invalidateCache();
  return region;
}

async function deleteRegion(id) {
  const region = await prisma.region.findUnique({ where: { id } });
  if (!region) return null;
  if (region.isDefault) {
    throw Object.assign(new Error('Cannot delete the default region. Set another region as default first.'), {
      code: 'REGION_IS_DEFAULT',
    });
  }
  // Block deletion while content/users/orders still reference it to avoid silent data loss.
  const [productLinks, userCount, orderCount] = await Promise.all([
    prisma.productRegion.count({ where: { regionId: id } }),
    prisma.user.count({ where: { regionId: id } }),
    prisma.order.count({ where: { regionId: id } }),
  ]);
  if (productLinks > 0 || userCount > 0 || orderCount > 0) {
    throw Object.assign(new Error('Region is still in use by products, users, or orders. Reassign them first.'), {
      code: 'REGION_IN_USE',
      counts: { productLinks, userCount, orderCount },
    });
  }
  await prisma.region.delete({ where: { id } });
  invalidateCache();
  return region;
}

module.exports = {
  resolveRegion,
  getRegionById,
  getRegionByCode,
  getDefaultRegion,
  assertValidRegionIds,
  listRegions,
  createRegion,
  updateRegion,
  deleteRegion,
  invalidateCache,
};
