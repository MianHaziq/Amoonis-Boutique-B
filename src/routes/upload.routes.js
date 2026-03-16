const express = require('express');
const router = express.Router();
const { uploadImage } = require('../controllers/upload.controller');
const { uploadImage: uploadImageMulter } = require('../middleware/upload');
const { verifyAdmin } = require('../middleware/auth');

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
  verifyAdmin,
  uploadImageMulter.single('file'),
  uploadImage
);

module.exports = router;
