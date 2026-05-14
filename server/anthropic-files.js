// Shared helper for the Anthropic Files cache.
//
// Single source of truth for uploading attachment rows to Anthropic's
// beta.files API and removing the cached blob when an attachment is
// deleted. Used by three callers, none of which should re-implement
// this logic:
//   - attachment-routes.js   eager upload on POST /api/attachments
//                            (fire-and-forget, runs in background)
//   - ai-routes.js           lazy fallback when a chat turn references
//                            a photo that wasn't eagerly uploaded yet
//   - admin-files-routes.js  manual "pre-warm" / bulk upload from the
//                            admin Files Cache panel
//
// The Anthropic client carries the `files-api-2025-04-14` beta header
// by default (set in ai-routes.js's getAnthropic). This module builds
// its own client to stay decoupled from ai-routes.js so background
// callers don't drag the whole AI bundle into the import graph.

const fs = require('fs');
const path = require('path');
const { Anthropic, toFile } = require('@anthropic-ai/sdk');
const { pool } = require('./db');
const { storage } = require('./storage');

let _anth = null;
function getAnthropic() {
  if (_anth) return _anth;
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return null;
  _anth = new Anthropic({
    apiKey: key,
    defaultHeaders: { 'anthropic-beta': 'files-api-2025-04-14' }
  });
  return _anth;
}

// Upload one attachment's web-variant bytes to Anthropic Files.
// Returns the file id. Idempotent: if the row already has
// anthropic_file_id we return that without re-uploading. Throws on
// any failure — eager-mode callers should swallow, lazy-mode callers
// should log and fall back to base64.
async function uploadAttachmentToAnthropic(att) {
  if (!att) throw new Error('attachment row required');
  if (att.anthropic_file_id) return att.anthropic_file_id;
  if (!att.web_key) throw new Error('attachment has no web_key (non-image or upload mid-flight)');

  const anthropic = getAnthropic();
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY not set');

  // Use the storage adapter so this works for BOTH the local-disk dev
  // backend AND the R2 production backend. Reading via getBuffer keeps
  // the call site backend-agnostic.
  let buf;
  if (storage.localRoot) {
    // Local backend has a faster direct-read path; use it when available.
    const fullPath = path.join(storage.localRoot, att.web_key);
    buf = await fs.promises.readFile(fullPath);
  } else if (typeof storage.getBuffer === 'function') {
    buf = await storage.getBuffer(att.web_key);
  } else {
    throw new Error('storage adapter exposes neither localRoot nor getBuffer');
  }
  if (!buf || !buf.length) throw new Error('storage returned empty buffer for ' + att.web_key);

  const filename = String(att.web_key).split(/[\\/]/).pop() || (att.id + '.jpg');
  const file = await toFile(buf, filename, { type: 'image/jpeg' });
  const meta = await anthropic.beta.files.upload({ file });

  await pool.query(
    `UPDATE attachments
        SET anthropic_file_id = $1, anthropic_file_uploaded_at = NOW()
      WHERE id = $2`,
    [meta.id, att.id]
  );
  return meta.id;
}

// Background-friendly variant for the eager auto-upload path. Looks
// up the attachment by id, runs the upload, swallows errors. Designed
// for setImmediate / setTimeout fire-and-forget after the HTTP
// response has gone out — failures here are non-fatal because the
// lazy path in ai-routes will catch any photo that missed eager
// upload on its first chat reference.
async function eagerUploadAttachmentById(attachmentId) {
  try {
    const r = await pool.query('SELECT * FROM attachments WHERE id = $1', [attachmentId]);
    if (!r.rows.length) return null;
    const att = r.rows[0];
    if (att.anthropic_file_id) return att.anthropic_file_id;
    // Only image-type attachments make sense to cache — non-images
    // (PDFs, docs) aren't passed as image content blocks today.
    if (!att.mime_type || !att.mime_type.startsWith('image/')) return null;
    return await uploadAttachmentToAnthropic(att);
  } catch (e) {
    console.warn('[anthropic-files] eager upload failed for', attachmentId, ':', e.message);
    return null;
  }
}

// Delete the cached blob upstream. Caller is responsible for clearing
// anthropic_file_id from the local row (or just deleting the row
// entirely, which is the typical case). Best-effort: 404 / 5xx
// failures get logged but don't throw — orphan blobs cost cents,
// blocked deletes lose data.
async function deleteAnthropicFile(fileId) {
  if (!fileId) return false;
  const anthropic = getAnthropic();
  if (!anthropic) return false;
  try {
    await anthropic.beta.files.delete(fileId);
    return true;
  } catch (e) {
    console.warn('[anthropic-files] delete failed for', fileId, ':', e.message);
    return false;
  }
}

module.exports = {
  getAnthropic,
  uploadAttachmentToAnthropic,
  eagerUploadAttachmentById,
  deleteAnthropicFile
};
