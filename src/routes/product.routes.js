const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();
const productController = require('../controllers/product.controller');
const { verifyAdminOrManager, requireManagerPermission } = require('../middleware/managerAuth');
const { handleValidationErrors, requireEitherBilingual } = require('../middleware/validate');
const { publicLimiter } = require('../middleware/rateLimit');
const { attachStaffIfPresent } = require('../middleware/optionalStaff');
const { resolveRegion } = require('../middleware/region');

/**
 * @swagger
 * tags:
 *   name: Products
 *   description: Products by category. Admin CRUD; public list and detail. Pagination supported.
 */

/**
 * @swagger
 * /products:
 *   post:
 *     summary: Create a product (admin)
 *     description: |
 *       Create a new product.
 *       **Category:** To put the product in a specific category, add **`categoryId`** (UUID). Open **Categories → GET /categories**, copy the `id` of the desired category, and include it in this body. You can also leave it out and set **`categoryId`** later with **PUT /products/{id}**.
 *       **Images:** optional `images` array (up to 10 public HTTPS URLs in display order; first = primary thumbnail).
 *       Upload files with **POST /upload/image** (e.g. `?path=products`), then paste the returned `url` values into `images`.
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ProductCreate'
 *           examples:
 *             withArabic:
 *               summary: With Arabic fields (recommended)
 *               value:
 *                 title: Summer Dress
 *                 title_ar: فستان صيفي
 *                 subtitle: Light cotton
 *                 subtitle_ar: قطن خفيف
 *                 categoryId: 550e8400-e29b-41d4-a716-446655440000
 *                 descriptions:
 *                   - description: Comfortable summer dress
 *                     description_ar: فستان صيفي مريح
 *                     title: Materials
 *                     title_ar: المواد
 *                 price: 49.99
 *                 discountedPrice: 39.99
 *                 quantity: 10
 *                 images:
 *                   - https://cdn.example.com/products/dress-front.jpg
 *                   - https://cdn.example.com/products/dress-back.jpg
 *                 productOptions:
 *                   - title: Size
 *                     title_ar: المقاس
 *                     options: [S, M, L, XL]
 *                     options_ar: [صغير, وسط, كبير, كبير جداً]
 *             withImages:
 *               summary: With gallery (no Arabic)
 *               value:
 *                 title: Summer Dress
 *                 subtitle: Light cotton
 *                 categoryId: 550e8400-e29b-41d4-a716-446655440000
 *                 descriptions:
 *                   - description: Comfortable summer dress
 *                 price: 49.99
 *                 discountedPrice: 39.99
 *                 quantity: 10
 *                 images:
 *                   - https://cdn.example.com/products/dress-front.jpg
 *                   - https://cdn.example.com/products/dress-back.jpg
 *             minimal:
 *               summary: Text and pricing only
 *               value:
 *                 title: Summer Dress
 *                 subtitle: Light cotton
 *                 descriptions:
 *                   - description: Comfortable summer dress
 *                 price: 49.99
 *                 discountedPrice: 39.99
 *                 quantity: 10
 *     responses:
 *       201:
 *         description: Product created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       404:
 *         description: Category not found
 */
// Helper for nested-array bilingual checks (descriptions[] / productOptions[]):
// each row must have at least one filled side across its bilingual pair(s).
// Money values map to a Decimal(10,2) column. Accept at most two fractional digits so a
// value like 49.999 is rejected instead of being silently rounded by Postgres to 50.00.
function isTwoDecimals(val) {
  return /^\d+(\.\d{1,2})?$/.test(String(val));
}

function eachRowHasOneSide(arr, pairs) {
  if (!Array.isArray(arr)) return true; // optional — array missing is fine
  return arr.every((row) => {
    if (!row || typeof row !== 'object') return false;
    return pairs.some(([enKey, arKey]) => {
      const en = String(row[enKey] ?? '').trim();
      const ar = String(row[arKey] ?? '').trim();
      return en !== '' || ar !== '';
    });
  });
}

