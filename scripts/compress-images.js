/**
 * Compress every catalogue image (product + category) stored on Bunny:
 * download -> resize (cap 1600px) -> WebP q82 -> re-upload -> update DB URL ->
 * delete the old (large PNG) file. Product photos drop ~1.5MB PNG -> ~100KB WebP
 * with no visible quality loss, which slashes the image-optimizer's origin fetch
 * and Bunny bandwidth.
 *
 * Run:  node scripts/compress-images.js
 */

require('dotenv').config();
const crypto = require('crypto');
const sharp = require('sharp');
const prisma = require('../src/config/db');
const { uploadImage, deleteImage } = require('../src/services/bunnyStorage.service');
const { imagesCdnHostname } = require('../src/config/bunnyStorage');

const MAX_W = 1600;
const QUALITY = 82;

async function fetchBuf(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i === tries - 1) throw e;
    }
  }
}

async function compress(url) {
  const input = await fetchBuf(url);
  const out = await sharp(input)
    .rotate() // respect EXIF orientation
    .resize({ width: MAX_W, withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toBuffer();
  const newUrl = await uploadImage(out, 'uploads', `${crypto.randomUUID()}.webp`, 'image/webp');
  // best-effort delete of the old object (skip if it wasn't a Bunny upload)
  if (imagesCdnHostname && url.includes(imagesCdnHostname)) {
    const path = url.split(`${imagesCdnHostname}/`)[1];
    if (path) { try { await deleteImage(path); } catch {} }
  }
  return { newUrl, before: input.length, after: out.length };
}

async function main() {
  let before = 0, after = 0, n = 0, failed = 0;

  // Skip anything already converted to .webp so the run is resumable.
  const imgs = (await prisma.productImage.findMany({ include: { product: { select: { title: true } } } }))
    .filter((i) => !i.url.endsWith('.webp'));
  const cats = (await prisma.category.findMany({ where: { image: { not: null } } }))
    .filter((c) => !c.image.endsWith('.webp'));
  console.log(`Compressing ${imgs.length} product images + ${cats.length} category images (skipping already-webp)...\n`);

  for (const img of imgs) {
    try {
      const r = await compress(img.url);
      await prisma.productImage.update({ where: { id: img.id }, data: { url: r.newUrl } });
      before += r.before; after += r.after; n++;
      if (n % 15 === 0) console.log(`  ...${n}/${imgs.length}`);
    } catch (e) { failed++; console.log(`  FAIL (${img.product?.title}): ${e.message}`); }
  }

  for (const c of cats) {
    try {
      const r = await compress(c.image);
      await prisma.category.update({ where: { id: c.id }, data: { image: r.newUrl } });
      before += r.before; after += r.after; n++;
    } catch (e) { failed++; console.log(`  FAIL cat (${c.title}): ${e.message}`); }
  }

  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  console.log(`\nDone. ${n} images compressed${failed ? `, ${failed} failed` : ''}.`);
  console.log(`Total: ${mb(before)}MB -> ${mb(after)}MB  (${(100 - (after / before) * 100).toFixed(0)}% smaller)`);
  console.log(`Avg per image: ${(before / n / 1024).toFixed(0)}KB -> ${(after / n / 1024).toFixed(0)}KB`);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); }).finally(() => prisma.$disconnect());
