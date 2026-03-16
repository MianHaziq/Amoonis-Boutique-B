const bunnyStorage = require('../services/bunnyStorage.service');
const path = require('path');
const crypto = require('crypto');
const { success, error } = require('../utils/response');

/**
 * @desc    Upload image to Bunny Storage and return CDN URL
 * @route   POST /api/upload/image
 * @access  Admin (caller should protect with verifyAdmin)
 * @body    multipart: file (image), optional query: path=team|testimonials|courses (default: uploads)
 */
const uploadImage = async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return error(res, 'No file uploaded. Send multipart form with field "file".', 400);
    }

    const pathType = (req.query.path || 'uploads').toLowerCase();
    const allowedPaths = ['products', 'uploads', 'team', 'testimonials'];
    const pathSegment = allowedPaths.includes(pathType) ? pathType : 'uploads';

    const ext = path.extname(req.file.originalname) || getExtensionFromMime(req.file.mimetype);
    const filename = `${crypto.randomUUID()}${ext}`;

    const url = await bunnyStorage.uploadImage(
      req.file.buffer,
      pathSegment,
      filename,
      req.file.mimetype
    );

    return success(res, { url }, 'Image uploaded successfully', 200);
  } catch (err) {
    next(err);
  }
};

function getExtensionFromMime(mimetype) {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
  };
  return map[mimetype] || '.jpg';
}

module.exports = { uploadImage };