const createValidation = [
  // Bilingual title — either English or Arabic acceptable.
  body('title').optional().trim(),
  body('title_ar').optional().trim(),
  requireEitherBilingual('title', 'title_ar', 'Title'),
  body('subtitle').optional().trim(),
  body('subtitle_ar').optional().trim(),
  // CAT-5: bound price to the Decimal(10,2) column range and reject >2 decimal places
  // (Postgres would silently round them, storing a price the admin never typed).
  body('price')
    .isFloat({ min: 0, max: 99999999.99 }).withMessage('Price must be between 0 and 99999999.99').bail()
    .custom(isTwoDecimals).withMessage('Price supports at most 2 decimal places'),
  body('discountedPrice')
    .optional({ values: 'null' })
    .isFloat({ min: 0, max: 99999999.99 }).withMessage('discountedPrice must be between 0 and 99999999.99').bail()
    .custom(isTwoDecimals).withMessage('discountedPrice supports at most 2 decimal places').bail()
    // CAT-2: a discount can never be higher than the base price (would display as a
    // "discount" above the original). The service re-checks against the stored price too.
    .custom((val, { req }) => req.body.price == null || Number(val) <= Number(req.body.price))
    .withMessage('discountedPrice cannot exceed price'),
  // Optional manual Saudi Riyal price override — same bounds as the AED price. No
  // auto-conversion: admin enters both currencies explicitly.
  body('priceSar')
    .optional({ values: 'null' })
    .isFloat({ min: 0, max: 99999999.99 }).withMessage('priceSar must be between 0 and 99999999.99').bail()
    .custom(isTwoDecimals).withMessage('priceSar supports at most 2 decimal places'),
  body('discountedPriceSar')
    .optional({ values: 'null' })
    .isFloat({ min: 0, max: 99999999.99 }).withMessage('discountedPriceSar must be between 0 and 99999999.99').bail()
    .custom(isTwoDecimals).withMessage('discountedPriceSar supports at most 2 decimal places').bail()
    .custom((val, { req }) => req.body.priceSar == null || Number(val) <= Number(req.body.priceSar))
    .withMessage('discountedPriceSar cannot exceed priceSar'),
  // Gift card add-on — free personalized message, toggled per product.
  body('giftCardEnabled').optional().isBoolean().withMessage('giftCardEnabled must be a boolean'),
  body('giftCardExtraPrice')
    .optional({ values: 'null' })
    .isFloat({ min: 0, max: 99999999.99 }).withMessage('giftCardExtraPrice must be between 0 and 99999999.99').bail()
    .custom(isTwoDecimals).withMessage('giftCardExtraPrice supports at most 2 decimal places'),
  // Custom name add-on — customer types a name at add-to-cart time for this extra fee.
  body('customNameEnabled').optional().isBoolean().withMessage('customNameEnabled must be a boolean'),
  body('customNamePrice')
    .optional({ values: 'null' })
    .isFloat({ min: 0, max: 99999999.99 }).withMessage('customNamePrice must be between 0 and 99999999.99').bail()
    .custom(isTwoDecimals).withMessage('customNamePrice supports at most 2 decimal places'),
  body('quantity').optional().isInt({ min: 0 }).withMessage('Quantity must be a non-negative integer'),
  body('categoryId').optional({ values: 'null' }).isUUID().withMessage('categoryId must be a valid UUID when provided'),
  body('descriptions').optional().isArray().withMessage('descriptions must be an array'),
  body('descriptions.*.title').optional().trim(),
  body('descriptions.*.title_ar').optional().trim(),
  body('descriptions.*.description').optional().trim(),
  body('descriptions.*.description_ar').optional().trim(),
  body('images')
    .optional()
    .isArray()
    .withMessage('images must be an array of image URLs'),
  body('images')
    .optional()
    .custom((val) => !Array.isArray(val) || val.length <= 10)
    .withMessage('Maximum 10 images per product'),
  body('images.*')
    .optional()
    .isString()
    .trim()
    .notEmpty()
    .withMessage('Each image must be a non-empty URL string'),
  // Each description row must have at least one side filled (English OR Arabic).
  body('descriptions')
    .optional()
    .custom((arr) => eachRowHasOneSide(arr, [['description', 'description_ar']]))
    .withMessage('Each description item must have either "description" or "description_ar"'),
  body('productOptions').optional().isArray().withMessage('productOptions must be an array'),
  body('productOptions.*.title').optional().trim(),
  body('productOptions.*.title_ar').optional().trim(),
  body('productOptions.*.options').optional().isArray().withMessage('productOptions.*.options must be an array of strings'),
  body('productOptions.*.options.*').optional().isString().trim(),
  body('productOptions.*.options_ar').optional().isArray().withMessage('productOptions.*.options_ar must be an array of strings'),
  body('productOptions.*.options_ar.*').optional().isString().trim(),
  // Each productOption row must have at least one side filled for its title.
  body('productOptions')
    .optional()
    .custom((arr) => eachRowHasOneSide(arr, [['title', 'title_ar']]))
    .withMessage('Each productOption must have either "title" or "title_ar"'),
  body('status').optional().isIn(['DRAFT', 'PUBLISHED']).withMessage('status must be DRAFT or PUBLISHED'),
  body('regionIds').optional().isArray().withMessage('regionIds must be an array of region IDs'),
  body('regionIds.*').optional().isUUID().withMessage('Each regionId must be a valid UUID'),
];

