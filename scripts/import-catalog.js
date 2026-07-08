/**
 * One-off catalog importer.
 *
 * Replaces the local demo catalogue with the REAL products/categories from the
 * client's live site (amoonis-boutique.com), pulled from its public WooCommerce
 * Store API (snapshot in scripts/_woo-products.json / _woo-cats.json).
 *
 * - Wipes existing products + categories (order history is preserved: OrderItem
 *   -> product is onDelete:SetNull with a title snapshot).
 * - Mirrors each image from the live site into the client's Bunny CDN so the
 *   catalogue is self-hosted (not hotlinking the old WordPress site).
 * - Creates 4 categories + 32 products with prices, descriptions, colour/option
 *   groups, images, PUBLISHED status, and links to every active region.
 *
 * Run:  node scripts/import-catalog.js
 */

require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const prisma = require('../src/config/db');
const { uploadImage } = require('../src/services/bunnyStorage.service');

const PRODUCTS = require('./_woo-products.json');
const CATS = require('./_woo-cats.json');

// Arabic titles for the four known categories (nice-to-have for the i18n layer).
const CAT_AR = {
  'Flower Bouquets': 'باقات الزهور',
  'Flower Mugs': 'أكواب الورد',
  'Gift Boxes': 'علب الهدايا',
  'Newborn Gifts': 'هدايا المواليد',
};

// --- text helpers ---------------------------------------------------------
const ENT = {
  '&amp;': '&', '&#38;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#039;': "'", '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&rsquo;': '’',
  '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”', '&ndash;': '–', '&mdash;': '—',
  '&hellip;': '…', '&eacute;': 'é',
};
function decodeEntities(s = '') {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => ENT[m.toLowerCase()] ?? m);
}
function stripHtml(html = '') {
  return decodeEntities(
    html
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}
const money = (minor) => Number((Number(minor) / 100).toFixed(2));

// --- image mirroring ------------------------------------------------------
async function mirror(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`fetch ${res.status} for ${src}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (src.split('?')[0].split('.').pop() || 'png').toLowerCase();
  const ct =
    ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : 'image/jpeg';
  return uploadImage(buf, 'uploads', `${crypto.randomUUID()}.${ext}`, ct);
}

async function main() {
  console.log('--- Amoonis catalogue import ---');

  const regions = await prisma.region.findMany({ where: { isActive: true } });
  const regionIds = regions.map((r) => r.id);
  console.log('Active regions:', regions.map((r) => r.code).join(', '));

  // 1) Wipe demo catalogue (products first — Category is Restrict on product).
  const delP = await prisma.product.deleteMany({});
  const delC = await prisma.category.deleteMany({});
  console.log(`Wiped demo data: ${delP.count} products, ${delC.count} categories.`);

  // 2) Categories — only those actually used by the 32 products.
  const usedCatNames = new Set(
    PRODUCTS.flatMap((p) => p.categories.map((c) => decodeEntities(c.name)))
  );
  const catByName = new Map();
  for (const c of CATS) {
    const name = decodeEntities(c.name);
    if (!usedCatNames.has(name)) continue;
    let image = null;
    if (c.image?.src) {
      try { image = await mirror(c.image.src); } catch (e) { console.warn(`  cat image failed (${name}):`, e.message); }
    }
    const created = await prisma.category.create({
      data: {
        title: name,
        title_ar: CAT_AR[name] ?? null,
        description: stripHtml(c.description) || null,
        image,
        status: 'PUBLISHED',
        regions: { create: regionIds.map((regionId) => ({ regionId })) },
      },
    });
    catByName.set(name, created.id);
    console.log(`Category: ${name}${image ? ' (+image)' : ''}`);
  }

  // 3) Products — create oldest-first so the newest keeps the latest createdAt
  //    (matches the site's "Newest" default ordering). Woo JSON is newest-first.
  const ordered = [...PRODUCTS].reverse();
  const base = Date.now() - ordered.length * 1000;
  let n = 0;

  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i];
    const title = decodeEntities(p.name);
    const catName = decodeEntities(p.categories[0]?.name || '');
    const categoryId = catByName.get(catName) ?? null;

    const onSale = p.on_sale && p.prices.sale_price !== p.prices.regular_price;
    const price = money(onSale ? p.prices.regular_price : p.prices.price);
    const discountedPrice = onSale ? money(p.prices.sale_price) : null;

    // images
    const imageUrls = [];
    for (const img of p.images || []) {
      try { imageUrls.push(await mirror(img.src)); }
      catch (e) { console.warn(`  img failed (${title}):`, e.message); }
    }

    const subtitle = stripHtml(p.short_description).split('\n')[0] || null;
    const descBody = stripHtml(p.description);
    const options = (p.attributes || [])
      .filter((a) => a.terms?.length)
      .map((a, idx) => ({
        title: decodeEntities(a.name),
        options: a.terms.map((t) => decodeEntities(t.name)),
        sortOrder: idx,
      }));

    await prisma.product.create({
      data: {
        title,
        title_ar: null,
        subtitle: subtitle ? subtitle.slice(0, 250) : null,
        price,
        discountedPrice,
        quantity: p.is_in_stock ? 100 : 0,
        categoryId,
        status: 'PUBLISHED',
        createdAt: new Date(base + i * 1000),
        images: { create: imageUrls.map((url, sortOrder) => ({ url, sortOrder })) },
        descriptions: descBody
          ? { create: [{ title: null, description: descBody, sortOrder: 0 }] }
          : undefined,
        productOptions: options.length ? { create: options } : undefined,
        regions: { create: regionIds.map((regionId) => ({ regionId })) },
      },
    });
    n++;
    console.log(`  [${n}/${ordered.length}] ${title} — ${discountedPrice ?? price} AED, ${imageUrls.length} img, ${options.length} opt`);
  }

  // 4) Refresh category.totalProducts counts.
  for (const [name, id] of catByName) {
    const count = await prisma.product.count({ where: { categoryId: id } });
    await prisma.category.update({ where: { id }, data: { totalProducts: count } });
    console.log(`Count: ${name} = ${count}`);
  }

  console.log(`\nDone. ${catByName.size} categories, ${n} products imported.`);
}

main()
  .catch((e) => { console.error('IMPORT FAILED:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
