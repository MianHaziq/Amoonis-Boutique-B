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
  standardDeliveryDays: true,
  iso2: true,
  contactEmail: true,
  contactPhone: true,
  whatsappNumber: true,
  address: true,
  address_ar: true,
  hours: true,
  hours_ar: true,
  registrationCity: true,
  registrationCity_ar: true,
  currencyDisplayName: true,
  currencyDisplayName_ar: true,
  vatLawName: true,
  vatLawName_ar: true,
  dataProtectionLawName: true,
  dataProtectionLawName_ar: true,
  dataProtectionAuthority: true,
  dataProtectionAuthority_ar: true,
  ipLawName: true,
  ipLawName_ar: true,
  consumerProtectionLawName: true,
  consumerProtectionLawName_ar: true,
  consumerProtectionAuthority: true,
  consumerProtectionAuthority_ar: true,
  standardsAuthority: true,
  standardsAuthority_ar: true,
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

/** Blank/null/undefined -> null (not configured, no ETA shown); otherwise a
 *  non-negative whole number of days, capped at 90 to reject garbage input. */
function parseStandardDeliveryDays(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 90) {
    throw Object.assign(new Error('standardDeliveryDays must be a whole number between 0 and 90'), { code: 'VALIDATION' });
  }
  return n;
}

/** Blank/null/undefined -> null; otherwise the trimmed string. Shared by every
 *  plain optional text field (legalEntity, contact info) — same convention. */
function trimOrNull(value) {
  return value != null ? String(value).trim() || null : null;
}

/**
 * Legal citations shown across the 5 storefront legal pages. Unlike the
 * contact-info fields above (which fall back to a UAE-based site default),
 * these are REQUIRED at region creation — a region must never be created
 * with the wrong country's law citations on its legal pages. See the
 * migration doc-comment and Amoon-Bloom-F/src/features/location/regionContact.ts.
 */
const LEGAL_FIELD_BASE_NAMES = [
  'registrationCity',
  'currencyDisplayName',
  'vatLawName',
  'dataProtectionLawName',
  'dataProtectionAuthority',
  'ipLawName',
  'consumerProtectionLawName',
  'consumerProtectionAuthority',
  'standardsAuthority',
];
const LEGAL_FIELDS = LEGAL_FIELD_BASE_NAMES.flatMap((f) => [f, `${f}_ar`]);

/** Throws VALIDATION if any of the 18 legal fields is missing/blank. */
function assertLegalFieldsComplete(data) {
  const missing = LEGAL_FIELDS.filter((f) => !String(data[f] ?? '').trim());
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`All legal citation fields are required to create a region. Missing: ${missing.join(', ')}`),
      { code: 'VALIDATION', missing }
    );
  }
}

/** Builds the { field: trimOrNull(value) } payload for all 18 legal fields
 *  that were actually present in `data` (sparse — matches every other
 *  optional-field update pattern in this file). */
function buildLegalFieldsPayload(data, { onlyDefined = false } = {}) {
  const payload = {};
  for (const f of LEGAL_FIELDS) {
    if (onlyDefined && data[f] === undefined) continue;
    payload[f] = trimOrNull(data[f]);
  }
  return payload;
}

