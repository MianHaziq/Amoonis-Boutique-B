/**
 * Sections: admin-created blocks for user panel (e.g. Ramadan Deals).
 * Each section has title (required), optional image, and ordered products + categories.
 * Product/category shape matches how we show products and categories to users elsewhere.
 */
const prisma = require('../config/db');
const productService = require('./product.service');
const regionService = require('./region.service');
const { autoTranslate } = require('../utils/bilingual');
const { buildVisibilityWhere } = require('../utils/regionVisibility');

const SECTION_BILINGUAL = [{ src: 'title', dst: 'title_ar' }];

const SECTION_REGION_INCLUDE = {
  regions: { include: { region: { select: { id: true, code: true, name: true, name_ar: true } } } },
};

function normalizeStatus(value, fallback = 'DRAFT') {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toUpperCase();
  return v === 'PUBLISHED' ? 'PUBLISHED' : v === 'DRAFT' ? 'DRAFT' : fallback;
}

const VALID_SECTION_KINDS = ['CUSTOM', 'BEST_SELLERS', 'NEW_ARRIVALS'];

function normalizeKind(value, fallback = 'CUSTOM') {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toUpperCase();
  return VALID_SECTION_KINDS.includes(v) ? v : fallback;
}

const VALID_SECTION_LAYOUTS = ['GRID', 'SCROLL'];

function normalizeLayout(value, fallback = 'SCROLL') {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toUpperCase();
  return VALID_SECTION_LAYOUTS.includes(v) ? v : fallback;
}

// Per-breakpoint column bounds — mirror the express-validator ranges in
// section.routes.js and the admin form's select options. clampColumns re-clamps
// as a backstop so a malformed direct API call can never persist a layout-breaking
// column count (e.g. 0 or 99), even if it somehow bypassed route validation.
const COLUMN_BOUNDS = {
  desktop: { min: 2, max: 6, default: 4 },
  mobile: { min: 1, max: 4, default: 2 },
};

function clampColumns(value, breakpoint, fallback) {
  const b = COLUMN_BOUNDS[breakpoint];
  const fb = fallback ?? b.default;
  const n = Number(value);
  if (!Number.isFinite(n)) return fb;
  return Math.min(b.max, Math.max(b.min, Math.round(n)));
}

// Max products rendered per breakpoint. Default 12 matches the historical per-rail
// cap so existing sections are unchanged. Same backstop-clamp rationale as columns.
const LIMIT_BOUNDS = {
  desktop: { min: 1, max: 24, default: 12 },
  mobile: { min: 1, max: 12, default: 12 },
};

function clampLimit(value, breakpoint, fallback) {
  const b = LIMIT_BOUNDS[breakpoint];
  const fb = fallback ?? b.default;
  const n = Number(value);
  if (!Number.isFinite(n)) return fb;
  return Math.min(b.max, Math.max(b.min, Math.round(n)));
}

async function resolveWriteRegionIds(regionIds) {
  if (Array.isArray(regionIds) && regionIds.length > 0) {
    return regionService.assertValidRegionIds(regionIds);
  }
  const def = await regionService.getDefaultRegion();
  return def ? [def.id] : [];
}

function mapSectionRegions(section) {
  if (!section || !Array.isArray(section.regions)) return [];
  return section.regions.map((r) => r.region).filter(Boolean);
}

/**
 * The product include shape for a section's nested products — shared between the
 * curated `SectionProduct` query below and `augmentDynamicSection`'s dynamic-fill
 * query, so a curated pick and a dynamically-added one are always fetched (and
 * therefore priced/rendered) identically.
 */
function sectionProductInclude(isStaff) {
  return {
    // comingSoon lets the storefront cascade a coming-soon category onto its products
    // shown in a homepage section (a product is coming-soon if its own OR its category's).
    category: { select: { id: true, title: true, comingSoon: true } },
    images: { orderBy: { sortOrder: 'asc' } },
    descriptions: { orderBy: { sortOrder: 'asc' } },
    productOptions: { orderBy: { sortOrder: 'asc' } },
    ...(isStaff ? SECTION_REGION_INCLUDE : {}),
  };
}

/**
 * Builds the section query include. For storefront (non-staff) requests, the nested
 * products and categories are filtered to PUBLISHED + in-region so a UAE-only product
 * never leaks into a Saudi user's view through a multi-region section.
 */