const updateValidation = [
  param('id').isUUID().withMessage('Valid product ID required'),
  body('title').optional().trim().notEmpty(),
  body('title_ar').optional().trim(),
  body('subtitle').optional().trim(),
  body('subtitle_ar').optional().trim(),
  // CAT-5 / CAT-2: same bounds, decimal limit, and discount<=price guard on update. The
  // service additionally compares discountedPrice against the EXISTING price when price
  // isn't part of this partial update (the validator can't see the stored value).
  body('price')
    .optional()
    .isFloat({ min: 0, max: 99999999.99 }).withMessage('Price must be between 0 and 99999999.99').bail()
    .custom(isTwoDecimals).withMessage('Price supports at most 2 decimal places'),
  body('discountedPrice')
    .optional({ values: 'null' })
    .isFloat({ min: 0, max: 99999999.99 }).withMessage('discountedPrice must be between 0 and 99999999.99').bail()
    .custom(isTwoDecimals).withMessage('discountedPrice supports at most 2 decimal places').bail()
    .custom((val, { req }) => req.body.price == null || Number(val) <= Number(req.body.price))
    .withMessage('discountedPrice cannot exceed price'),
  body('priceSar')
    .optional({ values: 'null' })
    .isFloat({ min: 0, max: 99999999.99 }).withMessage('priceSar must be between 0 and 99999999.99').bail()
    .custom(isTwoDecimals).withMessage('priceSar supports at most 2 decimal places'),
  body('discountedPriceSar')
    .optional({ values: 'null' })
    .isFloat({ min: 0, max: 99999999.99 }).withMessage('discountedPriceSar must be between 0 and 99999999.99').bail()
    .custom(isTwoDecimals).withMessage('discountedPriceSar supports at most 2 decimal places').bail()
    .custom((val, { req }) => req.body.priceSar == null || Number(val) <= Number(req.body.priceSar))
    .withMessage('discountedPriceSar cannot exceed priceSar'),
  // Gift card add-on — free personalized message, toggled per product.
  body('giftCardEnabled').optional().isBoolean().withMessage('giftCardEnabled must be a boolean'),
  body('giftCardExtraPrice')
    .optional({ values: 'null' })
    .isFloat({ min: 0, max: 99999999.99 }).withMessage('giftCardExtraPrice must be between 0 and 99999999.99').bail()
    .custom(isTwoDecimals).withMessage('giftCardExtraPrice supports at most 2 decimal places'),
  // Custom name add-on — customer types a name at add-to-cart time for this extra fee.
  body('customNameEnabled').optional().isBoolean().withMessage('customNameEnabled must be a boolean'),
  body('customNamePrice')
    .optional({ values: 'null' })
    .isFloat({ min: 0, max: 99999999.99 }).withMessage('customNamePrice must be between 0 and 99999999.99').bail()
    .custom(isTwoDecimals).withMessage('customNamePrice supports at most 2 decimal places'),
  body('quantity').optional().isInt({ min: 0 }).withMessage('Quantity must be a non-negative integer'),
  // CAT-3: optional optimistic-concurrency token. When the admin panel sends the
  // updatedAt it last read, a stale overwrite (someone else edited meanwhile, or stock
  // moved) is rejected with 409 instead of silently clobbering.
  body('expectedUpdatedAt').optional().isISO8601().withMessage('expectedUpdatedAt must be an ISO 8601 timestamp'),
  body('categoryId').optional({ values: 'null' }).isUUID().withMessage('categoryId must be a valid UUID when provided'),
  body('descriptions').optional().isArray().withMessage('descriptions must be an array'),
  body('descriptions.*.title').optional().trim(),
  body('descriptions.*.title_ar').optional().trim(),
  body('descriptions.*.description').optional().trim(),
  body('descriptions.*.description_ar').optional().trim(),
  body('images')
    .optional()
    .isArray()
    .withMessage('images must be an array of image URLs'),
  body('images')
    .optional()
    .custom((val) => !Array.isArray(val) || val.length <= 10)
    .withMessage('Maximum 10 images per product'),
  body('images.*')
    .optional()
    .isString()
    .trim()
    .notEmpty()
    .withMessage('Each image must be a non-empty URL string'),
  // Each description row must have at least one side filled (English OR Arabic).
  body('descriptions')
    .optional()
    .custom((arr) => eachRowHasOneSide(arr, [['description', 'description_ar']]))
    .withMessage('Each description item must have either "description" or "description_ar"'),
  body('productOptions').optional().isArray().withMessage('productOptions must be an array'),
  body('productOptions.*.title').optional().trim(),
  body('productOptions.*.title_ar').optional().trim(),
  body('productOptions.*.options').optional().isArray().withMessage('productOptions.*.options must be an array of strings'),
  body('productOptions.*.options.*').optional().isString().trim(),
  body('productOptions.*.options_ar').optional().isArray().withMessage('productOptions.*.options_ar must be an array of strings'),
  body('productOptions.*.options_ar.*').optional().isString().trim(),
  body('productOptions')
    .optional()
    .custom((arr) => eachRowHasOneSide(arr, [['title', 'title_ar']]))
    .withMessage('Each productOption must have either "title" or "title_ar"'),
  body('status').optional().isIn(['DRAFT', 'PUBLISHED']).withMessage('status must be DRAFT or PUBLISHED'),
  body('regionIds').optional().isArray().withMessage('regionIds must be an array of region IDs'),
  body('regionIds.*').optional().isUUID().withMessage('Each regionId must be a valid UUID'),
];

