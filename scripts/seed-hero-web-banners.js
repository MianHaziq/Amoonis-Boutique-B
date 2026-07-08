/**
 * Seed the current hero videos as manageable WEB banners.
 *
 * The homepage hero used to read hard-coded video URLs from the frontend config,
 * so they never appeared in the admin panel. This imports them into the DB as
 * WEB + PUBLISHED banners (default region) so an admin can reorder / delete /
 * replace them. Idempotent: skips any URL that already exists.
 */
require('dotenv').config();
const prisma = require('../src/config/db');
const bannerService = require('../src/services/banner.service');

const HERO_VIDEOS = [
  'https://ammon-pull-zone.b-cdn.net/videos/815a3673-06d7-45fa-8c2d-7ca1a880bfbb.mp4',
  'https://ammon-pull-zone.b-cdn.net/videos/3fc3ab0e-11ac-448a-8279-32bd281ad382.mp4',
  'https://ammon-pull-zone.b-cdn.net/videos/e9077e2a-808c-4e4c-9dd1-d25826738a5d.mp4',
];

(async () => {
  try {
    const existing = await prisma.bannerImage.findMany({ select: { url: true } });
    const existingUrls = new Set(existing.map((b) => b.url));

    const toAdd = HERO_VIDEOS.filter((u) => !existingUrls.has(u));
    if (toAdd.length === 0) {
      console.log('✓ All hero videos already present as banners. Nothing to do.');
      process.exit(0);
    }

    const { count, items } = await bannerService.addBanners(toAdd, {
      status: 'PUBLISHED',
      platform: 'WEB',
    });

    console.log(`✓ Added ${count} WEB banner(s):`);
    items.forEach((b) => console.log(`   [${b.sortOrder}] ${b.platform} ${b.status} ${b.url}`));
  } catch (err) {
    console.error('✗ Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    process.exit();
  }
})();
