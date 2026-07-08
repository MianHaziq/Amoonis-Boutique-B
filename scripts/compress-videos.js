/**
 * Compress the client's banner/hero videos for the web and upload them to Bunny.
 * H.264, CRF 30, capped at 1280px wide, audio stripped (hero videos autoplay
 * muted), +faststart for progressive streaming. Typically ~2.5MB -> ~300-600KB.
 *
 * Writes compressed copies to <folder>/compressed/ AND uploads to Bunny under
 * /videos, printing the CDN URLs so they can be wired into the hero/sections.
 *
 * Run:  node scripts/compress-videos.js
 */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { uploadImage } = require('../src/services/bunnyStorage.service');

const SRC_DIR = path.join(os.homedir(), 'Downloads', 'website data', 'website_banner_videos');
const OUT_DIR = path.join(SRC_DIR, 'compressed');

async function main() {
  if (!fs.existsSync(SRC_DIR)) { console.error('Video folder not found:', SRC_DIR); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = fs.readdirSync(SRC_DIR).filter((f) => /\.(mp4|mov|webm|m4v)$/i.test(f));
  console.log(`Compressing ${files.length} videos...\n`);

  let before = 0, after = 0;
  const uploaded = [];

  for (const file of files) {
    const inPath = path.join(SRC_DIR, file);
    const base = file.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_');
    const outPath = path.join(OUT_DIR, `${base}.mp4`);

    execFileSync(ffmpeg, [
      '-i', inPath,
      '-vf', "scale='min(1280,iw)':-2",
      '-c:v', 'libx264', '-crf', '30', '-preset', 'slow',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-movflags', '+faststart',
      '-y', outPath,
    ], { stdio: 'ignore' });

    const inSize = fs.statSync(inPath).size;
    const outSize = fs.statSync(outPath).size;
    before += inSize; after += outSize;

    // upload compressed video to Bunny
    const buf = fs.readFileSync(outPath);
    const url = await uploadImage(buf, 'videos', `${crypto.randomUUID()}.mp4`, 'video/mp4');
    uploaded.push({ file, url, inSize, outSize });

    console.log(`  ${file}\n    ${(inSize / 1024 / 1024).toFixed(1)}MB -> ${(outSize / 1024 / 1024).toFixed(1)}MB  |  ${url}`);
  }

  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  console.log(`\nDone. ${files.length} videos.`);
  console.log(`Total: ${mb(before)}MB -> ${mb(after)}MB  (${(100 - (after / before) * 100).toFixed(0)}% smaller)`);
  fs.writeFileSync(path.join(OUT_DIR, '_bunny-urls.json'), JSON.stringify(uploaded, null, 2));
  console.log(`Bunny URLs saved to ${path.join(OUT_DIR, '_bunny-urls.json')}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
