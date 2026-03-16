const BUNNY_STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE;
const BUNNY_STORAGE_REGION = process.env.BUNNY_STORAGE_REGION || 'storage.bunnycdn.com';
const BUNNY_STORAGE_ACCESS_KEY = process.env.BUNNY_STORAGE_ACCESS_KEY;
const BUNNY_IMAGES_CDN_HOSTNAME = process.env.BUNNY_IMAGES_CDN_HOSTNAME;

if (!BUNNY_STORAGE_ZONE || !BUNNY_STORAGE_ACCESS_KEY || !BUNNY_IMAGES_CDN_HOSTNAME) {
  console.warn('[BUNNY STORAGE] WARNING: BUNNY_STORAGE_ZONE, BUNNY_STORAGE_ACCESS_KEY, or BUNNY_IMAGES_CDN_HOSTNAME not set. Image upload will be disabled.');
}

const bunnyStorageConfig = {
  storageZone: BUNNY_STORAGE_ZONE,
  storageRegion: BUNNY_STORAGE_REGION,
  storageAccessKey: BUNNY_STORAGE_ACCESS_KEY,
  imagesCdnHostname: (BUNNY_IMAGES_CDN_HOSTNAME || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
  uploadBaseUrl: `https://${BUNNY_STORAGE_REGION}/${BUNNY_STORAGE_ZONE}/`,
};

module.exports = bunnyStorageConfig;