const idParam = [param('id').isUUID().withMessage('Valid product ID required')];
const categoryIdParam = [param('categoryId').isUUID().withMessage('Valid category ID required')];
const pagination = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
];
const searchValidation = [
  query('q').optional().trim().isLength({ max: 100 }).withMessage('q must be at most 100 characters'),
  ...pagination,
];

router.post(
  '/',
  verifyAdminOrManager,
  requireManagerPermission('PRODUCTS'),
  createValidation,
  handleValidationErrors,
  productController.createProduct
);

/**
 * @swagger
 * /products/{id}:
 *   put:
 *     summary: Update a product (admin)
 *     description: |
 *       Admin can update **any** product field supported at create time: title, subtitle, price, discountedPrice, **quantity** (stock), **categoryId**, descriptions, images, productOptions.
 *       **categoryId:** Use the target category’s `id` from **GET /categories** to assign or move the product; omit this field if you are not changing category.
 *       Send only fields you want to change. **images** / **descriptions** / **productOptions** replace the whole list when sent. New photos: **POST /upload/image** then pass URLs in **images**.
 *       Requires admin JWT.
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ProductUpdate'
 *           examples:
 *             withArabic:
 *               summary: Update with Arabic fields
 *               value:
 *                 title: Summer Dress — sale
 *                 title_ar: فستان صيفي - تخفيضات
 *                 subtitle: Light organic cotton
 *                 subtitle_ar: قطن عضوي خفيف
 *                 price: 44.99
 *                 discountedPrice: 34.99
 *                 quantity: 25
 *                 descriptions:
 *                   - title: Care
 *                     title_ar: العناية
 *                     description: Machine wash cold
 *                     description_ar: غسيل بالآلة على بارد
 *                 productOptions:
 *                   - title: Size
 *                     title_ar: المقاس
 *                     options: [S, M, L, XL]
 *                     options_ar: [صغير, وسط, كبير, كبير جداً]
 *             fullUpdate:
 *               summary: Update several fields (no Arabic)
 *               value:
 *                 title: Summer Dress — sale
 *                 subtitle: Light organic cotton
 *                 price: 44.99
 *                 discountedPrice: 34.99
 *                 quantity: 25
 *                 categoryId: 550e8400-e29b-41d4-a716-446655440000
 *                 descriptions:
 *                   - title: Care
 *                     description: Machine wash cold
 *                   - description: Relaxed fit
 *                 images:
 *                   - https://cdn.example.com/products/dress-front-v2.jpg
 *                   - https://cdn.example.com/products/dress-detail.jpg
 *                 productOptions:
 *                   - title: Size
 *                     options: ["S", "M", "L", "XL"]
 *                   - title: Color
 *                     options: ["Ivory", "Sage"]
 *             stockOnly:
 *               summary: Restock / adjust quantity only
 *               value:
 *                 quantity: 100
 *             priceAndStock:
 *               summary: Price and inventory
 *               value:
 *                 price: 49.99
 *                 discountedPrice: 39.99
 *                 quantity: 12
 *             moveToCategory:
 *               summary: Assign or move to a category
 *               description: Paste category id from GET /categories
 *               value:
 *                 categoryId: 550e8400-e29b-41d4-a716-446655440000
 *     responses:
 *       200:
 *         description: Product updated
 *       404:
 *         description: Product or category not found
 */
