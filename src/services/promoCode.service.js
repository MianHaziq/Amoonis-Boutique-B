const prisma = require('../config/db');

const DISCOUNT_TYPES = ['PERCENTAGE', 'FIXED'];
const APPLIES_TO_VALUES = ['ALL_PRODUCTS', 'SPECIFIC_PRODUCTS', 'SPECIFIC_CATEGORIES'];

function decimalToNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (typeof value.toNumber === 'function') return value.toNumber();
  return Number(value);
}

function normalizeCode(input) {
  return String(input ?? '').trim().toUpperCase();
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function mapPromoCode(promo, { includeInternal = true } = {}) {
  if (!promo) return null;
  const {
    discountValue,
    maxDiscountAmount,
    minOrderAmount,
    maxOrderAmount,
    products,
    categories,
    _count,
    ...rest
  } = promo;

  const productList = Array.isArray(products)
    ? products.map((p) => ({
        id: p.product?.id ?? p.productId,
        title: p.product?.title,
      }))
    : undefined;
  const categoryList = Array.isArray(categories)
    ? categories.map((c) => ({
        id: c.category?.id ?? c.categoryId,
        title: c.category?.title,
      }))
    : undefined;

  const payload = {
    ...rest,
    discountValue: decimalToNumber(discountValue),
    maxDiscountAmount: decimalToNumber(maxDiscountAmount),
    minOrderAmount: decimalToNumber(minOrderAmount),
    maxOrderAmount: decimalToNumber(maxOrderAmount),
  };

  if (productList !== undefined) payload.products = productList;
  if (categoryList !== undefined) payload.categories = categoryList;
  if (_count) {
    payload.totalUses = _count.usages ?? payload.usageCount;
    if (productList === undefined && _count.products != null) {
      payload.productCount = _count.products;
    }
    if (categoryList === undefined && _count.categories != null) {
      payload.categoryCount = _count.categories;
    }
  }

  if (!includeInternal) {
    delete payload.usageCount;
    delete payload.usageLimit;
    delete payload.usageLimitPerUser;
    delete payload.totalUses;
    delete payload.createdAt;
    delete payload.updatedAt;
  }

  return payload;
}

function buildPromoCodeData(data, { isUpdate = false } = {}) {
  const out = {};

  if (data.code !== undefined) out.code = normalizeCode(data.code);
  if (data.name !== undefined) out.name = String(data.name).trim();
  if (data.description !== undefined) {
    out.description = data.description === null ? null : String(data.description).trim() || null;
  }

  if (data.discountType !== undefined) {
    const type = String(data.discountType).trim().toUpperCase();
    if (!DISCOUNT_TYPES.includes(type)) {
      const err = new Error('Invalid discountType. Use PERCENTAGE or FIXED.');
      err.code = 'PROMO_INVALID_INPUT';
      throw err;
    }
    out.discountType = type;
  }

  if (data.discountValue !== undefined) {
    const v = Number(data.discountValue);
    if (!Number.isFinite(v) || v <= 0) {
      const err = new Error('discountValue must be a positive number');
      err.code = 'PROMO_INVALID_INPUT';
      throw err;
    }
    out.discountValue = v;
  }

  if (data.maxDiscountAmount !== undefined) {
    out.maxDiscountAmount = data.maxDiscountAmount === null ? null : Number(data.maxDiscountAmount);
  }

  if (data.appliesTo !== undefined) {
    const at = String(data.appliesTo).trim().toUpperCase();
    if (!APPLIES_TO_VALUES.includes(at)) {
      const err = new Error('Invalid appliesTo. Use ALL_PRODUCTS, SPECIFIC_PRODUCTS, or SPECIFIC_CATEGORIES.');
      err.code = 'PROMO_INVALID_INPUT';
      throw err;
    }
    out.appliesTo = at;
  }

  if (data.minOrderAmount !== undefined) {
    out.minOrderAmount = data.minOrderAmount === null ? null : Number(data.minOrderAmount);
  }
  if (data.maxOrderAmount !== undefined) {
    out.maxOrderAmount = data.maxOrderAmount === null ? null : Number(data.maxOrderAmount);
  }

  if (data.startsAt !== undefined) {
    out.startsAt = data.startsAt === null ? null : new Date(data.startsAt);
  }
  if (data.expiresAt !== undefined) {
    out.expiresAt = data.expiresAt === null ? null : new Date(data.expiresAt);
  }

  if (data.usageLimit !== undefined) {
    out.usageLimit = data.usageLimit === null ? null : Math.floor(Number(data.usageLimit));
  }
  if (data.usageLimitPerUser !== undefined) {
    out.usageLimitPerUser = data.usageLimitPerUser === null ? null : Math.floor(Number(data.usageLimitPerUser));
  }

  if (data.isActive !== undefined) out.isActive = Boolean(data.isActive);

  if (!isUpdate) {
    if (!out.code) throw Object.assign(new Error('code is required'), { code: 'PROMO_INVALID_INPUT' });
    if (!out.name) throw Object.assign(new Error('name is required'), { code: 'PROMO_INVALID_INPUT' });
    if (!out.discountType) throw Object.assign(new Error('discountType is required'), { code: 'PROMO_INVALID_INPUT' });
    if (out.discountValue === undefined) throw Object.assign(new Error('discountValue is required'), { code: 'PROMO_INVALID_INPUT' });
  }

  if (out.discountType === 'PERCENTAGE' && out.discountValue !== undefined && out.discountValue > 100) {
    throw Object.assign(new Error('Percentage discount cannot exceed 100'), { code: 'PROMO_INVALID_INPUT' });
  }

  if (
    out.startsAt != null &&
    out.expiresAt != null &&
    out.expiresAt.getTime() <= out.startsAt.getTime()
  ) {
    throw Object.assign(new Error('expiresAt must be after startsAt'), { code: 'PROMO_INVALID_INPUT' });
  }

  if (
    out.minOrderAmount != null &&
    out.maxOrderAmount != null &&
    Number(out.maxOrderAmount) < Number(out.minOrderAmount)
  ) {
    throw Object.assign(new Error('maxOrderAmount must be >= minOrderAmount'), { code: 'PROMO_INVALID_INPUT' });
  }

  return out;
}

// Full shape — used for create / update / getById so admins see linked products & categories.
const DETAIL_INCLUDE = {
  products: { include: { product: { select: { id: true, title: true } } } },
  categories: { include: { category: { select: { id: true, title: true } } } },
  _count: { select: { usages: true, products: true, categories: true } },
};

// Lean shape — used for paginated list. Avoids hauling dozens of join rows per promo
// when appliesTo = SPECIFIC_PRODUCTS covers many SKUs. Counts stay cheap for admin UX.
const LIST_INCLUDE = {
  _count: { select: { usages: true, products: true, categories: true } },
};

async function createPromoCode(data) {
  const base = buildPromoCodeData(data, { isUpdate: false });
  const productIds = Array.isArray(data.productIds) ? [...new Set(data.productIds.filter(Boolean))] : [];
  const categoryIds = Array.isArray(data.categoryIds) ? [...new Set(data.categoryIds.filter(Boolean))] : [];

  if (base.appliesTo === 'SPECIFIC_PRODUCTS' && productIds.length === 0) {
    throw Object.assign(new Error('productIds is required when appliesTo = SPECIFIC_PRODUCTS'), {
      code: 'PROMO_INVALID_INPUT',
    });
  }
  if (base.appliesTo === 'SPECIFIC_CATEGORIES' && categoryIds.length === 0) {
    throw Object.assign(new Error('categoryIds is required when appliesTo = SPECIFIC_CATEGORIES'), {
      code: 'PROMO_INVALID_INPUT',
    });
  }

  return prisma.promoCode.create({
    data: {
      ...base,
      ...(base.appliesTo === 'SPECIFIC_PRODUCTS' && productIds.length > 0
        ? { products: { create: productIds.map((productId) => ({ productId })) } }
        : {}),
      ...(base.appliesTo === 'SPECIFIC_CATEGORIES' && categoryIds.length > 0
        ? { categories: { create: categoryIds.map((categoryId) => ({ categoryId })) } }
        : {}),
    },
    include: DETAIL_INCLUDE,
  });
}

async function updatePromoCode(id, data) {
  const existing = await prisma.promoCode.findUnique({ where: { id } });
  if (!existing) {
    const err = new Error('Promo code not found');
    err.code = 'P2025';
    throw err;
  }

  const base = buildPromoCodeData(data, { isUpdate: true });

  const effectiveAppliesTo = base.appliesTo ?? existing.appliesTo;
  const productIdsProvided = Array.isArray(data.productIds);
  const categoryIdsProvided = Array.isArray(data.categoryIds);
  const productIds = productIdsProvided ? [...new Set(data.productIds.filter(Boolean))] : null;
  const categoryIds = categoryIdsProvided ? [...new Set(data.categoryIds.filter(Boolean))] : null;

  await prisma.$transaction(async (tx) => {
    await tx.promoCode.update({ where: { id }, data: base });

    // Replace product links when changing scope to SPECIFIC_PRODUCTS or productIds provided
    if (effectiveAppliesTo === 'SPECIFIC_PRODUCTS') {
      if (productIdsProvided || base.appliesTo === 'SPECIFIC_PRODUCTS') {
        await tx.promoCodeProduct.deleteMany({ where: { promoCodeId: id } });
        const ids = productIds ?? [];
        if (ids.length > 0) {
          await tx.promoCodeProduct.createMany({
            data: ids.map((productId) => ({ promoCodeId: id, productId })),
            skipDuplicates: true,
          });
        }
      }
    } else if (base.appliesTo && base.appliesTo !== 'SPECIFIC_PRODUCTS') {
      // Scope changed away from SPECIFIC_PRODUCTS — clear links
      await tx.promoCodeProduct.deleteMany({ where: { promoCodeId: id } });
    }

    if (effectiveAppliesTo === 'SPECIFIC_CATEGORIES') {
      if (categoryIdsProvided || base.appliesTo === 'SPECIFIC_CATEGORIES') {
        await tx.promoCodeCategory.deleteMany({ where: { promoCodeId: id } });
        const ids = categoryIds ?? [];
        if (ids.length > 0) {
          await tx.promoCodeCategory.createMany({
            data: ids.map((categoryId) => ({ promoCodeId: id, categoryId })),
            skipDuplicates: true,
          });
        }
      }
    } else if (base.appliesTo && base.appliesTo !== 'SPECIFIC_CATEGORIES') {
      await tx.promoCodeCategory.deleteMany({ where: { promoCodeId: id } });
    }
  });

  return prisma.promoCode.findUnique({ where: { id }, include: DETAIL_INCLUDE });
}

async function deletePromoCode(id) {
  return prisma.promoCode.delete({ where: { id } });
}

async function getPromoCodeById(id) {
  return prisma.promoCode.findUnique({ where: { id }, include: DETAIL_INCLUDE });
}

async function listPromoCodes({ page = 1, limit = 10, search = null, status = null } = {}) {
  const take = Math.min(100, Math.max(1, Number(limit) || 10));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;

  const where = {};
  if (search && String(search).trim()) {
    const q = String(search).trim();
    where.OR = [
      { code: { contains: q, mode: 'insensitive' } },
      { name: { contains: q, mode: 'insensitive' } },
    ];
  }
  const now = new Date();
  if (status === 'active') {
    where.isActive = true;
    where.AND = [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    ];
  } else if (status === 'expired') {
    where.expiresAt = { not: null, lte: now };
  } else if (status === 'scheduled') {
    where.startsAt = { gt: now };
  } else if (status === 'inactive') {
    where.isActive = false;
  }

  const [items, total] = await Promise.all([
    prisma.promoCode.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: LIST_INCLUDE,
    }),
    prisma.promoCode.count({ where }),
  ]);

  return {
    items,
    total,
    page: Math.max(1, Number(page) || 1),
    limit: take,
    totalPages: Math.ceil(total / take) || 1,
  };
}

