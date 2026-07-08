/**
 * Populate ProductOption.optionImages (colour -> product image) from the live
 * site's WooCommerce variation images. For each local product with a colour
 * option, we look up the matching live product, read each colour variation's
 * image filename, find that image's position in the product gallery, and map it
 * to our Bunny image at the same position. Purely additive data.
 *
 * Run:  node scripts/populate-option-images.js
 */

require('dotenv').config();
const prisma = require('../src/config/db');
const WOO = require('./_woo-products.json');
const API = 'https://amoonis-boutique.com/wp-json/wc/store/v1';

const norm = (s = '') =>
  s.replace(/&amp;/g, '&').replace(/[’‘']/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
const COLOR_TITLE = /colou?r/i;

async function fetchJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.ok) return r.json();
    } catch { /* retry */ }
  }
  return null;
}

async function main() {
  const wooByTitle = new Map(WOO.map((w) => [norm(w.name), w]));

  const products = await prisma.product.findMany({
    include: {
      images: { orderBy: { sortOrder: 'asc' } },
      productOptions: { orderBy: { sortOrder: 'asc' } },
    },
  });

  let updated = 0;
  for (const p of products) {
    const colorOpt = p.productOptions.find((o) => COLOR_TITLE.test(o.title));
    if (!colorOpt) continue;
    const woo = wooByTitle.get(norm(p.title));
    if (!woo) { console.log(`  no live match: ${p.title}`); continue; }

    const wooImgNames = (woo.images || []).map((i) => i.name); // gallery order
    const localUrls = p.images.map((i) => i.url); // same order (mirrored)

    // slug -> variation image filename (fetch each variation once)
    const slugToImg = {};
    for (const v of woo.variations || []) {
      const slug = (v.attributes?.[0]?.value || '').toLowerCase();
      const vd = await fetchJSON(`${API}/products/${v.id}`);
      const imgName = vd?.images?.[0]?.name;
      if (slug && imgName) slugToImg[slug] = imgName;
    }
    // term name -> slug (to translate our display value into the variation slug)
    const nameToSlug = {};
    for (const a of woo.attributes || []) {
      if (!COLOR_TITLE.test(a.name)) continue;
      for (const t of a.terms || []) nameToSlug[norm(t.name)] = t.slug;
    }

    const optionImages = colorOpt.options.map((value) => {
      const slug = nameToSlug[norm(value)];
      const imgName = slug ? slugToImg[slug] : undefined;
      if (!imgName) return '';
      const idx = wooImgNames.indexOf(imgName);
      return idx >= 0 && localUrls[idx] ? localUrls[idx] : '';
    });

    const mapped = optionImages.filter(Boolean).length;
    await prisma.productOption.update({
      where: { id: colorOpt.id },
      data: { optionImages },
    });
    updated++;
    console.log(`  ${p.title}: ${colorOpt.options.join('/')} -> ${mapped}/${colorOpt.options.length} images mapped`);
  }

  console.log(`\nDone. Updated ${updated} colour options.`);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); }).finally(() => prisma.$disconnect());
