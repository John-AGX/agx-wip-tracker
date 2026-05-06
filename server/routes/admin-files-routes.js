// Admin Files — wraps Anthropic's beta.files API for caching photos
// and documents that AG repeatedly references across chat turns.
//
// Today's slice: manual upload trigger via the admin UI. Once an
// attachment has anthropic_file_id set, a future commit can switch
// loadPhotoAsBlock (in ai-routes.js) to reference it by id instead
// of base64-encoding the bytes on every turn — that change requires
// migrating from messages.stream() to beta.messages.stream() because
// file_id image sources only work via the beta path.
//
// Endpoints:
//   POST /api/admin/files/upload-attachment/:id  upload one attachment
//   POST /api/admin/files/upload-recent          bulk upload last N image attachments
//   GET  /api/admin/files/stats                  count uploaded vs not
//
// Admin-gated by ROLES_MANAGE.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');
const { storage } = require('../storage');

const router = express.Router();

console.log('[admin-files-routes] mounted at /api/admin/files');

const { Anthropic, toFile } = require('@anthropic-ai/sdk');
let _anth = null;
function getAnthropic() {
  if (_anth) return _anth;
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return null;
  _anth = new Anthropic({ apiKey: key });
  return _anth;
}

// Internal: upload one attachment's web variant to Anthropic.
// Returns the file id (or null on failure). Persists to the row so
// repeat calls return the cached id without re-uploading.
async function uploadAttachmentToAnthropic(att) {
  if (att.anthropic_file_id) return att.anthropic_file_id;
  if (!storage.localRoot) throw new Error('storage.localRoot not configured — Files API needs the local storage backend.');
  if (!att.web_key) throw new Error('attachment has no web_key (non-image?)');
  const anthropic = getAnthropic();
  if (!anthropic) throw new Error('AI not configured (ANTHROPIC_API_KEY missing).');

  const fullPath = path.join(storage.localRoot, att.web_key);
  // toFile takes a Buffer + filename + { type } — wraps for upload.
  // Stream from disk to keep memory low when the photo is large.
  const buf = await fs.promises.readFile(fullPath);
  const filename = att.web_key.split(/[\\/]/).pop() || (att.id + '.jpg');
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

// POST /api/admin/files/upload-attachment/:id
router.post('/upload-attachment/:id', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM attachments WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Attachment not found' });
    const att = r.rows[0];
    const fileId = await uploadAttachmentToAnthropic(att);
    res.json({ ok: true, attachment_id: att.id, anthropic_file_id: fileId });
  } catch (e) {
    console.error('POST /api/admin/files/upload-attachment/:id error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// POST /api/admin/files/upload-recent  body: { limit?: number }
//   Uploads the last N image attachments that don't yet have an
//   anthropic_file_id. Default 25 — keep modest so a single click
//   doesn't drown the API or the admin's wallet. Sequential to
//   keep cost predictable.
router.post('/upload-recent', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt((req.body && req.body.limit), 10) || 25));
    const r = await pool.query(
      `SELECT * FROM attachments
        WHERE web_key IS NOT NULL
          AND anthropic_file_id IS NULL
          AND COALESCE(mime, '') LIKE 'image/%'
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit]
    );
    const results = [];
    for (const att of r.rows) {
      try {
        const fileId = await uploadAttachmentToAnthropic(att);
        results.push({ attachment_id: att.id, ok: true, anthropic_file_id: fileId });
      } catch (e) {
        results.push({ attachment_id: att.id, ok: false, error: e.message });
      }
    }
    const okCount = results.filter(x => x.ok).length;
    res.json({ uploaded: okCount, attempted: results.length, results });
  } catch (e) {
    console.error('POST /api/admin/files/upload-recent error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// GET /api/admin/files/stats
//   Image-attachment summary: how many uploaded to Anthropic vs not.
router.get('/stats', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE web_key IS NOT NULL AND COALESCE(mime,'') LIKE 'image/%') AS total_images,
         COUNT(*) FILTER (WHERE anthropic_file_id IS NOT NULL) AS uploaded,
         COUNT(*) FILTER (WHERE web_key IS NOT NULL AND COALESCE(mime,'') LIKE 'image/%' AND anthropic_file_id IS NULL) AS not_uploaded
         FROM attachments`
    );
    const row = r.rows[0] || {};
    res.json({
      total_images: Number(row.total_images || 0),
      uploaded: Number(row.uploaded || 0),
      not_uploaded: Number(row.not_uploaded || 0)
    });
  } catch (e) {
    console.error('GET /api/admin/files/stats error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

module.exports = router;