/** Blank/null/undefined -> null (no flag configured yet); otherwise exactly 2 letters. */
function parseIso2(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw Object.assign(new Error('iso2 must be exactly 2 letters (e.g. "AE", "SA")'), { code: 'VALIDATION' });
  }
  return normalized;
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
  assertLegalFieldsComplete(data);

  const region = await prisma.$transaction(async (tx) => {
    const makeDefault = data.isDefault === true;
    if (makeDefault) {
      await tx.region.updateMany({ data: { isDefault: false }, where: { isDefault: true } });
    }
    const created = await tx.region.create({
      data: {
        code,
        name,
        name_ar: data.name_ar != null ? String(data.name_ar).trim() || null : null,
        currency: data.currency ? String(data.currency).trim().toUpperCase() : 'AED',
        legalEntity: trimOrNull(data.legalEntity),
        shippingFlatRate: parseShippingFlatRate(data.shippingFlatRate),
        standardDeliveryDays: parseStandardDeliveryDays(data.standardDeliveryDays),
        iso2: parseIso2(data.iso2),
        contactEmail: trimOrNull(data.contactEmail),
        contactPhone: trimOrNull(data.contactPhone),
        whatsappNumber: trimOrNull(data.whatsappNumber),
        address: trimOrNull(data.address),
        address_ar: trimOrNull(data.address_ar),
        hours: trimOrNull(data.hours),
        hours_ar: trimOrNull(data.hours_ar),
        ...buildLegalFieldsPayload(data),
        isDefault: makeDefault,
        isActive: data.isActive === undefined ? true : !!data.isActive,
        sortOrder: data.sortOrder != null ? Number(data.sortOrder) : 0,
      },
      select: REGION_SELECT,
    });

    // Populate the new region with the whole existing catalog so its storefront
    // isn't blank the moment it's created. Without this, ProductRegion/
    // CategoryRegion/SectionRegion have no rows for the region ("no rows =
    // visible in none"), so products, categories AND homepage sections all show
    // nothing — and a section in particular only renders once it has in-region
    // PRODUCTS, so linking all three together is what actually makes the home
    // populate. Admins can still curate DOWN afterwards (unlink per item, or
    // hide the region). Idempotent via createMany; the new region has no links
    // yet so there's nothing to skip.
    const [productIds, categoryIds, sectionIds] = await Promise.all([
      tx.product.findMany({ select: { id: true } }),
      tx.category.findMany({ select: { id: true } }),
      tx.section.findMany({ select: { id: true } }),
    ]);
    if (productIds.length > 0) {
      await tx.productRegion.createMany({
        data: productIds.map((p) => ({ productId: p.id, regionId: created.id })),
        skipDuplicates: true,
      });
    }
    if (categoryIds.length > 0) {
      await tx.categoryRegion.createMany({
        data: categoryIds.map((c) => ({ categoryId: c.id, regionId: created.id })),
        skipDuplicates: true,
      });
    }
    if (sectionIds.length > 0) {
      await tx.sectionRegion.createMany({
        data: sectionIds.map((s) => ({ sectionId: s.id, regionId: created.id })),
        skipDuplicates: true,
      });
    }
    return created;
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
  if (data.legalEntity !== undefined) payload.legalEntity = trimOrNull(data.legalEntity);
  if (data.shippingFlatRate !== undefined) {
    payload.shippingFlatRate = parseShippingFlatRate(data.shippingFlatRate);
  }
  if (data.standardDeliveryDays !== undefined) {
    payload.standardDeliveryDays = parseStandardDeliveryDays(data.standardDeliveryDays);
  }
  if (data.iso2 !== undefined) payload.iso2 = parseIso2(data.iso2);
  if (data.contactEmail !== undefined) payload.contactEmail = trimOrNull(data.contactEmail);
  if (data.contactPhone !== undefined) payload.contactPhone = trimOrNull(data.contactPhone);
  if (data.whatsappNumber !== undefined) payload.whatsappNumber = trimOrNull(data.whatsappNumber);
  if (data.address !== undefined) payload.address = trimOrNull(data.address);
  if (data.address_ar !== undefined) payload.address_ar = trimOrNull(data.address_ar);
  if (data.hours !== undefined) payload.hours = trimOrNull(data.hours);
  if (data.hours_ar !== undefined) payload.hours_ar = trimOrNull(data.hours_ar);
  Object.assign(payload, buildLegalFieldsPayload(data, { onlyDefined: true }));
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
  // Products/categories/sections/banners/promo codes are many-to-many with a
  // region (ProductRegion, CategoryRegion, etc.) — deleting a region removes
  // that region's row from each join table (all `onDelete: Cascade` in the
  // schema) but never touches the product/category/etc. itself, which may
  // still be linked to other regions. So none of those block deletion.
  //
  // Users and orders are different: `User.regionId`/`Order.regionId` are
  // direct references, not a multi-region join, so deleting a region a user
  // is still assigned to (or that has order history) needs an explicit
  // reassignment first rather than silently going null underneath them.
  const [userCount, orderCount] = await Promise.all([
    prisma.user.count({ where: { regionId: id } }),
    prisma.order.count({ where: { regionId: id } }),
  ]);
  if (userCount > 0 || orderCount > 0) {
    throw Object.assign(new Error('Region is still in use by users or orders. Reassign them first.'), {
      code: 'REGION_IN_USE',
      counts: { userCount, orderCount },
    });
  }
  await prisma.region.delete({ where: { id } });
  invalidateCache();
  return region;
}

/**
 * Bulk-links ALL existing products, categories and/or sections to a region in
 * one shot.
 *
 * A brand-new region starts with zero products, categories and sections visible
 * — `ProductRegion`/`CategoryRegion`/`SectionRegion` have no rows for it, by the
 * same "no rows = visible in none" design every region-scoped entity uses.
 * That's correct for a deliberate, curated rollout, but it means creating a
 * region gives an admin an empty storefront with no obvious way to populate it.
 *
 * Crucially, a section is only ever *rendered* on the storefront when it also
 * resolves to at least one in-region product (the home hides empty rails), so
 * linking sections without also linking their products would still show nothing
 * — hence this action links all three together. This mirrors "make my whole
 * existing catalog available in this new region too," which is what an admin
 * expanding into a new market wants almost all the time.
 *
 * Idempotent (`skipDuplicates`) — safe to run more than once, only adds the
 * links that are missing, never duplicates or removes anything.
 */
async function bulkAssignRegion(regionId, { products = false, categories = false, sections = false } = {}) {
  const region = await prisma.region.findUnique({ where: { id: regionId } });
  if (!region) return null;

  const result = { productsLinked: 0, categoriesLinked: 0, sectionsLinked: 0 };

  if (products) {
    const allProducts = await prisma.product.findMany({ select: { id: true } });
    if (allProducts.length > 0) {
      const { count } = await prisma.productRegion.createMany({
        data: allProducts.map((p) => ({ productId: p.id, regionId })),
        skipDuplicates: true,
      });
      result.productsLinked = count;
    }
  }

  if (categories) {
    const allCategories = await prisma.category.findMany({ select: { id: true } });
    if (allCategories.length > 0) {
      const { count } = await prisma.categoryRegion.createMany({
        data: allCategories.map((c) => ({ categoryId: c.id, regionId })),
        skipDuplicates: true,
      });
      result.categoriesLinked = count;
    }
  }

  if (sections) {
    const allSections = await prisma.section.findMany({ select: { id: true } });
    if (allSections.length > 0) {
      const { count } = await prisma.sectionRegion.createMany({
        data: allSections.map((s) => ({ sectionId: s.id, regionId })),
        skipDuplicates: true,
      });
      result.sectionsLinked = count;
    }
  }

  return result;
}

/**
 * Reorder regions by assigning explicit sortOrder values (admin drag-and-drop).
 * Accepts an array of { id, sortOrder }. Runs in a single transaction, then
 * invalidates the in-memory region cache so the storefront picker order (which
 * is served from cache, ordered by sortOrder) reflects the new order at once.
 * Mirrors sectionService.reorderSections.
 * @param {{ id: string, sortOrder: number }[]} items
 */
async function reorderRegions(items) {
  const clean = (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it.id === 'string' && Number.isInteger(it.sortOrder))
    .map((it) => ({ id: it.id, sortOrder: it.sortOrder }));
  if (clean.length === 0) return { count: 0 };

  await prisma.$transaction(
    clean.map((it) =>
      prisma.region.update({ where: { id: it.id }, data: { sortOrder: it.sortOrder } })
    )
  );
  invalidateCache();
  return { count: clean.length };
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
  bulkAssignRegion,
  reorderRegions,
  invalidateCache,
};