/**
 * User-facing list: only shows codes currently usable (active + within window) and hides
 * internal usage counters. Per-user remaining uses can be computed separately if needed.
 */
async function listAvailablePromoCodes({ page = 1, limit = 20, userId = null } = {}) {
  const take = Math.min(50, Math.max(1, Number(limit) || 20));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;
  const now = new Date();

  const where = {
    isActive: true,
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    ],
  };

  const [items, total] = await Promise.all([
    prisma.promoCode.findMany({
      where,
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'desc' }],
      skip,
      take,
      include: {
        products: { include: { product: { select: { id: true, title: true } } } },
        categories: { include: { category: { select: { id: true, title: true } } } },
      },
    }),
    prisma.promoCode.count({ where }),
  ]);

  // Drop fully-used codes (global usageLimit reached)
  const visible = items.filter(
    (p) => p.usageLimit == null || p.usageCount < p.usageLimit,
  );

  let perUserCounts = new Map();
  if (userId) {
    const rows = await prisma.promoCodeUsage.groupBy({
      by: ['promoCodeId'],
      where: { userId, promoCodeId: { in: visible.map((v) => v.id) } },
      _count: { _all: true },
    });
    perUserCounts = new Map(rows.map((r) => [r.promoCodeId, r._count._all]));
  }

  // Filter out codes the user has already hit their per-user cap on
  const filtered = visible.filter((p) => {
    if (p.usageLimitPerUser == null) return true;
    const used = perUserCounts.get(p.id) ?? 0;
    return used < p.usageLimitPerUser;
  });

  return {
    items: filtered.map((p) => mapPromoCode(p, { includeInternal: false })),
    total,
    page: Math.max(1, Number(page) || 1),
    limit: take,
    totalPages: Math.ceil(total / take) || 1,
  };
}