/**
 * @swagger
 * /products/order:
 *   patch:
 *     summary: Reorder products (admin)
 *     description: |
 *       Set product display order by sending an array of `{ id, sortOrder }`.
 *       `sortOrder` is the absolute display position (admin page offset + row index),
 *       so ordering stays consistent across paginated admin pages. Requires admin JWT.
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [items]
 *             properties:
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [id, sortOrder]
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     sortOrder: { type: integer, minimum: 0 }
 *     responses:
 *       200: { description: Product order updated }
 *       404: { description: One or more products not found }
 */
const reorderValidation = [
  body('items').isArray({ min: 1 }).withMessage('items must be a non-empty array'),
  body('items.*.id').isUUID().withMessage('Each item.id must be a valid UUID'),
  body('items.*.sortOrder').isInt({ min: 0 }).withMessage('Each item.sortOrder must be a non-negative integer'),
];
router.patch(
  '/order',
  verifyAdminOrManager,
  requireManagerPermission('PRODUCTS'),
  reorderValidation,
  handleValidationErrors,
  productController.reorderProducts
);

router.put(
  '/:id',
  verifyAdminOrManager,
  requireManagerPermission('PRODUCTS'),
  updateValidation,
  handleValidationErrors,
  productController.updateProduct
);

/**
 * @swagger
 * /products/{id}:
 *   delete:
 *     summary: Delete a product (admin)
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Product deleted
 *       404:
 *         description: Product not found
 */
router.delete(
  '/:id',
  verifyAdminOrManager,
  requireManagerPermission('PRODUCTS'),
  idParam,
  handleValidationErrors,
  productController.deleteProduct
);

/**
 * @swagger
 * /products:
 *   get:
 *     summary: List all products (paginated)
 *     description: |
 *       Returns paginated products. Storefront sends the **X-Region** header and gets only
 *       PUBLISHED products in that region. Staff (admin/manager token) get all products across
 *       all regions and may narrow with the **region** / **status** query filters.
 *     tags: [Products]
 *     parameters:
 *       - $ref: '#/components/parameters/XRegionHeader'
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *         description: Items per page (max 100)
 *       - $ref: '#/components/parameters/RegionFilterQuery'
 *       - $ref: '#/components/parameters/StatusFilterQuery'
 *     responses:
 *       200:
 *         description: Paginated products
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiSuccess'
 *             example:
 *               success: true
 *               message: Products fetched successfully
 *               data: []
 *               meta:
 *                 pagination: { page: 1, limit: 10, total: 0, totalPages: 0 }
 */