function sectionInclude(visibility = {}) {
  const contentWhere = buildVisibilityWhere(visibility);
  const hasFilter = Object.keys(contentWhere).length > 0;
  const isStaff = !!visibility.isStaff;
  // Region tags are only loaded for staff reads. The nested visibility WHERE (region +
  // published filtering of products/categories) always applies for storefront so a
  // UAE-only product can't leak into a Saudi section.
  return {
    products: {
      orderBy: { sortOrder: 'asc' },
      // Bound the nested product fetch so a section with thousands of products can't
      // blow up the response / DB load. orderBy(sortOrder asc) keeps the first N
      // deterministic (the intended leading products).
      take: 50,
      // `excluded: false` — excluded rows record an admin's "hide this auto-added
      // product" choice; they are NEVER rendered as curated picks (staff or storefront)
      // and are read separately (getSectionEditorPreview) for the admin's excluded list.
      where: {
        excluded: false,
        ...(hasFilter ? { product: contentWhere } : {}),
      },
      include: {
        product: {
          include: sectionProductInclude(isStaff),
        },
      },
    },
    categories: {
      orderBy: { sortOrder: 'asc' },
      ...(hasFilter ? { where: { category: contentWhere } } : {}),
      // CAT-4: include the live product _count so the section's per-category product
      // total reflects reality instead of the denormalized (drift-prone) totalProducts.
      include: {
        category: {
          include: {
            _count: { select: { products: true } },
            ...(isStaff ? SECTION_REGION_INCLUDE : {}),
          },
        },
      },
    },
    ...(isStaff ? SECTION_REGION_INCLUDE : {}),
  };
}

