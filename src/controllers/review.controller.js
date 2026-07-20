const crypto = require('crypto');
const prisma = require('../config/db');
const bunnyStorage = require('../services/bunnyStorage.service');
const { detectImageMime } = require('../utils/fileSignature');
const { success, error } = require('../utils/response');

const REVIEWER_SELECT = {
  id: true,
  fullName: true,
  avatar: true,
};

// Max photos a single review may carry (mirrors the storefront picker cap).
const MAX_REVIEW_MEDIA = 6;

// Only URLs served from our own Bunny CDN are accepted as review media, so a
// caller can't inject an arbitrary external/hostile URL into a public review.
function isAllowedMediaUrl(url) {
  if (typeof url !== 'string') return false;
  const cdnHost = process.env.BUNNY_IMAGES_CDN_HOSTNAME || '';
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !!cdnHost && u.hostname === cdnHost;
  } catch {
    return false;
  }
}

// Normalize a client-supplied media array: keep only well-formed CDN URLs,
// de-duplicate, and cap the count. Returns [] for anything unusable.
function sanitizeMedia(media) {
  if (!Array.isArray(media)) return [];
  const seen = new Set();
  const out = [];
  for (const item of media) {
    const url = typeof item === 'string' ? item.trim() : '';
    if (!url || seen.has(url) || !isAllowedMediaUrl(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_REVIEW_MEDIA) break;
  }
  return out;
}

function mapReview(review) {
  if (!review) return null;
  const { user, ...rest } = review;
  return {
    ...rest,
    media: Array.isArray(review.media) ? review.media : [],
    reviewerName: user?.fullName || review.guestName || 'Anonymous',
    reviewerAvatar: user?.avatar ?? null,
    isGuest: !review.userId,
  };
}

const IMAGE_EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// ============================================
// GET /api/reviews/product/:productId
// Public list of reviews for one product, newest first, plus aggregate stats.
// ============================================
const getProductReviews = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { page = 1, limit = 10, rating } = req.query;
    const parsedPage = parseInt(page);
    const parsedLimit = parseInt(limit);
    const safePage = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage;
    const safeLimit = Math.min(50, Math.max(1, Number.isNaN(parsedLimit) ? 10 : parsedLimit));
    const skip = (safePage - 1) * safeLimit;
    const parsedRating = parseInt(rating);
    const ratingFilter = Number.isInteger(parsedRating) && parsedRating >= 1 && parsedRating <= 5 ? parsedRating : null;

    const where = { productId, ...(ratingFilter ? { rating: ratingFilter } : {}) };

    const [reviews, total, aggregate, breakdownRows] = await Promise.all([
      prisma.review.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: REVIEWER_SELECT } },
      }),
      prisma.review.count({ where }),
      // Summary stats (avg/count/breakdown) always reflect the WHOLE product,
      // never the `rating` filter — otherwise the star-breakdown bars would
      // shift/collapse as soon as the customer clicks one, which is confusing.
      prisma.review.aggregate({ where: { productId }, _avg: { rating: true }, _count: true }),
      prisma.review.groupBy({ by: ['rating'], where: { productId }, _count: true }),
    ]);

    const totalPages = Math.ceil(total / safeLimit);
    const ratingBreakdown = [5, 4, 3, 2, 1].map((star) => ({
      rating: star,
      count: breakdownRows.find((r) => r.rating === star)?._count ?? 0,
    }));

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
        reviewCount: aggregate._count,
        ratingBreakdown,
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

    // Photos are optional; keep only valid, de-duplicated CDN URLs (capped).
    const media = sanitizeMedia(req.body.media);

    const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) {
      return error(res, 'Product not found', 404);
    }

    const data = {
      productId,
      rating: ratingNum,
      comment: comment.trim(),
      media,
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

// ============================================
// POST /api/reviews/media
// Public (optionalAuth) single-image upload for review photos. Validated by
// magic bytes (not the spoofable client mimetype), stored under the CDN's
// `reviews` folder, returns the CDN URL for the client to attach to a review.
// ============================================
const uploadReviewMedia = async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return error(res, 'No file uploaded. Send multipart form with field "file".', 400);
    }
    // Trust the bytes, not the header — reject anything that isn't a real image.
    const detectedMime = detectImageMime(req.file.buffer);
    if (!detectedMime) {
      return error(res, 'File content is not a valid image (JPEG, PNG, WebP, or GIF).', 400);
    }
    const ext = IMAGE_EXT_BY_MIME[detectedMime] || '.jpg';
    const filename = `${crypto.randomUUID()}${ext}`;
    const url = await bunnyStorage.uploadImage(req.file.buffer, 'reviews', filename, detectedMime);
    return success(res, { url }, 'Media uploaded successfully', 200);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getProductReviews,
  createReview,
  uploadReviewMedia,
  getAllReviewsAdmin,
  deleteReviewAdmin,
};