// ---------- Validation / discount calculation ----------

async function getUsageCountForUser(promoCodeId, userId) {
  return prisma.promoCodeUsage.count({ where: { promoCodeId, userId } });
}

/**
 * Compute the discount for a given promo code against a cart-like payload without writing
 * anything. Throws a tagged error when the code is not usable.
 *
 * @param {string} code     The raw user-entered code
 * @param {string} userId   Authenticated user id
 * @param {Array<{productId:string, quantity:number, price:number, categoryId?:string|null}>} items
 */
async function validateAndCalculate(code, userId, items) {
  const normalized = normalizeCode(code);
  if (!normalized) {
    throw Object.assign(new Error('Promo code is required'), { code: 'PROMO_INVALID_INPUT' });
  }

  const promo = await prisma.promoCode.findUnique({
    where: { code: normalized },
    include: {
      products: { select: { productId: true } },
      categories: { select: { categoryId: true } },
    },
  });
  if (!promo) {
    throw Object.assign(new Error('Promo code not found'), { code: 'PROMO_NOT_FOUND' });
  }
  if (!promo.isActive) {
    throw Object.assign(new Error('This promo code is not active'), { code: 'PROMO_INACTIVE' });
  }

  const now = new Date();
  if (promo.startsAt && promo.startsAt > now) {
    throw Object.assign(new Error('This promo code is not yet available'), { code: 'PROMO_NOT_STARTED' });
  }
  if (promo.expiresAt && promo.expiresAt <= now) {
    throw Object.assign(new Error('This promo code has expired'), { code: 'PROMO_EXPIRED' });
  }

  if (promo.usageLimit != null && promo.usageCount >= promo.usageLimit) {
    throw Object.assign(new Error('This promo code has reached its usage limit'), {
      code: 'PROMO_LIMIT_REACHED',
    });
  }

  if (promo.usageLimitPerUser != null && userId) {
    const mine = await getUsageCountForUser(promo.id, userId);
    if (mine >= promo.usageLimitPerUser) {
      throw Object.assign(new Error('You have already used this promo code the maximum number of times'), {
        code: 'PROMO_USER_LIMIT_REACHED',
      });
    }
  }

  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    throw Object.assign(new Error('Cart is empty'), { code: 'PROMO_EMPTY_CART' });
  }

  const cartSubtotal = list.reduce((sum, it) => sum + Number(it.price) * Number(it.quantity), 0);

  if (promo.minOrderAmount != null && cartSubtotal < decimalToNumber(promo.minOrderAmount)) {
    const err = new Error(
      `Minimum order amount of ${decimalToNumber(promo.minOrderAmount)} is required to use this promo code`,
    );
    err.code = 'PROMO_MIN_ORDER_NOT_MET';
    throw err;
  }
  if (promo.maxOrderAmount != null && cartSubtotal > decimalToNumber(promo.maxOrderAmount)) {
    const err = new Error(
      `Order exceeds the maximum amount of ${decimalToNumber(promo.maxOrderAmount)} for this promo code`,
    );
    err.code = 'PROMO_MAX_ORDER_EXCEEDED';
    throw err;
  }

  // Eligible items (those the discount applies to)
  let eligibleItems = list;
  if (promo.appliesTo === 'SPECIFIC_PRODUCTS') {
    const allowed = new Set(promo.products.map((p) => p.productId));
    eligibleItems = list.filter((it) => allowed.has(it.productId));
  } else if (promo.appliesTo === 'SPECIFIC_CATEGORIES') {
    const allowed = new Set(promo.categories.map((c) => c.categoryId));
    eligibleItems = list.filter((it) => it.categoryId && allowed.has(it.categoryId));
  }

  if (eligibleItems.length === 0) {
    throw Object.assign(new Error('No items in your cart are eligible for this promo code'), {
      code: 'PROMO_NO_ELIGIBLE_ITEMS',
    });
  }

  const eligibleSubtotal = eligibleItems.reduce(
    (sum, it) => sum + Number(it.price) * Number(it.quantity),
    0,
  );

  let discount = 0;
  if (promo.discountType === 'PERCENTAGE') {
    discount = (eligibleSubtotal * decimalToNumber(promo.discountValue)) / 100;
    if (promo.maxDiscountAmount != null) {
      discount = Math.min(discount, decimalToNumber(promo.maxDiscountAmount));
    }
  } else {
    // FIXED
    discount = decimalToNumber(promo.discountValue);
  }

  // Never discount more than the eligible subtotal
  discount = Math.min(discount, eligibleSubtotal);
  discount = round2(Math.max(0, discount));

  const total = round2(Math.max(0, cartSubtotal - discount));

  return {
    promoCode: {
      id: promo.id,
      code: promo.code,
      name: promo.name,
      discountType: promo.discountType,
      discountValue: decimalToNumber(promo.discountValue),
      appliesTo: promo.appliesTo,
    },
    cartSubtotal: round2(cartSubtotal),
    eligibleSubtotal: round2(eligibleSubtotal),
    discountAmount: discount,
    total,
    eligibleProductIds: eligibleItems.map((i) => i.productId),
  };
}

/**
 * Record a usage row after an order is placed with a promo code. Increments the global
 * counter atomically. Safe to call from the order service inside its own transaction.
 */
async function recordUsage({ promoCodeId, userId, orderId = null, discountAmount }) {
  return prisma.$transaction([
    prisma.promoCodeUsage.create({
      data: { promoCodeId, userId, orderId, discountAmount: Number(discountAmount) || 0 },
    }),
    prisma.promoCode.update({
      where: { id: promoCodeId },
      data: { usageCount: { increment: 1 } },
    }),
  ]);
}

module.exports = {
  DISCOUNT_TYPES,
  APPLIES_TO_VALUES,
  mapPromoCode,
  createPromoCode,
  updatePromoCode,
  deletePromoCode,
  getPromoCodeById,
  listPromoCodes,
  listAvailablePromoCodes,
  validateAndCalculate,
  recordUsage,
};
