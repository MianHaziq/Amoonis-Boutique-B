const prisma = require('../config/db');
const categoryService = require('./category.service');

const MAX_IMAGES = 10;
const ACTIVE_ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'PROCESSING'];
const decimalToNumber = (v) => (v == null ? null : Number(v));

function orderedImages(product) {
  const list = product.images && Array.isArray(product.images)
    ? [...product.images].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    : [];
  return list.map((img) => ({ url: img.url, sortOrder: img.sortOrder }));
}

function orderedDescriptions(product) {
  const list = product.descriptions && Array.isArray(product.descriptions)
    ? [...product.descriptions].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    : [];
  return list.map((d) => ({
    id: d.id,
    title: d.title ?? null,
    description: d.description,
  }));
}

function orderedProductOptions(product) {
  const list = product.productOptions && Array.isArray(product.productOptions)
    ? [...product.productOptions].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    : [];
  return list.map((o) => ({
    id: o.id,
    title: o.title,
    options: Array.isArray(o.options) ? o.options : [],
  }));
}

function mapProduct(product) {
  if (!product) return null;
  const { price, discountedPrice, images, descriptions, productOptions, ...rest } = product;
  const imagesList = orderedImages(product);
  const descriptionsList = orderedDescriptions(product);
  const productOptionsList = orderedProductOptions(product);
  return {
    ...rest,
    price: decimalToNumber(price),
    discountedPrice: decimalToNumber(discountedPrice),
    images: imagesList.map((i) => i.url),
    image: imagesList[0]?.url ?? null,
    descriptions: descriptionsList,
    productOptions: productOptionsList,
  };
}

function normalizeDescriptions(descriptions) {
  if (!Array.isArray(descriptions)) return [];
  return descriptions
    .map((d, i) => {
      if (d == null || typeof d !== 'object') return null;
      const text = d.description != null ? String(d.description).trim() : '';
      if (!text) return null;
      return {
        title: d.title != null ? String(d.title).trim() || null : null,
        description: text,
        sortOrder: i,
      };
    })
    .filter(Boolean);
}

function normalizeProductOptions(productOptions) {
  if (!Array.isArray(productOptions)) return [];
  return productOptions
    .map((item, i) => {
      if (item == null || typeof item !== 'object') return null;
      const title = item.title != null ? String(item.title).trim() : '';
      if (!title) return null;
      const options = Array.isArray(item.options)
        ? item.options.filter((v) => v != null && String(v).trim() !== '').map((v) => String(v).trim())
        : [];
      return { title, options, sortOrder: i };
    })
    .filter(Boolean);
}

async function createProduct(data) {
  const categoryId = data.categoryId ? String(data.categoryId).trim() || null : null;
  const imageUrls = Array.isArray(data.images)
    ? data.images.filter((u) => typeof u === 'string' && u.trim()).slice(0, MAX_IMAGES)
    : [];
  const descriptionRows = normalizeDescriptions(data.descriptions);

  const quantity = data.quantity != null ? Math.max(0, parseInt(data.quantity, 10) || 0) : 0;
  const productOptionRows = normalizeProductOptions(data.productOptions);

  const product = await prisma.product.create({
    data: {
      title: data.title,
      subtitle: data.subtitle ?? null,
      price: data.price,
      discountedPrice: data.discountedPrice ?? null,
      quantity,
      ...(categoryId ? { categoryId } : {}),
      ...(imageUrls.length > 0
        ? {
            images: {
              create: imageUrls.map((url, i) => ({ url: url.trim(), sortOrder: i })),
            },
          }
        : {}),
      ...(descriptionRows.length > 0
        ? {
            descriptions: {
              create: descriptionRows,
            },
          }
        : {}),
      ...(productOptionRows.length > 0
        ? {
            productOptions: {
              create: productOptionRows,
            },
          }
        : {}),
    },
    include: {
      category: { select: { id: true, title: true } },
      images: { orderBy: { sortOrder: 'asc' } },
      descriptions: { orderBy: { sortOrder: 'asc' } },
      productOptions: { orderBy: { sortOrder: 'asc' } },
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
    ...(data.price != null && { price: data.price }),
    ...(data.discountedPrice !== undefined && { discountedPrice: data.discountedPrice }),
    ...(data.quantity !== undefined && { quantity: Math.max(0, parseInt(data.quantity, 10) || 0) }),
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

  if (data.descriptions !== undefined) {
    await prisma.productDescription.deleteMany({ where: { productId: id } });
    const descriptionRows = normalizeDescriptions(data.descriptions);
    if (descriptionRows.length > 0) {
      await prisma.productDescription.createMany({
        data: descriptionRows.map((row) => ({ productId: id, ...row })),
      });
    }
  }

  if (data.productOptions !== undefined) {
    await prisma.productOption.deleteMany({ where: { productId: id } });
    const productOptionRows = normalizeProductOptions(data.productOptions);
    if (productOptionRows.length > 0) {
      await prisma.productOption.createMany({
        data: productOptionRows.map((row) => ({ productId: id, ...row })),
      });
    }
  }

  return prisma.product.findUnique({
    where: { id },
    include: {
      category: { select: { id: true, title: true } },
      images: { orderBy: { sortOrder: 'asc' } },
      descriptions: { orderBy: { sortOrder: 'asc' } },
      productOptions: { orderBy: { sortOrder: 'asc' } },
    },
  });
}

async function deleteProduct(id) {
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) return null;

  const activeOrderCount = await prisma.orderItem.count({
    where: {
      productId: id,
      order: { status: { in: ACTIVE_ORDER_STATUSES } },
    },
  });
  if (activeOrderCount > 0) {
    const err = new Error('Cannot delete product with active orders');
    err.code = 'PRODUCT_HAS_ACTIVE_ORDERS';
    err.activeOrderCount = activeOrderCount;
    throw err;
  }

  await prisma.$transaction(async (tx) => {
    // Snapshot title onto historical order items so they stay readable after the product is gone.
    await tx.orderItem.updateMany({
      where: { productId: id, productTitle: null },
      data: { productTitle: product.title },
    });
    await tx.product.delete({ where: { id } });
  });

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
        descriptions: { orderBy: { sortOrder: 'asc' } },
        productOptions: { orderBy: { sortOrder: 'asc' } },
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
      descriptions: { orderBy: { sortOrder: 'asc' } },
      productOptions: { orderBy: { sortOrder: 'asc' } },
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
