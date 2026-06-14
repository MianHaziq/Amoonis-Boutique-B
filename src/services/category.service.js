const prisma = require('../config/db');
const { autoTranslate, fillBilingualGapsFromTwin } = require('../utils/bilingual');
const regionService = require('./region.service');
const { buildVisibilityWhere } = require('../utils/regionVisibility');

const CATEGORY_BILINGUAL = [
  { src: 'title', dst: 'title_ar' },
  { src: 'description', dst: 'description_ar' },
];
// Pairs whose EN column is NOT NULL in the schema — must be filled before Prisma.create.
const CATEGORY_REQUIRED_PAIRS = [{ src: 'title', dst: 'title_ar' }];

const REGION_INCLUDE = {
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

/** Shape a category row (with regions/_count includes) for API output. */
function mapCategory(category) {
  if (!category) return null;
  const { regions, _count, ...rest } = category;
  const out = {
    ...rest,
    totalProducts: _count?.products ?? rest.totalProducts,
  };
  // Region tags only attached for staff reads (storefront doesn't need them).
  if (Array.isArray(regions)) {
    const regionList = regions.map((r) => r.region).filter(Boolean);
    out.regions = regionList;
    out.regionIds = regionList.map((r) => r.id);
  }
  return out;
}

async function createCategory(data) {
  const status = normalizeStatus(data.status);
  const regionIds = await resolveWriteRegionIds(data.regionIds);

  const draft = {
    title: data.title ?? null,
    title_ar: data.title_ar ?? null,
    description: data.description ?? null,
    description_ar: data.description_ar ?? null,
  };
  await autoTranslate(draft, CATEGORY_BILINGUAL);
  // If Google failed for the required pair, copy across so the NOT NULL column has a value.
  fillBilingualGapsFromTwin(draft, CATEGORY_REQUIRED_PAIRS);
  const category = await prisma.category.create({
    data: {
      title: draft.title,
      title_ar: draft.title_ar ?? null,
      description: draft.description ?? null,
      description_ar: draft.description_ar ?? null,
      image: data.image ?? null,
      totalProducts: 0,
      status,
      ...(regionIds.length > 0
        ? { regions: { create: regionIds.map((regionId) => ({ regionId })) } }
        : {}),
    },
    include: { ...REGION_INCLUDE, _count: { select: { products: true } } },
  });
  return mapCategory(category);
}

async function updateCategory(id, data) {
  // Only translate sides the admin actually touched in this request.
  const draft = {};
  if (data.title !== undefined) draft.title = data.title;
  if (data.title_ar !== undefined) draft.title_ar = data.title_ar;
  if (data.description !== undefined) draft.description = data.description;
  if (data.description_ar !== undefined) draft.description_ar = data.description_ar;
  await autoTranslate(draft, CATEGORY_BILINGUAL);

  const newRegionIds = data.regionIds !== undefined
    ? await regionService.assertValidRegionIds(Array.isArray(data.regionIds) ? data.regionIds : [])
    : null;

  await prisma.$transaction(async (tx) => {
    await tx.category.update({
      where: { id },
      data: {
        ...(draft.title != null && { title: draft.title }),
        ...(draft.title_ar !== undefined && { title_ar: draft.title_ar ?? null }),
        ...(draft.description !== undefined && { description: draft.description }),
        ...(draft.description_ar !== undefined && { description_ar: draft.description_ar ?? null }),
        ...(data.image !== undefined && { image: data.image }),
        ...(data.status !== undefined && { status: normalizeStatus(data.status) }),
      },
    });
    if (newRegionIds !== null) {
      await tx.categoryRegion.deleteMany({ where: { categoryId: id } });
      if (newRegionIds.length > 0) {
        await tx.categoryRegion.createMany({
          data: newRegionIds.map((regionId) => ({ categoryId: id, regionId })),
          skipDuplicates: true,
        });
      }
    }
  });

  const category = await prisma.category.findUnique({
    where: { id },
    include: { ...REGION_INCLUDE, _count: { select: { products: true } } },
  });
  return mapCategory(category);
}

async function deleteCategory(id) {
  const count = await prisma.product.count({ where: { categoryId: id } });
  if (count > 0) {
    const err = new Error('Cannot delete category with products');
    err.code = 'CATEGORY_HAS_PRODUCTS';
    throw err;
  }
  return prisma.category.delete({ where: { id } });
}

async function getAllCategories(visibility = {}) {
  const categories = await prisma.category.findMany({
    where: buildVisibilityWhere(visibility),
    orderBy: { createdAt: 'desc' },
    include: { ...(visibility.isStaff ? REGION_INCLUDE : {}), _count: { select: { products: true } } },
  });
  return categories.map(mapCategory);
}

async function getCategoryById(id, includeProducts = false, visibility = {}) {
  const include = {
    ...(visibility.isStaff ? REGION_INCLUDE : {}),
    _count: { select: { products: true } },
    ...(includeProducts ? { products: true } : {}),
  };
  const category = await prisma.category.findFirst({
    where: { id, ...buildVisibilityWhere(visibility) },
    include,
  });
  if (!category) return null;
  const { products, ...rest } = category;
  const mapped = mapCategory(rest);
  if (products) mapped.products = products;
  return mapped;
}

async function incrementCategoryProductCount(categoryId, delta = 1) {
  return prisma.category.update({
    where: { id: categoryId },
    data: { totalProducts: { increment: delta } },
  });
}

async function decrementCategoryProductCount(categoryId, delta = 1) {
  return prisma.category.update({
    where: { id: categoryId },
    data: { totalProducts: { decrement: delta } },
  });
}

module.exports = {
  createCategory,
  updateCategory,
  deleteCategory,
  getAllCategories,
  getCategoryById,
  incrementCategoryProductCount,
  decrementCategoryProductCount,
  mapCategory,
};