router.get('/', publicLimiter, attachStaffIfPresent, resolveRegion, pagination, handleValidationErrors, productController.getAllProducts);

/**
 * @swagger
 * /products/search:
 *   get:
 *     summary: Search products (paginated)
 *     description: |
 *       Case-insensitive search across product title/subtitle (EN + AR) and the
 *       product's category name. Backed by pg_trgm GIN indexes so it stays fast as the
 *       catalog grows. Storefront requests (X-Region) match only PUBLISHED products in
 *       that region; staff match everything (optionally narrowed by region/status).
 *       An empty `q` returns no results. `meta.query` echoes the normalized term.
 *     tags: [Products]
 *     parameters:
 *       - $ref: '#/components/parameters/XRegionHeader'
 *       - in: query
 *         name: q
 *         schema: { type: string, maxLength: 100 }
 *         description: Search term
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *       - $ref: '#/components/parameters/RegionFilterQuery'
 *       - $ref: '#/components/parameters/StatusFilterQuery'
 *     responses:
 *       200:
 *         description: Paginated search results
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *             example:
 *               success: true
 *               message: Products fetched successfully
 *               data: []
 *               meta:
 *                 pagination: { page: 1, limit: 10, total: 0, totalPages: 0 }
 *                 query: "rose"
 */
router.get('/search', publicLimiter, attachStaffIfPresent, resolveRegion, searchValidation, handleValidationErrors, productController.searchProducts);

/**
 * @swagger
 * /products/best-sellers:
 *   get:
 *     summary: List best-selling products (paginated)
 *     description: Ranks products by units sold from non-cancelled orders in the requesting region. Falls back to the "Gift Boxes" showcase category, then the plain catalogue, so the result is never empty. Public, rate-limited. Honors the X-Region header (storefront) and region/status filters (staff).
 *     tags: [Products]
 *     parameters:
 *       - $ref: '#/components/parameters/XRegionHeader'
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *       - $ref: '#/components/parameters/RegionFilterQuery'
 *       - $ref: '#/components/parameters/StatusFilterQuery'
 *     responses:
 *       200:
 *         description: Paginated best-selling products
 */
router.get('/best-sellers', publicLimiter, attachStaffIfPresent, resolveRegion, pagination, handleValidationErrors, productController.getBestSellers);

/**
 * @swagger
 * /products/category/{categoryId}:
 *   get:
 *     summary: List products by category (paginated)
 *     description: Returns products in the given category. Public, rate-limited. Honors the X-Region header (storefront) and region/status filters (staff).
 *     tags: [Products]
 *     parameters:
 *       - $ref: '#/components/parameters/XRegionHeader'
 *       - in: path
 *         name: categoryId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *       - $ref: '#/components/parameters/RegionFilterQuery'
 *       - $ref: '#/components/parameters/StatusFilterQuery'
 *     responses:
 *       200:
 *         description: Paginated products in category
 */
router.get(
  '/category/:categoryId',
  publicLimiter,
  attachStaffIfPresent,
  resolveRegion,
  categoryIdParam,
  pagination,
  handleValidationErrors,
  productController.getProductsByCategory
);

/**
 * @swagger
 * /products/{id}:
 *   get:
 *     summary: Get single product details
 *     description: Returns one product with category info. Public, rate-limited. A storefront request (X-Region) gets 404 if the product is a draft or not in that region; staff see it regardless.
 *     tags: [Products]
 *     parameters:
 *       - $ref: '#/components/parameters/XRegionHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Product details
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 id: 550e8400-e29b-41d4-a716-446655440000
 *                 title: Summer Dress
 *                 price: 49.99
 *                 discountedPrice: 39.99
 *                 category: { id: ..., title: Women }
 *       404:
 *         description: Product not found
 */
router.get(
  '/:id',
  publicLimiter,
  attachStaffIfPresent,
  resolveRegion,
  idParam,
  handleValidationErrors,
  productController.getProductById
);

module.exports = router;
