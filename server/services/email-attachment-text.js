// Lazily resolve (and cache) the readable text of an inbound-email attachment
// so the AI agents can read its CONTENTS via read_email_inbox — not just see a
// filename. Two tiers, cheapest first:
//   1) digital text layer (PDF text, Word, Excel, plain text) — FREE, reused
//      from the attachment upload path's extractor.
//   2) Haiku vision OCR — only for images / scanned (image-only) PDFs, and only
//      when tier 1 yields nothing. This is the "smart & cheap" posture.
//
// The result is written back to email_attachments.extracted_text so it's
// computed once. An empty string '' is stored as a "tried, nothing legible"
// marker so a text-less scan isn't re-OCR'd on every read; NULL means never
// attempted. Best-effort throughout — never throws.

const { pool } = require('../db');
const { storage } = require('../storage');
const { ocrToText } = require('./attachment-ocr');

function isImageMime(m) { return !!m && m.indexOf('image/') === 0 && m !== 'image/svg+xml'; }

// Cap stored text so one huge PDF can't bloat the row / the agent's context.
const MAX_STORE = 20000;

// row must carry at least: id, mime_type, storage_key, extracted_text.
// opts.ocr === false disables the Haiku fallback (text-layer only).
async function resolveEmailAttachmentText(row, opts) {
  opts = opts || {};
  if (!row || !row.id) return null;
  // Already resolved: '' means tried-and-empty → return null (no text).
  if (row.extracted_text != null) return row.extracted_text || null;

  let text = '';
  try {
    const buf = row.storage_key ? await storage.getBuffer(row.storage_key) : null;
    if (buf && buf.length) {
      const mime = row.mime_type || '';
      // Tier 1 — free digital text layer. Lazy-require the extractor to avoid
      // any module load-order cycle with the big route file.
      let layer = null;
      try {
        const { extractAttachmentText } = require('../routes/attachment-routes');
        if (typeof extractAttachmentText === 'function') layer = await extractAttachmentText(mime, buf);
      } catch (e) { /* extractor unavailable — fall through to OCR */ }
      if (layer && String(layer).trim()) text = String(layer);
      // Tier 2 — Haiku OCR for images / scanned PDFs with no text layer.
      if (!text && opts.ocr !== false && (isImageMime(mime) || mime === 'application/pdf')) {
        text = await ocrToText(buf, mime);
      }
    }
  } catch (e) {
    console.warn('[email-attachment-text] resolve failed for', row.id, '-', e.message);
  }

  const store = (text && text.trim()) ? String(text).slice(0, MAX_STORE) : '';
  try { await pool.query('UPDATE email_attachments SET extracted_text = $1 WHERE id = $2', [store, row.id]); }
  catch (e) { /* cache write is best-effort */ }
  return store || null;
}

module.exports = { resolveEmailAttachmentText };
