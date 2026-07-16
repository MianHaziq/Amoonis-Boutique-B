const prisma = require('../config/db');
const { success, error } = require('../utils/response');

const REVIEWER_SELECT = {
  id: true,
  fullName: true,
  avatar: true,
};

function mapReview(review) {
  if (!review) return null;
  const { user, ...rest } = review;
  return {
    ...rest,
    reviewerName: user?.fullName || review.guestName || 'Anonymous',
    reviewerAvatar: user?.avatar ?? null,
    isGuest: !review.userId,
  };
}

// ============================================
// GET /api/reviews/product/:productId
// Public list of reviews for one product, newest first, plus aggregate stats.
// ============================================
const getProductReviews = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const parsedPage = parseInt(page);
    const parsedLimit = parseInt(limit);
    const safePage = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage;
    const safeLimit = Math.min(50, Math.max(1, Number.isNaN(parsedLimit) ? 10 : parsedLimit));
    const skip = (safePage - 1) * safeLimit;

    const [reviews, total, aggregate] = await Promise.all([
      prisma.review.findMany({
        where: { productId },
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: REVIEWER_SELECT } },
      }),
      prisma.review.count({ where: { productId } }),
      prisma.review.aggregate({
        where: { productId },
        _avg: { rating: true },
      }),
    ]);

    const totalPages = Math.ceil(total / safeLimit);
    return success(
      res,
      reviews.map(mapReview),
      'Reviews fetched successfully',
      200,
      {
        pagination: {
          page: safePage,
          limit: safeLimit,
          total,
          totalPages,
          hasNext: safePage < totalPages,
          hasPrev: safePage > 1,
        },
        avgRating: aggregate._avg.rating != null ? Number(aggregate._avg.rating.toFixed(2)) : null,
        reviewCount: total,
      }
    );
  } catch (err) {
    next(err);
  }
};

// ============================================
// POST /api/reviews/product/:productId
// Create a review. Signed-in (optionalAuth attaches req.userId) or guest —
// guest submissions require Settings.allowGuestReviews to be true.
// ============================================
const createReview = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { rating, comment, guestName, guestEmail } = req.body;

    const ratingNum = Number(rating);
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return error(res, 'Rating must be a whole number between 1 and 5', 400);
    }
    if (!comment || !comment.trim()) {
      return error(res, 'Review text is required', 400);
    }

    const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) {
      return error(res, 'Product not found', 404);
    }

    const data = {
      productId,
      rating: ratingNum,
      comment: comment.trim(),
    };

    if (req.userId) {
      data.userId = req.userId;
    } else {
      const settings = await prisma.settings.findUnique({
        where: { id: 'default' },
        select: { allowGuestReviews: true },
      });
      const guestReviewsAllowed = settings?.allowGuestReviews ?? true;
      if (!guestReviewsAllowed) {
        return error(res, 'Please sign in to write a review.', 401);
      }
      if (!guestName || !guestName.trim() || !guestEmail || !guestEmail.trim()) {
        return error(res, 'Name and email are required to write a review as a guest.', 400);
      }
      data.guestName = guestName.trim();
      data.guestEmail = guestEmail.trim();
    }

    const review = await prisma.review.create({
      data,
      include: { user: { select: REVIEWER_SELECT } },
    });

    return success(res, mapReview(review), 'Review submitted successfully', 201);
  } catch (err) {
    next(err);
  }
};

// ============================================
// GET /api/reviews/admin
// Admin/manager list of ALL reviews across every product, for moderation.
// ============================================
const getAllReviewsAdmin = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, rating, productId } = req.query;
    const parsedPage = parseInt(page);
    const parsedLimit = parseInt(limit);
    const safePage = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage;
    const safeLimit = Math.min(100, Math.max(1, Number.isNaN(parsedLimit) ? 20 : parsedLimit));
    const skip = (safePage - 1) * safeLimit;

    const where = {};
    if (productId) where.productId = productId;
    if (rating) where.rating = parseInt(rating);
    if (search) {
      where.OR = [
        { comment: { contains: search, mode: 'insensitive' } },
        { guestName: { contains: search, mode: 'insensitive' } },
        { guestEmail: { contains: search, mode: 'insensitive' } },
        { user: { fullName: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { product: { title: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: REVIEWER_SELECT },
          product: { select: { id: true, title: true } },
        },
      }),
      prisma.review.count({ where }),
    ]);

    const totalPages = Math.ceil(total / safeLimit);
    return success(res, reviews.map(mapReview), 'Reviews fetched successfully', 200, {
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages,
        hasNext: safePage < totalPages,
        hasPrev: safePage > 1,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ============================================
// DELETE /api/reviews/admin/:id
// Admin/manager deletes any review.
// ============================================
const deleteReviewAdmin = async (req, res, next) => {
  try {
    const { id } = req.params;
    await prisma.review.delete({ where: { id } });
    return success(res, null, 'Review deleted successfully');
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'Review not found', 404);
    next(err);
  }
};

module.exports = {
  getProductReviews,
  createReview,
  getAllReviewsAdmin,
  deleteReviewAdmin,
};
