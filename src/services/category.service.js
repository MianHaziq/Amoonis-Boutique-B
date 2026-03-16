const prisma = require('../config/db');

async function createCategory(data) {
  return prisma.category.create({
    data: {
      title: data.title,
      description: data.description ?? null,
      image: data.image ?? null,
      totalProducts: 0,
    },
  });
}

async function updateCategory(id, data) {
  return prisma.category.update({
    where: { id },
    data: {
      ...(data.title != null && { title: data.title }),
      ...(data.description !== undefined && { description: data.description }),
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
