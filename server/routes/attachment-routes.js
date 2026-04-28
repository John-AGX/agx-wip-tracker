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

// Upload caps. 10 photos per entity is enforced in the route handler since
// it depends on the existing row count; multer just enforces per-file size.
const MAX_FILES_PER_ENTITY = 10;
const MAX_FILE_BYTES = 12 * 1024 * 1024; // 12MB pre-resize ceiling
const VALID_ENTITY_TYPES = new Set(['lead', 'estimate']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES }
});

// Authorization helper. Reads aren't gated tightly — anyone who can see
// the parent entity can see its photos. Writes require the matching
// edit capability.
function readCapForEntity(entityType) {
  return entityType === 'estimate' ? 'ESTIMATES_VIEW' : 'LEADS_VIEW';
}
function writeCapForEntity(entityType) {
  return entityType === 'estimate' ? 'ESTIMATES_EDIT' : 'LEADS_EDIT';
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
      const ext = (req.file.originalname.match(/\.([a-z0-9]+)$/i) || [, 'jpg'])[1].toLowerCase();
      const baseKey = entityType + '/' + entityId + '/' + id;

      // Resize pipeline. .rotate() honors EXIF orientation so phone photos
      // stop coming in sideways. `withMetadata: false` strips EXIF on
      // resize variants so we don't leak GPS coords from contractor phones.
      const buf = req.file.buffer;
      const meta = await sharp(buf).rotate().metadata();
      const thumbBuf = await sharp(buf).rotate().resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
      const webBuf = await sharp(buf).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();

      const thumbKey = baseKey + '_thumb.jpg';
      const webKey = baseKey + '_web.jpg';
      const originalKey = baseKey + '_orig.' + ext;

      const thumbUrl = await storage.put(thumbKey, thumbBuf, 'image/jpeg');
      const webUrl = await storage.put(webKey, webBuf, 'image/jpeg');
      const originalUrl = await storage.put(originalKey, buf, req.file.mimetype || 'application/octet-stream');

      // Position = current count so new uploads append to the end of the grid.
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
          req.file.originalname, req.file.mimetype || 'application/octet-stream', req.file.size,
          meta.width || null, meta.height || null,
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
    const cap = att.entity_type === 'estimate' ? 'ESTIMATES_EDIT' : 'LEADS_EDIT';
    const ok = await hasCapability(req.user, cap);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });

    await Promise.all([
      storage.delete(att.thumb_key),
      storage.delete(att.web_key),
      storage.delete(att.original_key)
    ]);
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
    const cap = att.entity_type === 'estimate' ? 'ESTIMATES_EDIT' : 'LEADS_EDIT';
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
