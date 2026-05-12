const prisma = require('../config/db');
const { autoTranslate, autoTranslateMany } = require('../utils/bilingual');

const PRODUCT_BILINGUAL = [
  { src: 'title', dst: 'title_ar' },
  { src: 'subtitle', dst: 'subtitle_ar' },
];
const PRODUCT_DESCRIPTION_BILINGUAL = [
  { src: 'title', dst: 'title_ar' },
  { src: 'description', dst: 'description_ar' },
];
const PRODUCT_OPTION_BILINGUAL = [
  { src: 'title', dst: 'title_ar' },
  { src: 'options', dst: 'options_ar', kind: 'arrayOfString' },
];

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
    title_ar: d.title_ar ?? null,
    description: d.description,
    description_ar: d.description_ar ?? null,
  }));
}

function orderedProductOptions(product) {
  const list = product.productOptions && Array.isArray(product.productOptions)
    ? [...product.productOptions].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    : [];
  return list.map((o) => ({
    id: o.id,
    title: o.title,
    title_ar: o.title_ar ?? null,
    options: Array.isArray(o.options) ? o.options : [],
    options_ar: Array.isArray(o.options_ar) ? o.options_ar : [],
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
        title_ar: d.title_ar != null ? String(d.title_ar).trim() || null : null,
        description: text,
        description_ar: d.description_ar != null ? String(d.description_ar).trim() || null : null,
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
      const title_ar = item.title_ar != null ? String(item.title_ar).trim() || null : null;
      const options_ar = Array.isArray(item.options_ar)
        ? item.options_ar.filter((v) => v != null && String(v).trim() !== '').map((v) => String(v).trim())
        : [];
      return { title, title_ar, options, options_ar, sortOrder: i };
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

  // Auto-translate the en/_ar twins before the DB write. We translate the parent product
  // fields and every child description/option in a single batched Azure call so an entire
  // product create costs one round-trip, not N.
  const productDraft = {
    title: data.title ?? null,
    title_ar: data.title_ar ?? null,
    subtitle: data.subtitle ?? null,
    subtitle_ar: data.subtitle_ar ?? null,
  };
  await Promise.all([
    autoTranslate(productDraft, PRODUCT_BILINGUAL),
    autoTranslateMany(descriptionRows, PRODUCT_DESCRIPTION_BILINGUAL),
    autoTranslateMany(productOptionRows, PRODUCT_OPTION_BILINGUAL),
  ]);

  // Wrap product create + category counter bump in a single transaction so a counter-update
  // failure rolls the product create back instead of leaving the cached count drifted.
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        title: productDraft.title,
        title_ar: productDraft.title_ar ?? null,
        subtitle: productDraft.subtitle ?? null,
        subtitle_ar: productDraft.subtitle_ar ?? null,
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
      await tx.category.update({
        where: { id: categoryId },
        data: { totalProducts: { increment: 1 } },
      });
    }
    return product;
  });
}

async function updateProduct(id, data) {
  const existing = await prisma.product.findUnique({
    where: { id },
    include: { images: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!existing) return null;

  const bilingualDraft = {};
  if (data.title !== undefined) bilingualDraft.title = data.title;
  if (data.title_ar !== undefined) bilingualDraft.title_ar = data.title_ar;
  if (data.subtitle !== undefined) bilingualDraft.subtitle = data.subtitle;
  if (data.subtitle_ar !== undefined) bilingualDraft.subtitle_ar = data.subtitle_ar;

  // Normalize children up front so we can translate them BEFORE opening the transaction.
  // Doing network I/O inside $transaction would pin a DB connection for the duration of
  // the Azure call and risks transaction timeouts under load.
  const descriptionRows = data.descriptions !== undefined ? normalizeDescriptions(data.descriptions) : null;
  const productOptionRows = data.productOptions !== undefined ? normalizeProductOptions(data.productOptions) : null;
  await Promise.all([
    autoTranslate(bilingualDraft, PRODUCT_BILINGUAL),
    descriptionRows ? autoTranslateMany(descriptionRows, PRODUCT_DESCRIPTION_BILINGUAL) : Promise.resolve(),
    productOptionRows ? autoTranslateMany(productOptionRows, PRODUCT_OPTION_BILINGUAL) : Promise.resolve(),
  ]);

  const updatePayload = {
    ...(bilingualDraft.title != null && { title: bilingualDraft.title }),
    ...(bilingualDraft.title_ar !== undefined && { title_ar: bilingualDraft.title_ar ?? null }),
    ...(bilingualDraft.subtitle !== undefined && { subtitle: bilingualDraft.subtitle }),
    ...(bilingualDraft.subtitle_ar !== undefined && { subtitle_ar: bilingualDraft.subtitle_ar ?? null }),
    ...(data.price != null && { price: data.price }),
    ...(data.discountedPrice !== undefined && { discountedPrice: data.discountedPrice }),
    ...(data.quantity !== undefined && { quantity: Math.max(0, parseInt(data.quantity, 10) || 0) }),
    ...(data.categoryId !== undefined && { categoryId: data.categoryId || null }),
  };

  // All product mutations + counter rebalances run inside one transaction so a partial
  // failure (e.g. counter update on a deleted target category) rolls everything back.
  await prisma.$transaction(async (tx) => {
    if (data.categoryId !== undefined && data.categoryId !== existing.categoryId) {
      if (existing.categoryId) {
        await tx.category.update({
          where: { id: existing.categoryId },
          data: { totalProducts: { decrement: 1 } },
        });
      }
      if (data.categoryId) {
        await tx.category.update({
          where: { id: data.categoryId },
          data: { totalProducts: { increment: 1 } },
        });
      }
    }

    await tx.product.update({
      where: { id },
      data: updatePayload,
    });

    if (data.images !== undefined) {
      const imageUrls = Array.isArray(data.images)
        ? data.images.filter((u) => typeof u === 'string' && u.trim()).slice(0, MAX_IMAGES)
        : [];
      await tx.productImage.deleteMany({ where: { productId: id } });
      if (imageUrls.length > 0) {
        await tx.productImage.createMany({
          data: imageUrls.map((url, i) => ({
            productId: id,
            url: url.trim(),
            sortOrder: i,
          })),
        });
      }
    }

    if (descriptionRows !== null) {
      await tx.productDescription.deleteMany({ where: { productId: id } });
      if (descriptionRows.length > 0) {
        await tx.productDescription.createMany({
          data: descriptionRows.map((row) => ({ productId: id, ...row })),
        });
      }
    }

    if (productOptionRows !== null) {
      await tx.productOption.deleteMany({ where: { productId: id } });
      if (productOptionRows.length > 0) {
        await tx.productOption.createMany({
          data: productOptionRows.map((row) => ({ productId: id, ...row })),
        });
      }
    }
  });

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
      data: { productTitle: product.title, productTitle_ar: product.title_ar ?? null },
    });
    await tx.product.delete({ where: { id } });
    if (product.categoryId) {
      await tx.category.update({
        where: { id: product.categoryId },
        data: { totalProducts: { decrement: 1 } },
      });
    }
  });

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
