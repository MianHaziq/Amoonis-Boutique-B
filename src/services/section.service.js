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
      ...(hasFilter ? { where: { product: contentWhere } } : {}),
      include: {
        product: {
          include: {
            category: { select: { id: true, title: true } },
            images: { orderBy: { sortOrder: 'asc' } },
            descriptions: { orderBy: { sortOrder: 'asc' } },
            productOptions: { orderBy: { sortOrder: 'asc' } },
            ...(isStaff ? SECTION_REGION_INCLUDE : {}),
          },
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

function mapProductForSection(pr) {
  if (!pr || !pr.product) return null;
  return productService.mapProduct(pr.product);
}

function mapSection(s) {
  if (!s) return null;
  const out = {
    id: s.id,
    title: s.title,
    title_ar: s.title_ar ?? null,
    image: s.image ?? null,
    sortOrder: s.sortOrder,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    products: (s.products || []).map(mapProductForSection).filter(Boolean),
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

async function getSections(visibility = {}) {
  const sections = await prisma.section.findMany({
    where: buildVisibilityWhere(visibility),
    orderBy: { sortOrder: 'asc' },
    include: sectionInclude(visibility),
  });
  return sections.map(mapSection);
}

async function getSectionById(id, visibility = {}) {
  const section = await prisma.section.findFirst({
    where: { id, ...buildVisibilityWhere(visibility) },
    include: sectionInclude(visibility),
  });
  return mapSection(section);
}

async function createSection(data) {
  const titleEn = String(data.title ?? '').trim();
  const titleAr = String(data.title_ar ?? '').trim();
  if (!titleEn && !titleAr) throw new Error('Section title is required (provide title or title_ar)');

  const productIds = Array.isArray(data.productIds) ? data.productIds.filter((id) => id && String(id).trim()) : [];
  const categoryIds = Array.isArray(data.categoryIds) ? data.categoryIds.filter((id) => id && String(id).trim()) : [];
  const status = normalizeStatus(data.status);
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
      ...(regionIds.length > 0
        ? { regions: { create: regionIds.map((regionId) => ({ regionId })) } }
        : {}),
    },
  });

  if (productIds.length > 0) {
    await prisma.sectionProduct.createMany({
      data: productIds.map((productId, i) => ({
        sectionId: section.id,
        productId: String(productId).trim(),
        sortOrder: i,
      })),
      skipDuplicates: true,
    });
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

  if (data.productIds !== undefined) {
    await prisma.sectionProduct.deleteMany({ where: { sectionId: id } });
    const productIds = Array.isArray(data.productIds) ? data.productIds.filter((id) => id && String(id).trim()) : [];
    if (productIds.length > 0) {
      await prisma.sectionProduct.createMany({
        data: productIds.map((productId, i) => ({
          sectionId: id,
          productId: String(productId).trim(),
          sortOrder: i,
        })),
        skipDuplicates: true,
      });
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
  getSectionById,
  createSection,
  updateSection,
  deleteSection,
  reorderSections,
};
