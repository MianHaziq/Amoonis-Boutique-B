const prisma = require('../config/db');
const categoryService = require('./category.service');

const MAX_IMAGES = 10;
const decimalToNumber = (v) => (v == null ? null : Number(v));

function orderedImages(product) {
  const list = product.images && Array.isArray(product.images)
    ? [...product.images].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    : [];
  return list.map((img) => ({ url: img.url, sortOrder: img.sortOrder }));
}

function mapProduct(product) {
  if (!product) return null;
  const { price, discountedPrice, images, ...rest } = product;
  const imagesList = orderedImages(product);
  return {
    ...rest,
    price: decimalToNumber(price),
    discountedPrice: decimalToNumber(discountedPrice),
    images: imagesList.map((i) => i.url),
    image: imagesList[0]?.url ?? null,
  };
}

async function createProduct(data) {
  const categoryId = data.categoryId ? String(data.categoryId).trim() || null : null;
  const imageUrls = Array.isArray(data.images)
    ? data.images.filter((u) => typeof u === 'string' && u.trim()).slice(0, MAX_IMAGES)
    : [];

  const product = await prisma.product.create({
    data: {
      title: data.title,
      subtitle: data.subtitle ?? null,
      description: data.description ?? null,
      price: data.price,
      discountedPrice: data.discountedPrice ?? null,
      ...(categoryId ? { categoryId } : {}),
      ...(imageUrls.length > 0
        ? {
            images: {
              create: imageUrls.map((url, i) => ({ url: url.trim(), sortOrder: i })),
            },
          }
        : {}),
    },
    include: {
      category: { select: { id: true, title: true } },
      images: { orderBy: { sortOrder: 'asc' } },
    },
  });
  if (categoryId) {
    await categoryService.incrementCategoryProductCount(categoryId);
  }
  return product;
}

async function updateProduct(id, data) {
  const existing = await prisma.product.findUnique({
    where: { id },
    include: { images: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!existing) return null;

  const updatePayload = {
    ...(data.title != null && { title: data.title }),
    ...(data.subtitle !== undefined && { subtitle: data.subtitle }),
    ...(data.description !== undefined && { description: data.description }),
    ...(data.price != null && { price: data.price }),
    ...(data.discountedPrice !== undefined && { discountedPrice: data.discountedPrice }),
    ...(data.categoryId !== undefined && { categoryId: data.categoryId || null }),
  };

  if (data.categoryId !== undefined && data.categoryId !== existing.categoryId) {
    if (existing.categoryId) {
      await categoryService.decrementCategoryProductCount(existing.categoryId);
    }
    if (data.categoryId) {
      await categoryService.incrementCategoryProductCount(data.categoryId);
    }
  }

  await prisma.product.update({
    where: { id },
    data: updatePayload,
  });

  if (data.images !== undefined) {
    const imageUrls = Array.isArray(data.images)
      ? data.images.filter((u) => typeof u === 'string' && u.trim()).slice(0, MAX_IMAGES)
      : [];
    await prisma.productImage.deleteMany({ where: { productId: id } });
    if (imageUrls.length > 0) {
      await prisma.productImage.createMany({
        data: imageUrls.map((url, i) => ({
          productId: id,
          url: url.trim(),
          sortOrder: i,
        })),
      });
    }
  }

  return prisma.product.findUnique({
    where: { id },
    include: {
      category: { select: { id: true, title: true } },
      images: { orderBy: { sortOrder: 'asc' } },
    },
  });
}

async function deleteProduct(id) {
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) return null;
  await prisma.product.delete({ where: { id } });
  if (product.categoryId) {
    await categoryService.decrementCategoryProductCount(product.categoryId);
  }
  return product;
}

async function getAllProducts(page = 1, limit = 10, categoryId = null) {
  const skip = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, limit));
  const take = Math.min(100, Math.max(1, limit));
  const where = categoryId ? { categoryId } : {};

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        category: { select: { id: true, title: true } },
        images: { orderBy: { sortOrder: 'asc' } },
      },
    }),
    prisma.product.count({ where }),
  ]);

  return {
    items: items.map(mapProduct),
    total,
    page: Math.max(1, page),
    limit: take,
    totalPages: Math.ceil(total / take),
  };
}

async function getProductsByCategory(categoryId, page = 1, limit = 10) {
  return getAllProducts(page, limit, categoryId);
}

async function getProductById(id) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      category: { select: { id: true, title: true } },
      images: { orderBy: { sortOrder: 'asc' } },
    },
  });
  return product ? mapProduct(product) : null;
}

module.exports = {
  createProduct,
  updateProduct,
  deleteProduct,
  getAllProducts,
  getProductsByCategory,
  getProductById,
  mapProduct,
  decimalToNumber,
};
