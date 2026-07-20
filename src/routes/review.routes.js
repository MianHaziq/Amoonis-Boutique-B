const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();
const {
  getProductReviews,
  createReview,
  uploadReviewMedia,
  getAllReviewsAdmin,
  deleteReviewAdmin,
} = require('../controllers/review.controller');
const { optionalAuth } = require('../middleware/auth');
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
const { handleValidationErrors } = require('../middleware/validate');
const { publicLimiter } = require('../middleware/rateLimit');
const { uploadImage: uploadImageMulter } = require('../middleware/upload');

/**
 * @swagger
 * tags:
 *   - name: Reviews
 *     description: Public product star-rating + written reviews (signed-in or guest)
 *   - name: Reviews Admin
 *     description: Admin / manager moderation of customer reviews
 */

const productIdParam = [param('productId').isUUID().withMessage('Valid product ID required')];
const idParam = [param('id').isUUID().withMessage('Valid review ID required')];

const createReviewValidation = [
  ...productIdParam,
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('comment').trim().notEmpty().withMessage('Review text is required'),
  body('guestName').optional({ values: 'falsy' }).trim().isLength({ max: 120 }),
  body('guestEmail').optional({ values: 'falsy' }).trim().isEmail().withMessage('Valid email required'),
  // Optional photos: an array of up to 6 CDN URLs (further validated/sanitized
  // server-side against the allowed CDN host in the controller).
  body('media').optional({ nullable: true }).isArray({ max: 6 }).withMessage('media must be an array of up to 6 URLs'),
  body('media.*').optional().isString().isLength({ max: 500 }),
];

/**
 * @swagger
 * /reviews/product/{productId}:
 *   get:
 *     summary: List reviews for a product (public)
 *     tags: [Reviews]
 *     parameters:
 *       - in: path
 *         name: productId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *       - in: query
 *         name: rating
 *         schema: { type: integer, minimum: 1, maximum: 5 }
 *         description: Narrow the list to one star rating. Does not affect avgRating/reviewCount/ratingBreakdown, which always reflect the whole product.
 *     responses:
 *       200:
 *         description: Paginated reviews, plus avgRating/reviewCount/ratingBreakdown in meta
 */
router.get(
  '/product/:productId',
  productIdParam,
  [query('rating').optional().isInt({ min: 1, max: 5 })],
  handleValidationErrors,
  getProductReviews
);

/**
 * @swagger
 * /reviews/product/{productId}:
 *   post:
 *     summary: Submit a review (signed-in customer or guest)
 *     description: |
 *       Signed-in users are attributed via their JWT (optional — an expired/missing
 *       token is treated as a guest, never rejected outright). Guests must supply
 *       `guestName` + `guestEmail` and are only accepted while the admin-controlled
 *       Settings.allowGuestReviews flag is on; otherwise this returns 401.
 *     tags: [Reviews]
 *     parameters:
 *       - in: path
 *         name: productId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rating, comment]
 *             properties:
 *               rating: { type: integer, minimum: 1, maximum: 5, example: 5 }
 *               comment: { type: string, example: "Beautifully arranged, loved it!" }
 *               guestName: { type: string, example: "Sara Ahmed" }
 *               guestEmail: { type: string, example: "sara@example.com" }
 *     responses:
 *       201:
 *         description: Review submitted
 *       401:
 *         description: Guest reviews are currently disabled — sign in required
 */
router.post(
  '/product/:productId',
  publicLimiter,
  optionalAuth,
  createReviewValidation,
  handleValidationErrors,
  createReview
);

/**
 * @swagger
 * /reviews/media:
 *   post:
 *     summary: Upload a review photo (public — customers & guests)
 *     description: |
 *       Uploads a single image for use in a product review and returns its CDN URL.
 *       Send the URL back in the `media` array when submitting the review. Content is
 *       validated by its actual bytes (JPEG/PNG/WebP/GIF, max 5MB); rate-limited.
 *     tags: [Reviews]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Uploaded — returns { url }
 *       400:
 *         description: No file, or file is not a valid image
 */
router.post(
  '/media',
  publicLimiter,
  optionalAuth,
  uploadImageMulter.single('file'),
  uploadReviewMedia
);

/**
 * @swagger
 * /reviews/admin:
 *   get:
 *     summary: List all reviews across every product (admin/manager)
 *     tags: [Reviews Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: rating
 *         schema: { type: integer, minimum: 1, maximum: 5 }
 *       - in: query
 *         name: productId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated list of every review, with product + reviewer info
 */
router.get(
  '/admin',
  verifyAdminOrManager,
  requireManagerPermission('REVIEWS'),
  [
    query('rating').optional().isInt({ min: 1, max: 5 }),
    query('productId').optional().isUUID(),
  ],
  handleValidationErrors,
  getAllReviewsAdmin
);

/**
 * @swagger
 * /reviews/admin/{id}:
 *   delete:
 *     summary: Delete any review (admin/manager)
 *     tags: [Reviews Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Review deleted
 *       404:
 *         description: Review not found
 */
router.delete(
  '/admin/:id',
  verifyAdminOrManager,
  requireManagerPermission('REVIEWS'),
  idParam,
  handleValidationErrors,
  deleteReviewAdmin
);

module.exports = router;
