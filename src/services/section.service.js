/**
 * Sections: admin-created blocks for user panel (e.g. Ramadan Deals).
 * Each section has title (required), optional image, and ordered products + categories.
 * Product/category shape matches how we show products and categories to users elsewhere.
 */
const prisma = require('../config/db');
const productService = require('./product.service');

function mapCategoryForSection(cat) {
  if (!cat || !cat.category) return null;
  const { category } = cat;
  return {
    id: category.id,
    title: category.title,
    description: category.description ?? null,
    image: category.image ?? null,
    totalProducts: category.totalProducts ?? 0,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
}

function mapProductForSection(pr) {
  if (!pr || !pr.product) return null;
  return productService.mapProduct(pr.product);
}

async function getSections() {
  const sections = await prisma.section.findMany({
    orderBy: { sortOrder: 'asc' },
    include: {
      products: {
        orderBy: { sortOrder: 'asc' },
        include: {
          product: {
            include: {
              category: { select: { id: true, title: true } },
              images: { orderBy: { sortOrder: 'asc' } },
              descriptions: { orderBy: { sortOrder: 'asc' } },
              productOptions: { orderBy: { sortOrder: 'asc' } },
            },
          },
        },
      },
      categories: {
        orderBy: { sortOrder: 'asc' },
        include: {
          category: true,
        },
      },
    },
  });

  return sections.map((s) => ({
    id: s.id,
    title: s.title,
    image: s.image ?? null,
    sortOrder: s.sortOrder,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    products: s.products.map(mapProductForSection).filter(Boolean),
    categories: s.categories.map(mapCategoryForSection).filter(Boolean),
  }));
}

async function getSectionById(id) {
  const section = await prisma.section.findUnique({
    where: { id },
    include: {
      products: {
        orderBy: { sortOrder: 'asc' },
        include: {
          product: {
            include: {
              category: { select: { id: true, title: true } },
              images: { orderBy: { sortOrder: 'asc' } },
              descriptions: { orderBy: { sortOrder: 'asc' } },
              productOptions: { orderBy: { sortOrder: 'asc' } },
            },
          },
        },
      },
      categories: {
        orderBy: { sortOrder: 'asc' },
        include: { category: true },
      },
    },
  });
  if (!section) return null;
  return {
    id: section.id,
    title: section.title,
    image: section.image ?? null,
    sortOrder: section.sortOrder,
    createdAt: section.createdAt,
    updatedAt: section.updatedAt,
    products: section.products.map(mapProductForSection).filter(Boolean),
    categories: section.categories.map(mapCategoryForSection).filter(Boolean),
  };
}

async function createSection(data) {
  const title = String(data.title || '').trim();
  if (!title) throw new Error('Section title is required');

  const productIds = Array.isArray(data.productIds) ? data.productIds.filter((id) => id && String(id).trim()) : [];
  const categoryIds = Array.isArray(data.categoryIds) ? data.categoryIds.filter((id) => id && String(id).trim()) : [];

  const maxOrder = await prisma.section.aggregate({ _max: { sortOrder: true } }).then((r) => (r._max.sortOrder ?? -1) + 1);

  const section = await prisma.section.create({
    data: {
      title,
      image: data.image != null ? String(data.image).trim() || null : null,
      sortOrder: data.sortOrder != null ? Number(data.sortOrder) : maxOrder,
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

  return getSectionById(section.id);
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
  if (data.image !== undefined) updatePayload.image = data.image ? String(data.image).trim() : null;
  if (data.sortOrder !== undefined) updatePayload.sortOrder = Number(data.sortOrder);

  if (Object.keys(updatePayload).length > 0) {
    await prisma.section.update({
      where: { id },
      data: updatePayload,
    });
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

  return getSectionById(id);
}

async function deleteSection(id) {
  await prisma.section.delete({ where: { id } });
  return true;
}

module.exports = {
  getSections,
  getSectionById,
  createSection,
  updateSection,
  deleteSection,
};