function mapCategoryForSection(cat) {
  if (!cat || !cat.category) return null;
  const { category } = cat;
  const out = {
    id: category.id,
    title: category.title,
    title_ar: category.title_ar ?? null,
    description: category.description ?? null,
    description_ar: category.description_ar ?? null,
    image: category.image ?? null,
    // CAT-4: prefer the live count; fall back to the denormalized column only if absent.
    totalProducts: category._count?.products ?? category.totalProducts ?? 0,
    status: category.status,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
  if (Array.isArray(category.regions)) {
    const regionList = category.regions.map((r) => r.region).filter(Boolean);
    out.regions = regionList;
    out.regionIds = regionList.map((r) => r.id);
  }
  return out;
}

function mapProductForSection(pr, visibility) {
  if (!pr || !pr.product) return null;
  const mapped = productService.mapProduct(pr.product);
  return visibility?.isStaff ? mapped : productService.applyRegionCurrency(mapped, visibility?.currency);
}

function mapSection(s, visibility = {}) {
  if (!s) return null;
  const out = {
    id: s.id,
    title: s.title,
    title_ar: s.title_ar ?? null,
    image: s.image ?? null,
    sortOrder: s.sortOrder,
    status: s.status,
    // Not staff-gated (unlike regions/regionIds below) — the storefront needs this
    // to build the right "View all" link for a Best Sellers/New Arrivals rail.
    kind: s.kind ?? 'CUSTOM',
    // Per-section layout — also not staff-gated: the storefront reads these to
    // decide grid-vs-scroll and the column count per breakpoint. Fallbacks match
    // the schema defaults so a row written before this feature still maps cleanly.
    desktopLayout: normalizeLayout(s.desktopLayout),
    desktopColumns: clampColumns(s.desktopColumns, 'desktop'),
    desktopLimit: clampLimit(s.desktopLimit, 'desktop'),
    mobileLayout: normalizeLayout(s.mobileLayout),
    mobileColumns: clampColumns(s.mobileColumns, 'mobile'),
    mobileLimit: clampLimit(s.mobileLimit, 'mobile'),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    products: (s.products || []).map((pr) => mapProductForSection(pr, visibility)).filter(Boolean),
    categories: (s.categories || []).map(mapCategoryForSection).filter(Boolean),
  };
  // Region tags only present on staff reads.
  if (Array.isArray(s.regions)) {
    const regionList = mapSectionRegions(s);
    out.regions = regionList;
    out.regionIds = regionList.map((r) => r.id);
  }
  return out;
}

// Upper bound on how many products a dynamic (BEST_SELLERS/NEW_ARRIVALS) section
// auto-fills to. Matches the storefront's largest possible per-section render count
// (display.ts's SECTION_MAX_RENDER = max allowed desktopLimit), so a section whose
// admin set a high desktop limit can actually be filled to it — no point fetching
// more than what could ever be shown.
const HOME_SECTION_DYNAMIC_CAP = 24;

/**
 * For a BEST_SELLERS/NEW_ARRIVALS section, appends products beyond whatever's
 * manually curated — newest-published for NEW_ARRIVALS, top-selling for
 * BEST_SELLERS — up to HOME_SECTION_DYNAMIC_CAP, so the rail grows on its own as
 * new products publish / new sales land, without an admin re-editing the section.
 * Curated picks always stay first, in their curated order, and are never
 * duplicated by a dynamic pick.
 *
 * Storefront-read-only: no-ops for staff reads (the admin edit view must show only
 * the true curated SectionProduct rows, never a dynamically-injected extra — saving
 * the section from the admin form always sends the FULL productIds list, so if a
 * dynamic extra leaked into that view it would get permanently baked in as if it
 * had been manually curated) and no-ops for CUSTOM sections (unchanged behavior).
 *
 * Mutates and returns `rawSection` (a raw Prisma Section row, pre-mapSection) —
 * appends synthetic entries to `rawSection.products` shaped exactly like a real
 * SectionProduct join row, so mapSection's existing mapping code needs no changes.
 */
async function augmentDynamicSection(rawSection, visibility = {}) {
  if (visibility.isStaff) return rawSection;
  if (rawSection.kind !== 'BEST_SELLERS' && rawSection.kind !== 'NEW_ARRIVALS') return rawSection;

  const curatedIds = rawSection.products.map((sp) => sp.productId);
  const remaining = HOME_SECTION_DYNAMIC_CAP - curatedIds.length;
  if (remaining <= 0) return rawSection;

  try {
    // Products the admin explicitly HID from this section's auto-grow (excluded=true
    // SectionProduct rows) must never be re-added by the dynamic fill.
    const excludedRows = await prisma.sectionProduct.findMany({
      where: { sectionId: rawSection.id, excluded: true },
      select: { productId: true },
    });
    const skipIds = [...curatedIds, ...excludedRows.map((r) => r.productId)];
    const excludeWhere = { ...buildVisibilityWhere(visibility), id: { notIn: skipIds } };

    let extraIds = [];
    if (rawSection.kind === 'NEW_ARRIVALS') {
      const rows = await prisma.product.findMany({
        where: excludeWhere,
        // `id` tiebreaker after createdAt so a batch of products sharing a timestamp
        // has a deterministic order (matches getNewArrivals).
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: { id: true },
        take: remaining,
      });
      extraIds = rows.map((r) => r.id);
    } else {
      const skipSet = new Set(skipIds);
      const rankedIds = (await productService.getBestSellingProductIds(visibility.regionId ?? null))
        .filter((id) => !skipSet.has(id));
      if (rankedIds.length > 0) {
        // getBestSellingProductIds only knows about historical OrderItem rows — a
        // product that sold well may since have been unpublished/deleted/moved out
        // of this region, so re-check current visibility before trusting the ranking.
        const visible = await prisma.product.findMany({
          where: { ...buildVisibilityWhere(visibility), id: { in: rankedIds } },
          select: { id: true },
        });
        const visibleSet = new Set(visible.map((p) => p.id));
        extraIds = rankedIds.filter((id) => visibleSet.has(id)).slice(0, remaining);
      }
    }
    if (extraIds.length === 0) return rawSection;

    const extraProducts = await prisma.product.findMany({
      where: { id: { in: extraIds } },
      include: sectionProductInclude(visibility.isStaff),
    });
    const byId = new Map(extraProducts.map((p) => [p.id, p]));
    const startOrder = rawSection.products.length
      ? Math.max(...rawSection.products.map((sp) => sp.sortOrder)) + 1
      : 0;
    const synthetic = extraIds
      .map((id, i) => {
        const product = byId.get(id);
        return product ? { productId: id, sortOrder: startOrder + i, product } : null;
      })
      .filter(Boolean);

    rawSection.products = [...rawSection.products, ...synthetic];
  } catch (err) {
    // A dynamic-fill failure (e.g. the sales-ranking aggregation errors) must never
    // break the whole /sections response — degrade gracefully to the curated-only
    // list, which is always a valid non-empty rail on its own.
    console.error(`[sections] dynamic fill failed for section ${rawSection.id} (${rawSection.kind}):`, err.message);
  }
  return rawSection;
}

async function getSections(visibility = {}) {
  const sections = await prisma.section.findMany({
    where: buildVisibilityWhere(visibility),
    orderBy: { sortOrder: 'asc' },
    include: sectionInclude(visibility),
  });
  await Promise.all(sections.map((s) => augmentDynamicSection(s, visibility)));
  return sections.map((s) => mapSection(s, visibility));
}

/**
 * Distinct product ids CURRENTLY surfaced by any published section for this visibility —
 * curated `SectionProduct` picks plus the dynamic Best Sellers / New Arrivals fill, i.e.
 * exactly the products the storefront rails display. The shop's "Everything" list uses
 * this to RESCUE these back into view even when their category is ENTIRE_STORE-draft, so
 * a featured product doesn't disappear from the grid just because its category is hidden.
 */
async function getSurfacedProductIds(visibility = {}) {
  const sections = await getSections(visibility);
  const ids = new Set();
  for (const s of sections) {
    for (const p of s.products || []) {
      if (p && p.id) ids.add(p.id);
    }
  }
  return [...ids];
}

/**
 * Staff-only editor preview for a dynamic (BEST_SELLERS/NEW_ARRIVALS) section: the
 * products the auto-grow WOULD surface right now beyond the curated picks (so the admin
 * can see and Pin/Hide them), plus the products the admin has already Hidden (excluded).
 * Runs the augmentation with a storefront-shaped visibility (default region — the primary
 * view; best-sellers/new-arrivals ranking is region-specific) since it no-ops for staff.
 * Returns { auto: Product[], excluded: Product[] } — empty for CUSTOM sections.
 */
async function getSectionEditorPreview(id) {
  const def = await regionService.getDefaultRegion();
  const vis = { isStaff: false, regionId: def?.id ?? null };
  const raw = await prisma.section.findFirst({ where: { id }, include: sectionInclude(vis) });
  if (!raw) return null;
  if (raw.kind !== 'BEST_SELLERS' && raw.kind !== 'NEW_ARRIVALS') return { auto: [], excluded: [] };

  const curatedCount = raw.products.length;
  await augmentDynamicSection(raw, vis);
  const auto = raw.products
    .slice(curatedCount) // synthetic dynamic-fill rows appended by augmentDynamicSection
    .map((pr) => mapProductForSection(pr, vis))
    .filter(Boolean);

  const excludedRows = await prisma.sectionProduct.findMany({
    where: { sectionId: id, excluded: true },
    include: { product: { include: sectionProductInclude(false) } },
    orderBy: { sortOrder: 'asc' },
  });
  const excluded = excludedRows.map((pr) => mapProductForSection(pr, vis)).filter(Boolean);

  return { auto, excluded };
}

async function getSectionById(id, visibility = {}) {
  const section = await prisma.section.findFirst({
    where: { id, ...buildVisibilityWhere(visibility) },
    include: sectionInclude(visibility),
  });
  if (section) await augmentDynamicSection(section, visibility);
  return mapSection(section, visibility);
}

async function createSection(data) {
  const titleEn = String(data.title ?? '').trim();
  const titleAr = String(data.title_ar ?? '').trim();
  if (!titleEn && !titleAr) throw new Error('Section title is required (provide title or title_ar)');

  const productIds = Array.isArray(data.productIds) ? data.productIds.filter((id) => id && String(id).trim()) : [];
  const categoryIds = Array.isArray(data.categoryIds) ? data.categoryIds.filter((id) => id && String(id).trim()) : [];
  const status = normalizeStatus(data.status);
  const kind = normalizeKind(data.kind);
  const desktopLayout = normalizeLayout(data.desktopLayout);
  const mobileLayout = normalizeLayout(data.mobileLayout);
  const desktopColumns = clampColumns(data.desktopColumns, 'desktop');
  const mobileColumns = clampColumns(data.mobileColumns, 'mobile');
  const desktopLimit = clampLimit(data.desktopLimit, 'desktop');
  const mobileLimit = clampLimit(data.mobileLimit, 'mobile');
  const regionIds = await resolveWriteRegionIds(data.regionIds);

  const maxOrder = await prisma.section.aggregate({ _max: { sortOrder: true } }).then((r) => (r._max.sortOrder ?? -1) + 1);

  const titleDraft = {
    title: titleEn || null,
    title_ar: titleAr || null,
  };
  await autoTranslate(titleDraft, SECTION_BILINGUAL);
  // If translation failed and only one side has content, copy across so NOT NULL is satisfied.
  // Admin can re-save later when Google is back to get a proper translation.
  if (!titleDraft.title && titleDraft.title_ar) titleDraft.title = titleDraft.title_ar;
  if (!titleDraft.title_ar && titleDraft.title) titleDraft.title_ar = titleDraft.title;

  const section = await prisma.section.create({
    data: {
      title: titleDraft.title,
      title_ar: titleDraft.title_ar ?? null,
      image: data.image != null ? String(data.image).trim() || null : null,
      sortOrder: data.sortOrder != null ? Number(data.sortOrder) : maxOrder,
      status,
      kind,
      desktopLayout,
      desktopColumns,
      desktopLimit,
      mobileLayout,
      mobileColumns,
      mobileLimit,
      ...(regionIds.length > 0
        ? { regions: { create: regionIds.map((regionId) => ({ regionId })) } }
        : {}),
    },
  });

  // Curated picks (excluded=false) + admin-hidden auto products (excluded=true). A
  // product can't be both — curated wins if it somehow appears in both lists.
  const curatedSet = new Set(productIds.map((pid) => String(pid).trim()));
  const excludedProductIds = (Array.isArray(data.excludedProductIds) ? data.excludedProductIds : [])
    .map((pid) => String(pid ?? '').trim())
    .filter((pid) => pid && !curatedSet.has(pid));
  const sectionProductRows = [
    ...productIds.map((productId, i) => ({ sectionId: section.id, productId: String(productId).trim(), sortOrder: i, excluded: false })),
    ...excludedProductIds.map((productId) => ({ sectionId: section.id, productId, sortOrder: 0, excluded: true })),
  ];
  if (sectionProductRows.length > 0) {
    await prisma.sectionProduct.createMany({ data: sectionProductRows, skipDuplicates: true });
  }
  if (categoryIds.length > 0) {
    await prisma.sectionCategory.createMany({
      data: categoryIds.map((categoryId, i) => ({
        sectionId: section.id,
        categoryId: String(categoryId).trim(),
        sortOrder: i,
      })),
      skipDuplicates: true,
    });
  }

  return getSectionById(section.id, { isStaff: true });
}

async function updateSection(id, data) {
  const existing = await prisma.section.findUnique({ where: { id } });
  if (!existing) return null;

  const updatePayload = {};
  if (data.title !== undefined) {
    const title = String(data.title).trim();
    if (!title) throw new Error('Section title cannot be empty');
    updatePayload.title = title;
  }
  if (data.title_ar !== undefined) {
    updatePayload.title_ar = data.title_ar ? String(data.title_ar).trim() || null : null;
  }
  // Fill the missing twin if admin only sent one side.
  await autoTranslate(updatePayload, SECTION_BILINGUAL);
  if (data.image !== undefined) updatePayload.image = data.image ? String(data.image).trim() : null;
  if (data.sortOrder !== undefined) updatePayload.sortOrder = Number(data.sortOrder);
  if (data.status !== undefined) updatePayload.status = normalizeStatus(data.status, existing.status);
  if (data.kind !== undefined) updatePayload.kind = normalizeKind(data.kind, existing.kind);
  if (data.desktopLayout !== undefined) updatePayload.desktopLayout = normalizeLayout(data.desktopLayout, existing.desktopLayout);
  if (data.mobileLayout !== undefined) updatePayload.mobileLayout = normalizeLayout(data.mobileLayout, existing.mobileLayout);
  if (data.desktopColumns !== undefined) updatePayload.desktopColumns = clampColumns(data.desktopColumns, 'desktop', existing.desktopColumns);
  if (data.mobileColumns !== undefined) updatePayload.mobileColumns = clampColumns(data.mobileColumns, 'mobile', existing.mobileColumns);
  if (data.desktopLimit !== undefined) updatePayload.desktopLimit = clampLimit(data.desktopLimit, 'desktop', existing.desktopLimit);
  if (data.mobileLimit !== undefined) updatePayload.mobileLimit = clampLimit(data.mobileLimit, 'mobile', existing.mobileLimit);

  const newRegionIds = data.regionIds !== undefined
    ? await regionService.assertValidRegionIds(Array.isArray(data.regionIds) ? data.regionIds : [])
    : null;

  if (Object.keys(updatePayload).length > 0) {
    await prisma.section.update({
      where: { id },
      data: updatePayload,
    });
  }

  if (newRegionIds !== null) {
    await prisma.sectionRegion.deleteMany({ where: { sectionId: id } });
    if (newRegionIds.length > 0) {
      await prisma.sectionRegion.createMany({
        data: newRegionIds.map((regionId) => ({ sectionId: id, regionId })),
        skipDuplicates: true,
      });
    }
  }

  // Curated picks (excluded=false) and admin-hidden auto products (excluded=true) share
  // the SectionProduct table, so a productIds OR excludedProductIds change rebuilds BOTH
  // (deleteMany wipes all). Whichever list the payload omits is preserved from existing.
  if (data.productIds !== undefined || data.excludedProductIds !== undefined) {
    const existingRows = await prisma.sectionProduct.findMany({
      where: { sectionId: id },
      select: { productId: true, excluded: true, sortOrder: true },
    });
    const curated = data.productIds !== undefined
      ? (Array.isArray(data.productIds) ? data.productIds : []).map((pid) => String(pid ?? '').trim()).filter(Boolean)
      : existingRows.filter((r) => !r.excluded).sort((a, b) => a.sortOrder - b.sortOrder).map((r) => r.productId);
    const excludedRaw = data.excludedProductIds !== undefined
      ? (Array.isArray(data.excludedProductIds) ? data.excludedProductIds : []).map((pid) => String(pid ?? '').trim()).filter(Boolean)
      : existingRows.filter((r) => r.excluded).map((r) => r.productId);
    const curatedSet = new Set(curated);
    const excluded = excludedRaw.filter((pid) => !curatedSet.has(pid));

    await prisma.sectionProduct.deleteMany({ where: { sectionId: id } });
    const rows = [
      ...curated.map((productId, i) => ({ sectionId: id, productId, sortOrder: i, excluded: false })),
      ...excluded.map((productId) => ({ sectionId: id, productId, sortOrder: 0, excluded: true })),
    ];
    if (rows.length > 0) {
      await prisma.sectionProduct.createMany({ data: rows, skipDuplicates: true });
    }
  }

  if (data.categoryIds !== undefined) {
    await prisma.sectionCategory.deleteMany({ where: { sectionId: id } });
    const categoryIds = Array.isArray(data.categoryIds) ? data.categoryIds.filter((id) => id && String(id).trim()) : [];
    if (categoryIds.length > 0) {
      await prisma.sectionCategory.createMany({
        data: categoryIds.map((categoryId, i) => ({
          sectionId: id,
          categoryId: String(categoryId).trim(),
          sortOrder: i,
        })),
        skipDuplicates: true,
      });
    }
  }

  return getSectionById(id, { isStaff: true });
}

async function deleteSection(id) {
  await prisma.section.delete({ where: { id } });
  return true;
}

/**
 * Reorder sections by assigning explicit sortOrder values (admin drag-and-drop).
 * Accepts an array of { id, sortOrder }. Runs in a single transaction.
 * @param {{ id: string, sortOrder: number }[]} items
 */
async function reorderSections(items) {
  const clean = (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it.id === 'string' && Number.isInteger(it.sortOrder))
    .map((it) => ({ id: it.id, sortOrder: it.sortOrder }));
  if (clean.length === 0) return { count: 0 };

  await prisma.$transaction(
    clean.map((it) =>
      prisma.section.update({ where: { id: it.id }, data: { sortOrder: it.sortOrder } })
    )
  );
  return { count: clean.length };
}

module.exports = {
  getSections,
  getSurfacedProductIds,
  getSectionEditorPreview,
  getSectionById,
  createSection,
  updateSection,
  deleteSection,
  reorderSections,
};
