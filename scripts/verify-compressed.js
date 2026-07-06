/**
 * Verify the compressed folder is an exact mirror of the client's original:
 * same folder names, same files in each folder (image -> .webp, video -> .mp4).
 * Reports any missing folders/files, count mismatches, or extras.
 *
 * Run:  node scripts/verify-compressed.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(os.homedir(), 'Downloads', 'website data');
const DEST = path.join(os.homedir(), 'Downloads', 'website image compressed');
const IMG_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const VID_RE = /\.(mp4|mov|webm|m4v|avi)$/i;

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'compressed') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

// Expected compressed path for an original relative path.
function expected(rel) {
  if (IMG_RE.test(rel)) return rel.replace(IMG_RE, '.webp');
  if (VID_RE.test(rel)) return rel.replace(VID_RE, '.mp4');
  return rel;
}

function main() {
  const srcFiles = walk(SRC);
  const destFiles = new Set(walk(DEST).map((r) => r.split(path.sep).join('/')));

  // Folder sets
  const srcDirs = new Set(srcFiles.map((r) => path.dirname(r).split(path.sep).join('/')));
  const destAll = walk(DEST);
  const destDirs = new Set(destAll.map((r) => path.dirname(r).split(path.sep).join('/')));

  console.log('== FOLDER CHECK ==');
  let folderMiss = 0;
  for (const d of [...srcDirs].sort()) {
    if (!destDirs.has(d)) { console.log(`  ❌ MISSING folder: ${d}`); folderMiss++; }
  }
  console.log(folderMiss ? `  ${folderMiss} folders missing` : `  ✓ all ${srcDirs.size} folders present with identical names`);

  console.log('\n== FILE CHECK (per folder) ==');
  const byFolder = {};
  for (const rel of srcFiles) {
    const folder = path.dirname(rel).split(path.sep).join('/');
    (byFolder[folder] ||= { total: 0, ok: 0, missing: [] });
    byFolder[folder].total++;
    const exp = expected(rel).split(path.sep).join('/');
    if (destFiles.has(exp)) byFolder[folder].ok++;
    else byFolder[folder].missing.push({ src: rel, exp });
  }

  let totalSrc = 0, totalOk = 0, totalMiss = 0;
  for (const [folder, v] of Object.entries(byFolder).sort()) {
    totalSrc += v.total; totalOk += v.ok; totalMiss += v.missing.length;
    const mark = v.missing.length ? '❌' : '✓';
    console.log(`  ${mark} ${folder.padEnd(40)} ${v.ok}/${v.total}`);
    for (const m of v.missing) console.log(`       MISSING: ${m.src}  ->  expected ${m.exp}`);
  }

  // Extras in DEST not derived from any SRC file
  const expectedSet = new Set(srcFiles.map((r) => expected(r).split(path.sep).join('/')));
  const extras = destAll.map((r) => r.split(path.sep).join('/')).filter((r) => !expectedSet.has(r) && !r.endsWith('_bunny-urls.json'));

  console.log('\n== SUMMARY ==');
  console.log(`  Original files:   ${totalSrc}`);
  console.log(`  Matched in dest:  ${totalOk}`);
  console.log(`  Missing:          ${totalMiss}`);
  console.log(`  Extra in dest:    ${extras.length}${extras.length ? ' -> ' + extras.slice(0, 10).join(', ') : ''}`);
  console.log(totalMiss === 0 && folderMiss === 0 ? '\n✅ EXACT MIRROR — every file is in its correct folder.' : '\n⚠️ Differences found (see above).');
}

main();
