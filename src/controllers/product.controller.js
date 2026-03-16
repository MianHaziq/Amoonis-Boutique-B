const productService = require('../services/product.service');
const { success, error } = require('../utils/response');

async function createProduct(req, res, next) {
  try {
    const product = await productService.createProduct(req.body);
    const data = productService.mapProduct(product);
    return success(res, data, 'Product created successfully', 201);
  } catch (err) {
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
    next(err);
  }
}

async function getAllProducts(req, res, next) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const result = await productService.getAllProducts(page, limit);
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
    const result = await productService.getProductsByCategory(categoryId, page, limit);
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

async function getProductById(req, res, next) {
  try {
    const { id } = req.params;
    const product = await productService.getProductById(id);
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
  getAllProducts,
  getProductsByCategory,
  getProductById,
};
