// Attachments — photos (and later, docs) on leads + estimates.
//
// Each upload gets resized server-side into three sizes:
//   - thumbnail: 200×200 cover crop (grid view)
//   - web: 1600px max longest side, JPEG q82 (lightbox view)
//   - original: untouched bytes (download for blueprints/detail work)
//
// Storage backend is pluggable (server/storage.js). Routes don't know or
// care whether bytes land on local disk or R2.
//
// Auth: any authenticated user with LEADS_VIEW (for leads) or ESTIMATES_VIEW
// (for estimates) can read; LEADS_EDIT / ESTIMATES_EDIT to upload or delete.
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');
const { storage } = require('../storage');

const router = express.Router();

// Upload caps. Photos and documents share one pool per entity so a heavy
// drawing-heavy lead doesn't burst past a separate doc cap. Multer
// enforces the per-file ceiling; the per-entity total is checked in the
// handler since it depends on the existing row count.
const MAX_FILES_PER_ENTITY = 30;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB — fits most drawings, big PDFs
const VALID_ENTITY_TYPES = new Set(['lead', 'estimate', 'client', 'job']);

// Lightweight MIME detection — sharp only handles raster images, so
// anything outside this set bypasses the resize pipeline.
function isImageMime(mime) {
  if (!mime) return false;
  return mime.startsWith('image/') && mime !== 'image/svg+xml'; // sharp can't rasterize SVG without extra deps
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES }
});

// Authorization helper. Reads aren't gated tightly — anyone who can see
// the parent entity can see its photos. Writes require the matching
// edit capability.
function readCapForEntity(entityType) {
  if (entityType === 'estimate') return 'ESTIMATES_VIEW';
  if (entityType === 'client')   return 'ESTIMATES_VIEW';
  if (entityType === 'job')      return 'JOBS_VIEW';
  return 'LEADS_VIEW';
}
function writeCapForEntity(entityType) {
  if (entityType === 'estimate') return 'ESTIMATES_EDIT';
  if (entityType === 'client')   return 'ESTIMATES_EDIT';
  if (entityType === 'job')      return 'JOBS_EDIT';
  return 'LEADS_EDIT';
}

// Hand-rolled cap check since the cap depends on a path param. Mirrors
// the requireCapability middleware in server/auth.js.
const { hasCapability } = require('../auth');
function requireDynamicCapability(getCap) {
  return async function(req, res, next) {
    const cap = getCap(req);
    if (!cap) return res.status(400).json({ error: 'Bad entity type' });
    try {
      const ok = await hasCapability(req.user, cap);
      if (!ok) return res.status(403).json({ error: 'Forbidden' });
      next();
    } catch (e) {
      console.error('Capability check failed:', e);
      res.status(500).json({ error: 'Server error' });
    }
  };
}

function entityTypeOk(t) { return VALID_ENTITY_TYPES.has(t); }

