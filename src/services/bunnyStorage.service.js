const bunnyStorageConfig = require('../config/bunnyStorage');

/**
 * Upload an image to Bunny Storage Zone and return the public CDN URL.
 * @param {Buffer} buffer - Raw file buffer
 * @param {string} path - Path segment (e.g. 'team', 'testimonials', 'courses') — no leading/trailing slashes
 * @param {string} filename - Filename (e.g. 'uuid.jpg')
 * @param {string} contentType - MIME type (e.g. 'image/jpeg')
 * @returns {Promise<string>} Public CDN URL
 */
async function uploadImage(buffer, path, filename, contentType) {
  const { storageZone, storageRegion, storageAccessKey, imagesCdnHostname } = bunnyStorageConfig;

  if (!storageZone || !storageAccessKey || !imagesCdnHostname) {
    throw new Error('Bunny Storage is not configured. Set BUNNY_STORAGE_ZONE, BUNNY_STORAGE_ACCESS_KEY, BUNNY_IMAGES_CDN_HOSTNAME.');
  }

  const pathSegment = path.replace(/^\/|\/$/g, '') || 'uploads';
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const uploadUrl = `https://${storageRegion}/${storageZone}/${pathSegment}/${safeFilename}`;

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      AccessKey: storageAccessKey,
      'Content-Type': contentType || 'application/octet-stream',
    },
    body: buffer,
  });

  if (response.status !== 201 && response.status !== 200) {
    const errorText = await response.text();
    throw new Error(`Bunny Storage upload failed (${response.status}): ${errorText}`);
  }

  const cdnUrl = `https://${imagesCdnHostname}/${pathSegment}/${safeFilename}`;
  return cdnUrl;
}

/**
 * Delete a file from Bunny Storage Zone (optional; use when replacing images).
 * @param {string} storagePath - Full path in storage, e.g. 'team/abc.jpg'
 * @returns {Promise<boolean>}
 */
async function deleteImage(storagePath) {
  const { storageZone, storageRegion, storageAccessKey } = bunnyStorageConfig;

  if (!storageZone || !storageAccessKey) {
    throw new Error('Bunny Storage is not configured.');
  }

  const pathNorm = storagePath.replace(/^\/|\/$/g, '');
  const deleteUrl = `https://${storageRegion}/${storageZone}/${pathNorm}`;

  const response = await fetch(deleteUrl, {
    method: 'DELETE',
    headers: {
      AccessKey: storageAccessKey,
    },
  });

  if (!response.ok && response.status !== 404) {
    const errorText = await response.text();
    throw new Error(`Bunny Storage delete failed (${response.status}): ${errorText}`);
  }

  return true;
}

module.exports = {
  uploadImage,
  deleteImage,
};
