const bunnyStorage = require('../services/bunnyStorage.service');
const path = require('path');
const crypto = require('crypto');
const { success, error } = require('../utils/response');
const { detectImageMime, detectVideoMime } = require('../utils/fileSignature');

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

    // Verify the actual bytes are a real image — the multer fileFilter only trusts the
    // client-supplied mimetype, which is spoofable. Reject content/type mismatches so a
    // non-image payload can't be stored behind an image content-type.
    const detectedMime = detectImageMime(req.file.buffer);
    if (!detectedMime) {
      return error(res, 'File content is not a valid image (JPEG, PNG, WebP, or GIF).', 400);
    }

    const pathType = (req.query.path || 'uploads').toLowerCase();
    const allowedPaths = ['products', 'uploads', 'team', 'testimonials'];
    const pathSegment = allowedPaths.includes(pathType) ? pathType : 'uploads';

    // Derive the extension/content-type from the DETECTED type, never the client header.
    const ext = getExtensionFromMime(detectedMime);
    const filename = `${crypto.randomUUID()}${ext}`;

    const url = await bunnyStorage.uploadImage(
      req.file.buffer,
      pathSegment,
      filename,
      detectedMime
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

function getVideoExtensionFromMime(mimetype) {
  const map = {
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'video/x-msvideo': '.avi',
    'video/x-matroska': '.mkv',
  };
  return map[mimetype] || '.mp4';
}

/**
 * @desc    Upload a video to Bunny Storage and return CDN URL (e.g. web hero banners)
 * @route   POST /api/upload/video
 * @access  Admin / manager (protected by route middleware)
 * @body    multipart: file (video), optional query: path (default: uploads)
 */
const uploadVideo = async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return error(res, 'No file uploaded. Send multipart form with field "file".', 400);
    }

    // Confirm the bytes are a real video container, not just a spoofed mimetype header.
    const detectedMime = detectVideoMime(req.file.buffer);
    if (!detectedMime) {
      return error(res, 'File content is not a valid video (MP4, WebM, MOV, AVI, or MKV).', 400);
    }

    const pathType = (req.query.path || 'uploads').toLowerCase();
    const allowedPaths = ['products', 'uploads', 'team', 'testimonials'];
    const pathSegment = allowedPaths.includes(pathType) ? pathType : 'uploads';

    // Keep the original extension when present (the detector is coarser than the
    // container list — e.g. .mov/.m4v both sniff as MP4), else fall back to the
    // detected container's default. Never derive from the client mimetype.
    const ext = path.extname(req.file.originalname) || getVideoExtensionFromMime(detectedMime);
    const filename = `${crypto.randomUUID()}${ext}`;

    // bunnyStorage.uploadImage is a generic PUT to the storage zone — works for any
    // content type, so we reuse it for videos with the correct MIME.
    const url = await bunnyStorage.uploadImage(
      req.file.buffer,
      pathSegment,
      filename,
      req.file.mimetype
    );

    return success(res, { url }, 'Video uploaded successfully', 200);
  } catch (err) {
    next(err);
  }
};

module.exports = { uploadImage, uploadVideo };
