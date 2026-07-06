const prisma = require('../config/db');
const { autoTranslate, autoTranslateMany, fillBilingualGapsFromTwin } = require('../utils/bilingual');
const regionService = require('./region.service');
const { buildVisibilityWhere } = require('../utils/regionVisibility');

// Standard include for region join rows on a product read (staff/admin only).
const REGION_INCLUDE = {
  regions: { include: { region: { select: { id: true, code: true, name: true, name_ar: true } } } },
};

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

// NOT NULL constraints in the schema — must be filled at write time.
const PRODUCT_REQUIRED_PAIRS = [{ src: 'title', dst: 'title_ar' }];
const PRODUCT_DESCRIPTION_REQUIRED_PAIRS = [{ src: 'description', dst: 'description_ar' }];
const PRODUCT_OPTION_REQUIRED_PAIRS = [{ src: 'title', dst: 'title_ar' }];

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
    // Additive: per-value image URLs (aligned with `options`). Older clients
    // that don't read this field are unaffected.
    optionImages: Array.isArray(o.optionImages) ? o.optionImages : [],
  }));
}

function mapProduct(product) {
  if (!product) return null;
  const { price, discountedPrice, images, descriptions, productOptions, regions, ...rest } = product;
  const imagesList = orderedImages(product);
  const descriptionsList = orderedDescriptions(product);
  const productOptionsList = orderedProductOptions(product);
  const out = {
    ...rest,
    price: decimalToNumber(price),
    discountedPrice: decimalToNumber(discountedPrice),
    images: imagesList.map((i) => i.url),
    image: imagesList[0]?.url ?? null,
    descriptions: descriptionsList,
    productOptions: productOptionsList,
  };
  // Region tags are only loaded (and only needed) for staff/admin reads. Storefront
  // responses omit them — the app already filtered by region and doesn't need the tags.
  if (Array.isArray(regions)) {
    const regionList = regions.map((r) => r.region).filter(Boolean);
    out.regions = regionList;
    out.regionIds = regionList.map((r) => r.id);
  }
  return out;
}

