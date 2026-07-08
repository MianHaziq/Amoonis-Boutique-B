/**
 * Compress the client's original asset folder into a parallel "compressed"
 * folder, preserving the exact folder structure & names:
 *
 *   ~/Downloads/website data/                ->  ~/Downloads/website image compressed/
 *     website_images/<cat>/<file>.png              website_images/<cat>/<file>.webp
 *     website_banner_videos/<file>.mp4             website_banner_videos/<file>.mp4
 *
 * Images -> WebP (resize cap 1600px, q82). Videos -> H.264 CRF30, ≤1280px,
 * muted, faststart. Compressed videos are also uploaded to Bunny (for the
 * home hero/sections). Prints a per-folder + grand-total size report.
 *
 * Run:  node scripts/compress-folder.js
 */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const ffmpeg = require('ffmpeg-static');
const { uploadImage } = require('../src/services/bunnyStorage.service');

const SRC = path.join(os.homedir(), 'Downloads', 'website data');
const DEST = path.join(os.homedir(), 'Downloads', 'website image compressed');
const IMG_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const VID_RE = /\.(mp4|mov|webm|m4v|avi)$/i;
const mb = (b) => (b / 1024 / 1024).toFixed(1);

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'compressed') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push({ full, rel: path.relative(base, full) });
  }
  return out;
}

async function main() {
  if (!fs.existsSync(SRC)) { console.error('Source not found:', SRC); process.exit(1); }
  fs.mkdirSync(DEST, { recursive: true });

  const files = walk(SRC);
  const perFolder = {}; // topFolder -> {before, after, n}
  const bump = (rel, before, after) => {
    const top = rel.split(path.sep).slice(0, 2).join('/');
    (perFolder[top] ||= { before: 0, after: 0, n: 0 });
    perFolder[top].before += before; perFolder[top].after += after; perFolder[top].n++;
  };

  let tB = 0, tA = 0, nImg = 0, nVid = 0, fail = 0;
  const videoUrls = [];

  for (const { full, rel } of files) {
    try {
      if (IMG_RE.test(full)) {
        const destPath = path.join(DEST, rel).replace(IMG_RE, '.webp');
        const inBuf = fs.readFileSync(full);
        // Resumable: reuse an already-compressed output.
        if (fs.existsSync(destPath)) {
          tB += inBuf.length; tA += fs.statSync(destPath).size; nImg++; bump(rel, inBuf.length, fs.statSync(destPath).size);
        } else {
          const out = await sharp(inBuf).rotate().resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.writeFileSync(destPath, out);
          tB += inBuf.length; tA += out.length; nImg++; bump(rel, inBuf.length, out.length);
        }
      } else if (VID_RE.test(full)) {
        const destPath = path.join(DEST, rel).replace(VID_RE, '.mp4');
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        execFileSync(ffmpeg, ['-i', full, '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-crf', '30', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', '-y', destPath], { stdio: 'ignore' });
        const inSize = fs.statSync(full).size, outSize = fs.statSync(destPath).size;
        tB += inSize; tA += outSize; nVid++; bump(rel, inSize, outSize);
        // upload compressed video to Bunny for use in the hero/sections
        const url = await uploadImage(fs.readFileSync(destPath), 'videos', `${crypto.randomUUID()}.mp4`, 'video/mp4');
        videoUrls.push({ name: path.basename(full), url });
        console.log(`  video: ${path.basename(full)}  ${mb(inSize)}MB -> ${mb(outSize)}MB`);
      } else {
        // copy non-media files verbatim (rare)
        const destPath = path.join(DEST, rel);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(full, destPath);
      }
    } catch (e) { fail++; console.log(`  FAIL ${rel}: ${e.message}`); }
    if ((nImg + nVid) % 20 === 0 && (nImg + nVid) > 0) console.log(`  ...${nImg + nVid}/${files.length}`);
  }

  if (videoUrls.length) fs.writeFileSync(path.join(DEST, 'website_banner_videos', '_bunny-urls.json'), JSON.stringify(videoUrls, null, 2));

  console.log('\n===== COMPRESSION REPORT =====');
  console.log(`Output folder: ${DEST}\n`);
  console.log('Per folder:');
  for (const [k, v] of Object.entries(perFolder).sort()) {
    console.log(`  ${k.padEnd(40)} ${mb(v.before).padStart(6)}MB -> ${mb(v.after).padStart(6)}MB  (${v.n} files, ${(100 - v.after / v.before * 100).toFixed(0)}% smaller)`);
  }
  console.log(`\nImages: ${nImg} | Videos: ${nVid}${fail ? ` | Failed: ${fail}` : ''}`);
  console.log(`TOTAL:  ${mb(tB)}MB  ->  ${mb(tA)}MB   (${(100 - tA / tB * 100).toFixed(0)}% smaller, saved ${mb(tB - tA)}MB)`);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); }).finally(() => require('../src/config/db').$disconnect());
