const categoryService = require('../services/category.service');
const { success, error } = require('../utils/response');

async function createCategory(req, res, next) {
  try {
    const category = await categoryService.createCategory(req.body);
    return success(res, category, 'Category created successfully', 201);
  } catch (err) {
    if (err.code === 'P2002') {
      return error(res, 'Category with this title may already exist', 409);
    }
    next(err);
  }
}

async function updateCategory(req, res, next) {
  try {
    const { id } = req.params;
    const category = await categoryService.updateCategory(id, req.body);
    return success(res, category, 'Category updated successfully');
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'Category not found', 404);
    if (err.code === 'P2002') return error(res, 'Title already in use', 409);
    next(err);
  }
}

async function deleteCategory(req, res, next) {
  try {
    const { id } = req.params;
    await categoryService.deleteCategory(id);
    return success(res, null, 'Category deleted successfully');
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'Category not found', 404);
    if (err.code === 'CATEGORY_HAS_PRODUCTS') {
      return error(res, 'Cannot delete category that has products', 400);
    }
    next(err);
  }
}

async function getAllCategories(req, res, next) {
  try {
    const categories = await categoryService.getAllCategories();
    const data = categories.map((c) => ({
      ...c,
      totalProducts: c._count?.products ?? c.totalProducts,
    }));
    return success(res, data, 'Categories fetched successfully', 200, {
      total: data.length,
    });
  } catch (err) {
    next(err);
  }
}

async function getCategoryById(req, res, next) {
  try {
    const { id } = req.params;
    const category = await categoryService.getCategoryById(id, true);
    if (!category) return error(res, 'Category not found', 404);
    const { _count, products, ...rest } = category;
    const payload = { ...rest, totalProducts: _count?.products ?? rest.totalProducts };
    if (products) payload.products = products;
    return success(res, payload, 'Category fetched successfully');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createCategory,
  updateCategory,
  deleteCategory,
  getAllCategories,
  getCategoryById,
};
