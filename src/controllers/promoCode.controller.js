const prisma = require('../config/db');
const promoCodeService = require('../services/promoCode.service');
const { success, error } = require('../utils/response');

function handlePromoError(err, res, next) {
  switch (err.code) {
    case 'P2002':
      return error(res, 'A promo code with this code already exists', 409);
    case 'P2025':
      return error(res, 'Promo code not found', 404);
    case 'PROMO_INVALID_INPUT':
      return error(res, err.message, 400);
    case 'PROMO_NOT_FOUND':
      return error(res, err.message, 404);
    case 'PROMO_INACTIVE':
    case 'PROMO_NOT_STARTED':
    case 'PROMO_EXPIRED':
    case 'PROMO_LIMIT_REACHED':
    case 'PROMO_USER_LIMIT_REACHED':
    case 'PROMO_EMPTY_CART':
    case 'PROMO_MIN_ORDER_NOT_MET':
    case 'PROMO_MAX_ORDER_EXCEEDED':
    case 'PROMO_NO_ELIGIBLE_ITEMS':
      return error(res, err.message, 400);
    default:
      return next(err);
  }
}

// ---------- Admin ----------

async function createPromoCode(req, res, next) {
  try {
    const promo = await promoCodeService.createPromoCode(req.body);
    return success(res, promoCodeService.mapPromoCode(promo), 'Promo code created successfully', 201);
  } catch (err) {
    return handlePromoError(err, res, next);
  }
}

async function updatePromoCode(req, res, next) {
  try {
    const { id } = req.params;
    const promo = await promoCodeService.updatePromoCode(id, req.body);
    return success(res, promoCodeService.mapPromoCode(promo), 'Promo code updated successfully');
  } catch (err) {
    return handlePromoError(err, res, next);
  }
}

async function deletePromoCode(req, res, next) {
  try {
    const { id } = req.params;
    await promoCodeService.deletePromoCode(id);
    return success(res, null, 'Promo code deleted successfully');
  } catch (err) {
    return handlePromoError(err, res, next);
  }
}

async function listPromoCodes(req, res, next) {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const result = await promoCodeService.listPromoCodes({
      page,
      limit,
      search: req.query.search || null,
      status: req.query.status || null,
    });
    return success(
      res,
      result.items.map((p) => promoCodeService.mapPromoCode(p)),
      'Promo codes fetched successfully',
      200,
      {
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: result.totalPages,
        },
      },
    );
  } catch (err) {
    return handlePromoError(err, res, next);
  }
}

async function getPromoCodeById(req, res, next) {
  try {
    const { id } = req.params;
    const promo = await promoCodeService.getPromoCodeById(id);
    if (!promo) return error(res, 'Promo code not found', 404);
    return success(res, promoCodeService.mapPromoCode(promo), 'Promo code fetched successfully');
  } catch (err) {
    return handlePromoError(err, res, next);
  }
}

// ---------- User ----------

async function listAvailablePromoCodes(req, res, next) {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const result = await promoCodeService.listAvailablePromoCodes({
      page,
      limit,
      userId: req.userId || null,
    });
    return success(res, result.items, 'Available promo codes fetched successfully', 200, {
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    return handlePromoError(err, res, next);
  }
}

/**
 * Validate the provided code against either:
 *   - `items` sent in the body (so the app can preview discount before saving cart), or
 *   - the authenticated user's stored cart, when `items` is omitted.
 * Does NOT record usage; that happens at checkout when the order is created.
 */
async function validatePromoCode(req, res, next) {
  try {
    const { code, items: bodyItems } = req.body;

    let items = Array.isArray(bodyItems) ? bodyItems : null;
    if (!items) {
      const cart = await prisma.cart.findUnique({
        where: { userId: req.userId },
        include: {
          items: {
            include: {
              product: {
                select: { id: true, price: true, discountedPrice: true, categoryId: true },
              },
            },
          },
        },
      });
      if (!cart || cart.items.length === 0) {
        return error(res, 'Your cart is empty', 400);
      }
      items = cart.items.map((ci) => {
        const price = ci.product.discountedPrice != null
          ? Number(ci.product.discountedPrice)
          : Number(ci.product.price);
        return {
          productId: ci.productId,
          quantity: ci.quantity,
          price,
          categoryId: ci.product.categoryId ?? null,
        };
      });
    } else {
      // Hydrate missing price / categoryId from DB if client sent only productId + quantity
      const needsHydration = items.some(
        (it) => it.price == null || (it.categoryId === undefined),
      );
      if (needsHydration) {
        const productIds = [...new Set(items.map((it) => it.productId).filter(Boolean))];
        const products = await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, price: true, discountedPrice: true, categoryId: true },
        });
        const map = new Map(products.map((p) => [p.id, p]));
        items = items.map((it) => {
          const p = map.get(it.productId);
          if (!p) return it;
          const price = it.price != null
            ? Number(it.price)
            : p.discountedPrice != null ? Number(p.discountedPrice) : Number(p.price);
          return {
            productId: it.productId,
            quantity: Number(it.quantity) || 1,
            price,
            categoryId: it.categoryId !== undefined ? it.categoryId : (p.categoryId ?? null),
          };
        });
      }
    }

    const result = await promoCodeService.validateAndCalculate(code, req.userId, items);
    return success(res, result, 'Promo code is valid');
  } catch (err) {
    return handlePromoError(err, res, next);
  }
}

module.exports = {
  createPromoCode,
  updatePromoCode,
  deletePromoCode,
  listPromoCodes,
  getPromoCodeById,
  listAvailablePromoCodes,
  validatePromoCode,
};
