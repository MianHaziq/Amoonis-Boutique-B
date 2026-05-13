const prisma = require('../config/db');
const { autoTranslate, fillBilingualGapsFromTwin } = require('../utils/bilingual');

const CATEGORY_BILINGUAL = [
  { src: 'title', dst: 'title_ar' },
  { src: 'description', dst: 'description_ar' },
];
// Pairs whose EN column is NOT NULL in the schema — must be filled before Prisma.create.
const CATEGORY_REQUIRED_PAIRS = [{ src: 'title', dst: 'title_ar' }];

async function createCategory(data) {
  const draft = {
    title: data.title ?? null,
    title_ar: data.title_ar ?? null,
    description: data.description ?? null,
    description_ar: data.description_ar ?? null,
  };
  await autoTranslate(draft, CATEGORY_BILINGUAL);
  // If Google failed for the required pair, copy across so the NOT NULL column has a value.
  fillBilingualGapsFromTwin(draft, CATEGORY_REQUIRED_PAIRS);
  return prisma.category.create({
    data: {
      title: draft.title,
      title_ar: draft.title_ar ?? null,
      description: draft.description ?? null,
      description_ar: draft.description_ar ?? null,
      image: data.image ?? null,
      totalProducts: 0,
    },
  });
}

async function updateCategory(id, data) {
  // Only translate sides the admin actually touched in this request. autoTranslate may add
  // the twin field to the draft (e.g. admin sent only `title` → fills `title_ar`), so we
  // gate the Prisma update on the draft, not on what the admin originally sent.
  const draft = {};
  if (data.title !== undefined) draft.title = data.title;
  if (data.title_ar !== undefined) draft.title_ar = data.title_ar;
  if (data.description !== undefined) draft.description = data.description;
  if (data.description_ar !== undefined) draft.description_ar = data.description_ar;
  await autoTranslate(draft, CATEGORY_BILINGUAL);

  return prisma.category.update({
    where: { id },
    data: {
      ...(draft.title != null && { title: draft.title }),
      ...(draft.title_ar !== undefined && { title_ar: draft.title_ar ?? null }),
      ...(draft.description !== undefined && { description: draft.description }),
      ...(draft.description_ar !== undefined && { description_ar: draft.description_ar ?? null }),
      ...(data.image !== undefined && { image: data.image }),
    },
  });
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

async function getAllCategories() {
  return prisma.category.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { products: true } },
    },
  });
}

async function getCategoryById(id, includeProducts = false) {
  const include = includeProducts
    ? { products: true, _count: { select: { products: true } } }
    : { _count: { select: { products: true } } };
  const category = await prisma.category.findUnique({
    where: { id },
    include,
  });
  return category;
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
};