// GET /api/attachments/:entityType/:entityId — list. Ordered by `position`
// so reorder later (drag-drop) is just a column update.
router.get('/:entityType/:entityId',
  requireAuth,
  requireDynamicCapability(req => entityTypeOk(req.params.entityType) ? readCapForEntity(req.params.entityType) : null),
  async (req, res) => {
    try {
      const { entityType, entityId } = req.params;
      const { rows } = await pool.query(
        `SELECT * FROM attachments
         WHERE entity_type = $1 AND entity_id = $2
         ORDER BY position ASC, uploaded_at ASC`,
        [entityType, entityId]
      );
      res.json({ attachments: rows });
    } catch (e) {
      console.error('GET /api/attachments error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /api/attachments/:entityType/:entityId — upload one file as form-data
// field `file`. Returns the inserted attachment row.
router.post('/:entityType/:entityId',
  requireAuth,
  requireDynamicCapability(req => entityTypeOk(req.params.entityType) ? writeCapForEntity(req.params.entityType) : null),
  upload.single('file'),
  async (req, res) => {
    try {
      const { entityType, entityId } = req.params;
      if (!req.file) return res.status(400).json({ error: 'file is required' });

      // Cap the per-entity total — keeps one runaway upload from hogging
      // storage. Done in JS since the count needs a SELECT either way.
      const countRes = await pool.query(
        'SELECT COUNT(*)::int AS c FROM attachments WHERE entity_type = $1 AND entity_id = $2',
        [entityType, entityId]
      );
      if (countRes.rows[0].c >= MAX_FILES_PER_ENTITY) {
        return res.status(400).json({ error: 'Limit of ' + MAX_FILES_PER_ENTITY + ' attachments per ' + entityType + ' reached. Delete one to upload another.' });
      }

      const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const ext = (req.file.originalname.match(/\.([a-z0-9]+)$/i) || [, 'bin'])[1].toLowerCase();
      const baseKey = entityType + '/' + entityId + '/' + id;
      const buf = req.file.buffer;
      const mime = req.file.mimetype || 'application/octet-stream';

      let thumbUrl = null, webUrl = null, originalUrl;
      let thumbKey = null, webKey = null, originalKey;
      let width = null, height = null;

      if (isImageMime(mime)) {
        // Image pipeline: resize to thumb (200×200 cover) + web (1600px max)
        // + keep original. .rotate() honors EXIF orientation so phone photos
        // stop coming in sideways; the resized variants drop EXIF entirely
        // so we don't leak GPS coords from contractor phones.
        const meta = await sharp(buf).rotate().metadata();
        width = meta.width || null;
        height = meta.height || null;
        const thumbBuf = await sharp(buf).rotate().resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
        const webBuf = await sharp(buf).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
        thumbKey = baseKey + '_thumb.jpg';
        webKey = baseKey + '_web.jpg';
        originalKey = baseKey + '_orig.' + ext;
        thumbUrl = await storage.put(thumbKey, thumbBuf, 'image/jpeg');
        webUrl = await storage.put(webKey, webBuf, 'image/jpeg');
        originalUrl = await storage.put(originalKey, buf, mime);
      } else {
        // Document pipeline: just stash the original. No thumbnail or web
        // variant — the frontend renders these as a file-icon list, not a
        // grid. Original filename's extension is preserved in the key so
        // the file downloads with the right type.
        originalKey = baseKey + '_orig.' + ext;
        originalUrl = await storage.put(originalKey, buf, mime);
      }

      // Position = current count so new uploads append to the end of the list.
      const position = countRes.rows[0].c;

      const ins = await pool.query(
        `INSERT INTO attachments
         (id, entity_type, entity_id, filename, mime_type, size_bytes,
          width, height,
          thumb_url, web_url, original_url,
          thumb_key, web_key, original_key,
          position, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [
          id, entityType, entityId,
          req.file.originalname, mime, req.file.size,
          width, height,
          thumbUrl, webUrl, originalUrl,
          thumbKey, webKey, originalKey,
          position, req.user.id
        ]
      );
      res.json({ ok: true, attachment: ins.rows[0] });
    } catch (e) {
      console.error('POST /api/attachments error:', e);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  }
);

// DELETE /api/attachments/:id — owner row + all three storage keys. We let
// storage.delete swallow not-found so partially-failed uploads don't block
// cleanup.
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM attachments WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Attachment not found' });
    const att = rows[0];

    // Capability check — same write rule as the parent entity.
    const cap = writeCapForEntity(att.entity_type);
    const ok = await hasCapability(req.user, cap);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });

    // Documents have null thumb/web keys — only delete what's actually stored.
    const keysToDelete = [att.thumb_key, att.web_key, att.original_key].filter(Boolean);
    await Promise.all(keysToDelete.map(function(k) { return storage.delete(k); }));
    await pool.query('DELETE FROM attachments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/attachments/:id error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// PUT /api/attachments/:id — update caption (and later, position via reorder).
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM attachments WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Attachment not found' });
    const att = rows[0];
    const cap = writeCapForEntity(att.entity_type);
    const ok = await hasCapability(req.user, cap);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });

    const sets = [];
    const params = [];
    let p = 1;
    if (req.body && typeof req.body.caption === 'string') {
      sets.push('caption = $' + p++);
      params.push(req.body.caption);
    }
    if (req.body && typeof req.body.position === 'number') {
      sets.push('position = $' + p++);
      params.push(req.body.position);
    }
    if (!sets.length) return res.json({ ok: true, unchanged: true });
    params.push(req.params.id);
    await pool.query(`UPDATE attachments SET ${sets.join(', ')} WHERE id = $${p}`, params);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/attachments/:id error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

module.exports = router;
