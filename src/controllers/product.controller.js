const productService = require('../services/product.service');
const sectionService = require('../services/section.service');
const { success, error } = require('../utils/response');
const { visibilityFromReq } = require('../utils/visibilityFromReq');

async function createProduct(req, res, next) {
  try {
    const product = await productService.createProduct(req.body);
    const data = productService.mapProduct(product);
    return success(res, data, 'Product created successfully', 201);
  } catch (err) {
    if (err.code === 'VALIDATION') return error(res, err.message, 400);
    if (err.code === 'REGION_NOT_FOUND') return error(res, err.message, 400);
    if (err.code === 'INVALID_PRICE') return error(res, err.message, 400);
    if (err.code === 'P2025') return error(res, 'Category not found', 404);
    next(err);
  }
}

async function updateProduct(req, res, next) {
  try {
    const { id } = req.params;
    const product = await productService.updateProduct(id, req.body);
    if (!product) return error(res, 'Product not found', 404);
    const data = productService.mapProduct(product);
    return success(res, data, 'Product updated successfully');
  } catch (err) {
    if (err.code === 'VALIDATION') return error(res, err.message, 400);
    if (err.code === 'REGION_NOT_FOUND') return error(res, err.message, 400);
    if (err.code === 'INVALID_PRICE') return error(res, err.message, 400);
    // CAT-3: optimistic-concurrency conflict — the product changed since the client read it.
    if (err.code === 'STALE_WRITE') return error(res, err.message, 409);
    if (err.code === 'P2025') return error(res, 'Product or category not found', 404);
    next(err);
  }
}

async function deleteProduct(req, res, next) {
  try {
    const { id } = req.params;
    const product = await productService.deleteProduct(id);
    if (!product) return error(res, 'Product not found', 404);
    return success(res, null, 'Product deleted successfully');
  } catch (err) {
    if (err.code === 'PRODUCT_HAS_ACTIVE_ORDERS') {
      const n = err.activeOrderCount;
      return error(
        res,
        `Cannot delete product: it is part of ${n} active order${n === 1 ? '' : 's'} (pending, confirmed or processing). Complete or cancel those orders first.`,
        409
      );
    }
    next(err);
  }
}

async function reorderProducts(req, res, next) {
  try {
    const { items } = req.body;
    const result = await productService.reorderProducts(items);
    return success(res, null, 'Product order updated successfully', 200, result);
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'One or more products not found', 404);
    next(err);
  }
}

async function getAllProducts(req, res, next) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const categoryId = req.query.categoryId || null;
    const visibility = await visibilityFromReq(req);
    // Storefront "Everything" list: rescue products that a published Section is
    // currently surfacing (Best Sellers / New Arrivals / curated rails) so a featured
    // product still shows here even when its category is drafted ENTIRE_STORE. Staff
    // see everything already, so skip the extra section resolution for them.
    const rescueIds = visibility.isStaff ? null : await sectionService.getSurfacedProductIds(visibility);
    const result = await productService.getAllProducts(page, limit, categoryId, visibility, rescueIds);
    return success(res, result.items, 'Products fetched successfully', 200, {
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getProductsByCategory(req, res, next) {
  try {
    const { categoryId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const visibility = await visibilityFromReq(req);
    const result = await productService.getProductsByCategory(categoryId, page, limit, visibility);
    return success(res, result.items, 'Products fetched successfully', 200, {
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getBestSellers(req, res, next) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const visibility = await visibilityFromReq(req);
    const result = await productService.getBestSellers(page, limit, visibility);
    return success(res, result.items, 'Best-selling products fetched successfully', 200, {
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getNewArrivals(req, res, next) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const visibility = await visibilityFromReq(req);
    const result = await productService.getNewArrivals(page, limit, visibility);
    return success(res, result.items, 'New arrivals fetched successfully', 200, {
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function searchProducts(req, res, next) {
  try {
    const q = req.query.q != null ? String(req.query.q) : '';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const categoryId = req.query.categoryId || null;
    const visibility = await visibilityFromReq(req);
    const result = await productService.searchProducts(q, page, limit, visibility, categoryId);
    return success(res, result.items, 'Products fetched successfully', 200, {
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
      query: result.query,
    });
  } catch (err) {
    next(err);
  }
}

async function getProductById(req, res, next) {
  try {
    const { id } = req.params;
    const visibility = await visibilityFromReq(req);
    let product = await productService.getProductById(id, visibility);
    // Only if it wasn't visible normally do we pay for section resolution: a product
    // in an ENTIRE_STORE-draft category is still openable when a published Section is
    // surfacing it (so a rescued card in the "Everything" grid actually clicks through).
    if (!product && !visibility.isStaff) {
      const rescueIds = await sectionService.getSurfacedProductIds(visibility);
      if (rescueIds.includes(id)) {
        product = await productService.getProductById(id, visibility, rescueIds);
      }
    }
    if (!product) return error(res, 'Product not found', 404);
    return success(res, product, 'Product fetched successfully');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createProduct,
  updateProduct,
  deleteProduct,
  reorderProducts,
  getAllProducts,
  getProductsByCategory,
  getBestSellers,
  getNewArrivals,
  searchProducts,
  getProductById,
};
