// Shared attachment byte-inspection + sanitization helpers.
//
// Extracted from attachment-routes.js (SEC P0-4) so BOTH the PM upload
// path (attachment-routes) and the sub-portal upload path
// (sub-portal-routes) run the same content sniffing + SVG sanitization
// before persisting bytes. Previously only the PM path did, so a sub
// could upload an SVG carrying <script> that executed when a PM opened
// it. Pure functions — no module state, safe to share.

// Returns the sniffed MIME or `null` when bytes don't match any
// known signature (caller decides whether to reject or accept).
function sniffMimeFromBytes(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  const b = buf;
  // Image formats (raster)
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
  if (b.length >= 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    // ISO base media (mp4, heic, etc.)
    const brand = b.slice(8, 12).toString('ascii');
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
  }
  // Vector / text image
  // SVG sniffed separately below since it's text-based.
  // Documents
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  // ZIP-based (covers .docx / .xlsx / .pptx / .zip — caller distinguishes by extension)
  if (b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04) return 'application/zip';
  // Old-format Office (.doc / .xls / .ppt — OLE compound document)
  if (b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) return 'application/x-ole-compound';
  // Plain text / CSV / SVG — peek a UTF-8 prefix
  try {
    const head = b.slice(0, Math.min(256, b.length)).toString('utf8').replace(/^﻿/, '').trimStart();
    if (/^<\?xml/i.test(head) || /^<svg\b/i.test(head)) return 'image/svg+xml';
    // No magic for plain text — caller treats null + .txt/.csv extension as "best effort accept"
  } catch (_) { /* not utf8 */ }
  return null;
}

// SVG sandbox — strip <script>, <foreignObject>, and on*= event
// attributes before storage. Pragmatic protection against XSS via
// uploaded SVG; not a full SVG security suite. For full sanitization
// run through DOMPurify on render instead of/in addition to this.
function sanitizeSvg(buf) {
  let text;
  try { text = buf.toString('utf8'); }
  catch (_) { return buf; }
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?<svg\b/i.test(text)) return buf; // not svg-shaped, leave alone
  const cleaned = text
    .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*script\b[^>]*\/?\s*>/gi, '')
    .replace(/<\s*foreignObject\b[^>]*>[\s\S]*?<\s*\/\s*foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript\s*:/gi, '');
  return Buffer.from(cleaned, 'utf8');
}

// Check whether a claimed MIME and a sniffed MIME describe the same
// file family. We allow lax matching: image/jpg ≈ image/jpeg, generic
// application/octet-stream is accepted (means client didn't claim
// anything specific), and ZIP-based MIMEs (docx/xlsx/pptx) all match
// the sniffed application/zip.
function mimeFamilyMatches(claimed, sniffed) {
  if (!sniffed) return true; // no magic match → don't reject (caller logs)
  if (!claimed || claimed === 'application/octet-stream') return true;
  const norm = (m) => String(m || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  const c = norm(claimed);
  const s = norm(sniffed);
  if (c === s) return true;
  // ZIP-based Office docs
  const officeZipMimes = new Set([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
    'application/x-zip-compressed'
  ]);
  if (s === 'application/zip' && officeZipMimes.has(c)) return true;
  // Old Office formats
  const oleMimes = new Set([
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint'
  ]);
  if (s === 'application/x-ole-compound' && oleMimes.has(c)) return true;
  // Both image — different format but both images is acceptable
  if (c.startsWith('image/') && s.startsWith('image/')) return true;
  return false;
}

module.exports = { sniffMimeFromBytes, sanitizeSvg, mimeFamilyMatches };
