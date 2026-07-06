/**
 * Compare local DB catalogue against the live site (WooCommerce snapshot) and
 * FIX every difference so local matches the client's current website exactly:
 * price, sale price, category, subtitle, description, option groups, and image
 * set (re-mirrors from live when the image count differs).
 *
 * Run:  node scripts/compare-catalog.js          (report + fix)
 *       node scripts/compare-catalog.js --report  (report only, no writes)
 */

require('dotenv').config();
const crypto = require('crypto');
const prisma = require('../src/config/db');
const { uploadImage } = require('../src/services/bunnyStorage.service');

const REPORT_ONLY = process.argv.includes('--report');
const PRODUCTS = require('./_woo-products.json');
const CATS = require('./_woo-cats.json');

const ENT = { '&amp;': '&', '&#38;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'", '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”', '&ndash;': '–', '&mdash;': '—', '&hellip;': '…', '&eacute;': 'é' };
const decode = (s = '') => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&[a-z]+;|&#\d+;/gi, (m) => ENT[m.toLowerCase()] ?? m);
const stripHtml = (h = '') => decode(h.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').split('\n').map((l) => l.trim()).join('\n').trim();
const money = (m) => Number((Number(m) / 100).toFixed(2));
// Normalise a title for matching: unify quotes/dashes, collapse ws, lowercase.
const norm = (s = '') => decode(s).replace(/[’‘']/g, "'").replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

async function mirror(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (src.split('?')[0].split('.').pop() || 'png').toLowerCase();
  const ct = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
  return uploadImage(buf, 'uploads', `${crypto.randomUUID()}.${ext}`, ct);
}

const diffs = [];
const record = (title, field, live, local) => diffs.push({ title, field, live, local });

async function main() {
  console.log(`--- Catalogue compare ${REPORT_ONLY ? '(REPORT ONLY)' : '(REPORT + FIX)'} ---\n`);

  // ---- CATEGORIES ----
  const localCats = await prisma.category.findMany();
  const localCatByNorm = new Map(localCats.map((c) => [norm(c.title), c]));
  const usedCatNames = new Set(PRODUCTS.flatMap((p) => p.categories.map((c) => decode(c.name))));

  console.log('== CATEGORIES ==');
  for (const c of CATS) {
    const name = decode(c.name);
    if (!usedCatNames.has(name)) continue;
    const local = localCatByNorm.get(norm(name));
    if (!local) { console.log(`  MISSING category: ${name}`); continue; }
    const liveImg = !!c.image?.src, localImg = !!local.image;
    const liveDesc = stripHtml(c.description) || null;
    let fixes = {};
    if (liveImg && !localImg && !REPORT_ONLY) { try { fixes.image = await mirror(c.image.src); } catch {} }
    if ((liveDesc || null) !== (local.description || null)) fixes.description = liveDesc;
    const changed = Object.keys(fixes);
    console.log(`  ${name}: image=${localImg ? 'ok' : (liveImg ? 'MISSING' : 'none')} ${changed.length ? '-> fix '+changed.join(',') : 'OK'}`);
    if (!REPORT_ONLY && changed.length) await prisma.category.update({ where: { id: local.id }, data: fixes });
  }

  // ---- PRODUCTS ----
  const localProds = await prisma.product.findMany({
    include: { images: { orderBy: { sortOrder: 'asc' } }, descriptions: { orderBy: { sortOrder: 'asc' } }, productOptions: { orderBy: { sortOrder: 'asc' } }, category: true },
  });
  const localByNorm = new Map(localProds.map((p) => [norm(p.title), p]));

  console.log('\n== PRODUCTS ==');
  let issues = 0, fixed = 0;
  const seen = new Set();

  for (const wp of PRODUCTS) {
    const title = decode(wp.name);
    const local = localByNorm.get(norm(wp.name));
    if (!local) { console.log(`  ❌ MISSING in local: ${title}`); record(title, 'exists', 'yes', 'no'); issues++; continue; }
    seen.add(local.id);

    const onSale = wp.on_sale && wp.prices.sale_price !== wp.prices.regular_price;
    const livePrice = money(onSale ? wp.prices.regular_price : wp.prices.price);
    const liveDisc = onSale ? money(wp.prices.sale_price) : null;
    const liveCat = decode(wp.categories[0]?.name || '');
    const liveSub = (stripHtml(wp.short_description).split('\n')[0] || null);
    const liveSubTrim = liveSub ? liveSub.slice(0, 250) : null;
    const liveDesc = stripHtml(wp.description) || null;
    const liveImgN = (wp.images || []).length;
    const liveOpts = (wp.attributes || []).filter((a) => a.terms?.length).map((a) => ({ title: decode(a.name), options: a.terms.map((t) => decode(t.name)) }));

    const localPrice = Number(local.price);
    const localDisc = local.discountedPrice != null ? Number(local.discountedPrice) : null;
    const localDescText = local.descriptions[0]?.description || null;
    const localOpts = local.productOptions.map((o) => ({ title: o.title, options: o.options }));

    const fix = {};
    const localIssues = [];
    if (localPrice !== livePrice) { record(title, 'price', livePrice, localPrice); fix.price = livePrice; localIssues.push(`price ${localPrice}->${livePrice}`); }
    if ((localDisc ?? null) !== (liveDisc ?? null)) { record(title, 'discountedPrice', liveDisc, localDisc); fix.discountedPrice = liveDisc; localIssues.push(`disc ${localDisc}->${liveDisc}`); }
    if (norm(local.category?.title || '') !== norm(liveCat)) { record(title, 'category', liveCat, local.category?.title); localIssues.push(`cat ${local.category?.title}->${liveCat}`); const lc = localCatByNorm.get(norm(liveCat)); if (lc) fix.categoryId = lc.id; }
    if ((local.subtitle || null) !== liveSubTrim) { record(title, 'subtitle', liveSubTrim, local.subtitle); fix.subtitle = liveSubTrim; localIssues.push('subtitle'); }
    const descDiff = (localDescText || null) !== (liveDesc || null);
    const optDiff = JSON.stringify(localOpts) !== JSON.stringify(liveOpts);
    const imgDiff = local.images.length !== liveImgN;
    if (descDiff) { record(title, 'description', (liveDesc||'').length+' chars', (localDescText||'').length+' chars'); localIssues.push('description'); }
    if (optDiff) { record(title, 'options', JSON.stringify(liveOpts), JSON.stringify(localOpts)); localIssues.push('options'); }
    if (imgDiff) { record(title, 'images', liveImgN, local.images.length); localIssues.push(`images ${local.images.length}->${liveImgN}`); }

    if (localIssues.length) {
      issues++;
      console.log(`  ⚠️  ${title}: ${localIssues.join(' | ')}`);
      if (!REPORT_ONLY) {
        if (Object.keys(fix).length) await prisma.product.update({ where: { id: local.id }, data: fix });
        if (descDiff) { await prisma.productDescription.deleteMany({ where: { productId: local.id } }); if (liveDesc) await prisma.productDescription.create({ data: { productId: local.id, description: liveDesc, sortOrder: 0 } }); }
        if (optDiff) { await prisma.productOption.deleteMany({ where: { productId: local.id } }); for (let i = 0; i < liveOpts.length; i++) await prisma.productOption.create({ data: { productId: local.id, title: liveOpts[i].title, options: liveOpts[i].options, sortOrder: i } }); }
        if (imgDiff) {
          await prisma.productImage.deleteMany({ where: { productId: local.id } });
          let ok = 0;
          for (let i = 0; i < (wp.images || []).length; i++) {
            try { const url = await mirror(wp.images[i].src); await prisma.productImage.create({ data: { productId: local.id, url, sortOrder: i } }); ok++; }
            catch (e) { console.log(`       img ${i} failed: ${e.message}`); }
          }
          console.log(`       re-mirrored ${ok}/${liveImgN} images`);
        }
        fixed++;
      }
    } else {
      console.log(`  ✓ ${title}`);
    }
  }

  // local products not on live (should be none after import)
  for (const lp of localProds) if (!seen.has(lp.id)) { console.log(`  ❓ EXTRA in local (not on live): ${lp.title}`); record(lp.title, 'extra', 'no', 'yes'); issues++; }

  // refresh counts
  if (!REPORT_ONLY) for (const c of localCats) { const n = await prisma.product.count({ where: { categoryId: c.id } }); await prisma.category.update({ where: { id: c.id }, data: { totalProducts: n } }); }

  console.log(`\n--- Summary: ${issues} product(s) with differences${REPORT_ONLY ? '' : `, ${fixed} fixed`} ---`);
  if (diffs.length) { console.log('Diff fields:'); const byField = {}; for (const d of diffs) byField[d.field] = (byField[d.field]||0)+1; console.log(byField); }
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); }).finally(() => prisma.$disconnect());