function normalizeDescriptions(descriptions) {
  if (!Array.isArray(descriptions)) return [];
  return descriptions
    .map((d, i) => {
      if (d == null || typeof d !== 'object') return null;
      const descEn = d.description != null ? String(d.description).trim() : '';
      const descAr = d.description_ar != null ? String(d.description_ar).trim() : '';
      // At least one side of description must be filled (validator enforces this too,
      // but double-check here so the service is safe when called from non-HTTP paths).
      if (!descEn && !descAr) return null;
      return {
        title: d.title != null ? String(d.title).trim() || null : null,
        title_ar: d.title_ar != null ? String(d.title_ar).trim() || null : null,
        description: descEn || null,
        description_ar: descAr || null,
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
      const titleEn = item.title != null ? String(item.title).trim() : '';
      const titleAr = item.title_ar != null ? String(item.title_ar).trim() : '';
      // At least one side of title must be filled.
      if (!titleEn && !titleAr) return null;
      const options = Array.isArray(item.options)
        ? item.options.filter((v) => v != null && String(v).trim() !== '').map((v) => String(v).trim())
        : [];
      const options_ar = Array.isArray(item.options_ar)
        ? item.options_ar.filter((v) => v != null && String(v).trim() !== '').map((v) => String(v).trim())
        : [];
      // Optional per-value images, aligned by index with `options`. We keep the
      // full array (including "" gaps) so index alignment with options holds.
      const optionImages = Array.isArray(item.optionImages)
        ? item.optionImages.map((v) => (v == null ? '' : String(v).trim())).slice(0, options.length)
        : [];
      return {
        title: titleEn || null,
        title_ar: titleAr || null,
        options,
        options_ar,
        optionImages,
        sortOrder: i,
      };
    })
    .filter(Boolean);
}

// Normalize a publish status from admin input; defaults to DRAFT.
function normalizeStatus(value, fallback = 'DRAFT') {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toUpperCase();
  return v === 'PUBLISHED' ? 'PUBLISHED' : v === 'DRAFT' ? 'DRAFT' : fallback;
}

/**
 * Resolve the region ids to attach to a piece of content at write time.
 * - explicit non-empty list  -> validated against existing regions
 * - omitted / empty          -> default region (matches "default UAE")
 * Throws REGION_NOT_FOUND for unknown ids.
 */
async function resolveWriteRegionIds(regionIds) {
  if (Array.isArray(regionIds) && regionIds.length > 0) {
    return regionService.assertValidRegionIds(regionIds);
  }
  const def = await regionService.getDefaultRegion();
  return def ? [def.id] : [];
}

async function createProduct(data) {
  const categoryId = data.categoryId ? String(data.categoryId).trim() || null : null;
  const status = normalizeStatus(data.status);
  // CAT-2: a discount must never exceed the base price (guard here too, not only in the
  // route validator, so non-HTTP callers can't create an inverted price).
  if (data.discountedPrice != null && data.price != null && Number(data.discountedPrice) > Number(data.price)) {
    const err = new Error('discountedPrice cannot exceed price');
    err.code = 'INVALID_PRICE';
    throw err;
  }
  const regionIds = await resolveWriteRegionIds(data.regionIds);
  const imageUrls = Array.isArray(data.images)
    ? data.images.filter((u) => typeof u === 'string' && u.trim()).slice(0, MAX_IMAGES)
    : [];
  const descriptionRows = normalizeDescriptions(data.descriptions);

  const quantity = data.quantity != null ? Math.max(0, parseInt(data.quantity, 10) || 0) : 0;
  const productOptionRows = normalizeProductOptions(data.productOptions);

  // Auto-translate the en/_ar twins before the DB write. We translate the parent product
  // fields and every child description/option in a single batched call so an entire
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

  // If translation failed for any required column, copy the populated side across so
  // the Prisma write doesn't trip NOT NULL. Admin can re-save later for a real translation.
  fillBilingualGapsFromTwin(productDraft, PRODUCT_REQUIRED_PAIRS);
  for (const row of descriptionRows) fillBilingualGapsFromTwin(row, PRODUCT_DESCRIPTION_REQUIRED_PAIRS);
  for (const row of productOptionRows) fillBilingualGapsFromTwin(row, PRODUCT_OPTION_REQUIRED_PAIRS);

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
        status,
        ...(regionIds.length > 0
          ? { regions: { create: regionIds.map((regionId) => ({ regionId })) } }
          : {}),
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
        ...REGION_INCLUDE,
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

  // CAT-3: optimistic concurrency. When the caller passes the updatedAt it last read,
  // reject the write if the row changed since (concurrent edit, or stock moved under it)
  // rather than silently clobbering. Enforced again inside the transaction below.
  let expectedUpdatedAtMs = null;
  if (data.expectedUpdatedAt != null) {
    const ms = new Date(data.expectedUpdatedAt).getTime();
    if (!Number.isNaN(ms)) {
      expectedUpdatedAtMs = ms;
      if (ms !== new Date(existing.updatedAt).getTime()) {
        const err = new Error('This product was changed by someone else. Reload and try again.');
        err.code = 'STALE_WRITE';
        throw err;
      }
    }
  }

  // CAT-2: discount can't exceed the base price — compare against the incoming price, or
  // the EXISTING price when this partial update doesn't touch price.
  if (data.discountedPrice != null) {
    const basePrice = data.price != null ? Number(data.price) : Number(existing.price);
    if (Number(data.discountedPrice) > basePrice) {
      const err = new Error('discountedPrice cannot exceed price');
      err.code = 'INVALID_PRICE';
      throw err;
    }
  }

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

  // Region links are replaced wholesale when `regionIds` is sent. Validate before
  // opening the transaction so an unknown id fails fast without a partial write.
  const newRegionIds = data.regionIds !== undefined
    ? await regionService.assertValidRegionIds(Array.isArray(data.regionIds) ? data.regionIds : [])
    : null;

  await Promise.all([
    autoTranslate(bilingualDraft, PRODUCT_BILINGUAL),
    descriptionRows ? autoTranslateMany(descriptionRows, PRODUCT_DESCRIPTION_BILINGUAL) : Promise.resolve(),
    productOptionRows ? autoTranslateMany(productOptionRows, PRODUCT_OPTION_BILINGUAL) : Promise.resolve(),
  ]);

  // Child rows are fully replaced (delete + createMany) on update, so the NOT NULL columns
  // must be satisfied — copy across from the twin if translation didn't fill them.
  // The parent bilingualDraft is intentionally NOT gap-filled on update: leaving a side
  // undefined makes Prisma skip that column, preserving the existing DB value.
  if (descriptionRows) {
    for (const row of descriptionRows) fillBilingualGapsFromTwin(row, PRODUCT_DESCRIPTION_REQUIRED_PAIRS);
  }
  if (productOptionRows) {
    for (const row of productOptionRows) fillBilingualGapsFromTwin(row, PRODUCT_OPTION_REQUIRED_PAIRS);
  }

  const updatePayload = {
    ...(bilingualDraft.title != null && { title: bilingualDraft.title }),
    ...(bilingualDraft.title_ar !== undefined && { title_ar: bilingualDraft.title_ar ?? null }),
    ...(bilingualDraft.subtitle !== undefined && { subtitle: bilingualDraft.subtitle }),
    ...(bilingualDraft.subtitle_ar !== undefined && { subtitle_ar: bilingualDraft.subtitle_ar ?? null }),
    ...(data.price != null && { price: data.price }),
    ...(data.discountedPrice !== undefined && { discountedPrice: data.discountedPrice }),
    ...(data.quantity !== undefined && { quantity: Math.max(0, parseInt(data.quantity, 10) || 0) }),
    ...(data.categoryId !== undefined && { categoryId: data.categoryId || null }),
    ...(data.status !== undefined && { status: normalizeStatus(data.status, existing.status) }),
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

    if (expectedUpdatedAtMs != null) {
      // CAT-3: conditional write closes the read→write race — only succeeds if the row's
      // updatedAt still matches what the caller saw. 0 rows ⇒ someone else won; abort.
      const res = await tx.product.updateMany({
        where: { id, updatedAt: new Date(expectedUpdatedAtMs) },
        data: updatePayload,
      });
      if (res.count === 0) {
        const err = new Error('This product was changed by someone else. Reload and try again.');
        err.code = 'STALE_WRITE';
        throw err;
      }
    } else {
      await tx.product.update({
        where: { id },
        data: updatePayload,
      });
    }

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

    if (newRegionIds !== null) {
      await tx.productRegion.deleteMany({ where: { productId: id } });
      if (newRegionIds.length > 0) {
        await tx.productRegion.createMany({
          data: newRegionIds.map((regionId) => ({ productId: id, regionId })),
          skipDuplicates: true,
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
      ...REGION_INCLUDE,
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

/**
 * Reorder products by assigning explicit sortOrder values (admin drag-and-drop).
 * Accepts an array of { id, sortOrder }. Because the admin list is paginated, the
 * caller sends absolute positions (base = page offset + row index) so ordering
 * stays globally consistent across pages. Runs in a single transaction.
 * @param {{ id: string, sortOrder: number }[]} items
 */
async function reorderProducts(items) {
  const clean = (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it.id === 'string' && Number.isInteger(it.sortOrder))
    .map((it) => ({ id: it.id, sortOrder: it.sortOrder }));
  if (clean.length === 0) return { count: 0 };

  await prisma.$transaction(
    clean.map((it) =>
      prisma.product.update({ where: { id: it.id }, data: { sortOrder: it.sortOrder } })
    )
  );
  return { count: clean.length };
}

// CAT-6: cap how deep a client can page so ?page=99999999 can't force a giant OFFSET
// scan on this public endpoint. 10k pages × 100/page covers any real catalog.
const MAX_PAGE = 10000;

async function getAllProducts(page = 1, limit = 10, categoryId = null, visibility = {}) {
  const safePage = Math.min(MAX_PAGE, Math.max(1, page));
  const take = Math.min(100, Math.max(1, limit));
  const skip = (safePage - 1) * take;
  const where = {
    ...buildVisibilityWhere(visibility),
    ...(categoryId ? { categoryId } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip,
      take,
      // Admin-controlled display order first (drag-and-drop sets sortOrder), then
      // newest. All products default to sortOrder 0, so the effective order is
      // unchanged until an admin explicitly reorders.
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      include: {
        category: { select: { id: true, title: true } },
        images: { orderBy: { sortOrder: 'asc' } },
        descriptions: { orderBy: { sortOrder: 'asc' } },
        productOptions: { orderBy: { sortOrder: 'asc' } },
        ...(visibility.isStaff ? REGION_INCLUDE : {}),
      },
    }),
    prisma.product.count({ where }),
  ]);

  return {
    items: items.map(mapProduct),
    total,
    page: safePage,
    limit: take,
    totalPages: Math.ceil(total / take),
  };
}

async function getProductsByCategory(categoryId, page = 1, limit = 10, visibility = {}) {
  return getAllProducts(page, limit, categoryId, visibility);
}

// Cap the search term length so a pathological 10k-char query can't build a huge
// ILIKE pattern. Anything past this can't add meaningful signal for a catalog search.
const MAX_SEARCH_LEN = 100;

/**
 * Full-text-ish product search across the bilingual title/subtitle columns and the
 * product's category name. Backed by pg_trgm GIN indexes (see the
 * 20260702000000_product_search_trgm migration) so the case-insensitive substring
 * match is served from an index instead of a sequential scan.
 *
 * Visibility is applied through the same buildVisibilityWhere() used everywhere else,
 * so storefront callers only ever match PUBLISHED products in their region and staff
 * see everything (optionally narrowed by their admin filters).
 *
 * Results are ordered by recency (createdAt desc) — the standard catalog order — after
 * the index narrows the set to matches. Returns the same paginated shape as the list
 * endpoints, plus the normalized query echoed back.
 */
async function searchProducts(rawQuery, page = 1, limit = 10, visibility = {}) {
  const q = String(rawQuery ?? '').trim().slice(0, MAX_SEARCH_LEN);
  const safePage = Math.min(MAX_PAGE, Math.max(1, page));
  const take = Math.min(100, Math.max(1, limit));
  const skip = (safePage - 1) * take;

  // Empty query → no results (rather than "everything"), so an accidental blank
  // search doesn't dump the whole catalog through the search path.
  if (!q) {
    return { items: [], total: 0, page: safePage, limit: take, totalPages: 0, query: q };
  }

  const contains = { contains: q, mode: 'insensitive' };
  const where = {
    ...buildVisibilityWhere(visibility),
    OR: [
      { title: contains },
      { title_ar: contains },
      { subtitle: contains },
      { subtitle_ar: contains },
      { category: { is: { title: contains } } },
      { category: { is: { title_ar: contains } } },
    ],
  };

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
        ...(visibility.isStaff ? REGION_INCLUDE : {}),
      },
    }),
    prisma.product.count({ where }),
  ]);

  return {
    items: items.map(mapProduct),
    total,
    page: safePage,
    limit: take,
    totalPages: Math.ceil(total / take),
    query: q,
  };
}

async function getProductById(id, visibility = {}) {
  const product = await prisma.product.findFirst({
    where: { id, ...buildVisibilityWhere(visibility) },
    include: {
      category: { select: { id: true, title: true } },
      images: { orderBy: { sortOrder: 'asc' } },
      descriptions: { orderBy: { sortOrder: 'asc' } },
      productOptions: { orderBy: { sortOrder: 'asc' } },
      ...(visibility.isStaff ? REGION_INCLUDE : {}),
    },
  });
  return product ? mapProduct(product) : null;
}

module.exports = {
  createProduct,
  updateProduct,
  deleteProduct,
  reorderProducts,
  getAllProducts,
  getProductsByCategory,
  searchProducts,
  getProductById,
  mapProduct,
  decimalToNumber,
};
