/**
 * Content-based file-type validation (magic-byte sniffing).
 *
 * multer's fileFilter only trusts the client-declared `mimetype` header, which an
 * attacker fully controls — a non-image payload can be uploaded as `image/png`.
 * These helpers inspect the actual bytes so we store only genuine media, closing
 * the MIME-spoofing gap. Best-effort by design: we reject anything that doesn't
 * match a known signature rather than trusting the header.
 */

function startsWith(buf, bytes, offset = 0) {
  if (!buf || buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

// Detect a real image container from its magic bytes. Returns the canonical MIME
// string ('image/png' | 'image/jpeg' | 'image/gif' | 'image/webp') or null.
function detectImageMime(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  // JPEG: FF D8 FF
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // GIF: "GIF87a" / "GIF89a"
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  // WEBP: "RIFF" .... "WEBP"
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return null;
}

// Detect a real video container from its magic bytes. Returns a coarse MIME
// ('video/mp4' for ISO-BMFF MP4/MOV, 'video/webm' for Matroska/WebM,
// 'video/x-msvideo' for AVI) or null. Coarser than the image check because the
// allowed video types share containers; we only need to confirm it IS a video.
function detectVideoMime(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  // ISO Base Media (MP4, MOV, M4V…): bytes 4..7 are the 'ftyp' box type.
  if (startsWith(buf, [0x66, 0x74, 0x79, 0x70], 4)) return 'video/mp4';
  // Matroska / WebM: EBML header 1A 45 DF A3
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  // AVI: "RIFF" .... "AVI "
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x41, 0x56, 0x49, 0x20], 8)) {
    return 'video/x-msvideo';
  }
  return null;
}

module.exports = { detectImageMime, detectVideoMime };
