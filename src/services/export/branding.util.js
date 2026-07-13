/**
 * Shared branding source for all export renderers: the store name and (best
 * effort) the logo image, read from Settings. Returns the logo as a buffer +
 * detected extension so each renderer can decide whether it can embed it
 * (pdfkit: png/jpeg; ExcelJS: png/jpeg/gif) — a webp logo, or a fetch failure,
 * degrades gracefully to the store-name text.
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../../config/db');

// The brand logo (mark + "amoonis boutique" wordmark) as an SVG string, bundled
// with the app and read once. Rendered into PDFs via svg-to-pdfkit — this is the
// reliable branding source since Settings.logo (a CDN URL, often webp) can't be
// embedded by pdfkit/ExcelJS. Falls back to null if the asset is missing.
let brandLogoSvgCache;
function getBrandLogoSvg() {
  if (brandLogoSvgCache !== undefined) return brandLogoSvgCache;
  try {
    brandLogoSvgCache = fs.readFileSync(path.join(__dirname, '../../assets/brand-logo.svg'), 'utf8');
  } catch {
    brandLogoSvgCache = null;
  }
  return brandLogoSvgCache;
}

function extensionFromUrl(url) {
  const m = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url || '');
  return m ? m[1].toLowerCase() : null;
}

async function getBranding() {
  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: { siteName: true, logo: true },
  });
  const siteName = settings?.siteName || 'Amoonis Boutique';

  let logo = null;
  if (settings?.logo) {
    try {
      const res = await fetch(settings.logo);
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        const ctype = res.headers.get('content-type') || '';
        let extension = extensionFromUrl(settings.logo);
        if (!extension) {
          if (ctype.includes('png')) extension = 'png';
          else if (ctype.includes('jpeg') || ctype.includes('jpg')) extension = 'jpg';
          else if (ctype.includes('gif')) extension = 'gif';
          else if (ctype.includes('webp')) extension = 'webp';
        }
        logo = { buffer, extension: extension || 'png' };
      }
    } catch {
      // Network/format issue — fall back to text-only branding.
    }
  }

  return { siteName, logo, logoSvg: getBrandLogoSvg() };
}

module.exports = { getBranding, getBrandLogoSvg };
