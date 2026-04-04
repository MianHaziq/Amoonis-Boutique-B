const express = require('express');
const router = express.Router();
const { uploadImage } = require('../controllers/upload.controller');
const { uploadImage: uploadImageMulter } = require('../middleware/upload');
const { verifyAdminOrManager, requireAnyManagerPermission } = require('../middleware/managerAuth');
const { UPLOAD_RELATED_PERMISSIONS } = require('../constants/managerPermissions');

/**
 * @swagger
 * tags:
 *   name: Upload
 *   description: Image upload to Bunny CDN. Admin only. Use for product/category images or general uploads.
 */

/**
 * @swagger
 * /upload/image:
 *   post:
 *     summary: Upload image to Bunny Storage
 *     description: Upload an image via multipart form (field `file`). Returns the CDN URL. Optional query `path` sets the folder (products, uploads, team, testimonials). Requires admin JWT.
 *     tags: [Upload]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Image file (e.g. JPEG, PNG)
 *     parameters:
 *       - in: query
 *         name: path
 *         schema:
 *           type: string
 *           enum: [products, uploads, team, testimonials]
 *           default: uploads
 *         description: Folder in storage (e.g. products for product images)
 *     responses:
 *       200:
 *         description: Upload successful; returns CDN URL
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data: { url: "https://cdn.example.com/uploads/abc123.jpg" }
 *       400:
 *         description: No file or invalid file type
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/image',
  verifyAdminOrManager,
  requireAnyManagerPermission([...UPLOAD_RELATED_PERMISSIONS]),
  uploadImageMulter.single('file'),
  uploadImage
);

module.exports = router;
