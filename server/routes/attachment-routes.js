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

// ──────────────────────────────────────────────────────────────────
// Text extraction pipeline. Runs at upload time so AG can read the
// content of a doc instead of just its filename. One extractor per
// supported family (PDF, Excel, Word, plain text); a single
// dispatcher (extractAttachmentText) routes by mime. Failures degrade
// silently — the file is still saved, AG just won't see the contents.
//
// All extractors cap at TEXT_CAP_BYTES so a 200-page RFP or a giant
// takeoff sheet can't blow up the system prompt or DB row.
// ──────────────────────────────────────────────────────────────────
const TEXT_CAP_BYTES = 50 * 1024;
function capText(text, label) {
  if (!text) return null;
  text = text.trim();
  if (!text) return null;
  if (text.length > TEXT_CAP_BYTES) {
    text = text.slice(0, TEXT_CAP_BYTES) + '\n\n[...truncated; ' + label + ' longer than ' + TEXT_CAP_BYTES + ' chars]';
  }
  return text;
}

// pdf-parse — required from the deep import path to skip the package's
// self-test on require, which tries to read a sample PDF off disk and
// crashes when bundled / sandboxed.
let pdfParse = null;
try { pdfParse = require('pdf-parse/lib/pdf-parse.js'); }
catch (e) { console.warn('[attachment-routes] pdf-parse not installed — PDF text extraction disabled'); }

let ExcelJS = null;
try { ExcelJS = require('exceljs'); }
catch (e) { console.warn('[attachment-routes] exceljs not installed — Excel text extraction disabled'); }

let mammoth = null;
try { mammoth = require('mammoth'); }
catch (e) { console.warn('[attachment-routes] mammoth not installed — Word text extraction disabled'); }

async function extractPdfText(buffer) {
  if (!pdfParse) return null;
  try {
    const result = await pdfParse(buffer, { max: 50 }); // first 50 pages
    return capText(result.text, 'PDF');
  } catch (e) {
    console.warn('[attachment-routes] PDF text extraction failed:', e.message);
    return null;
  }
}

// Excel → text. Walks every sheet, dumps each as a tab-separated grid
// preceded by `## Sheet: <name>`. Empty trailing rows/cols trimmed by
// exceljs's actualRowCount / actualColumnCount. Skips formula cells'
// .formula and uses .result instead so we get the value, not "=A1+B1".
async function extractXlsxText(buffer) {
  if (!ExcelJS) return null;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const out = [];
    wb.eachSheet(function(ws) {
      out.push('## Sheet: ' + ws.name);
      const lastCol = ws.actualColumnCount || 0;
      ws.eachRow({ includeEmpty: false }, function(row) {
        const cells = [];
        for (let c = 1; c <= lastCol; c++) {
          const cell = row.getCell(c);
          let v = cell.value;
          if (v && typeof v === 'object') {
            if (v.result !== undefined) v = v.result;       // formula cell
            else if (v.text !== undefined) v = v.text;       // rich text
            else if (v.richText) v = v.richText.map(r => r.text).join('');
            else if (v instanceof Date) v = v.toISOString().slice(0, 10);
            else v = JSON.stringify(v);
          }
          cells.push(v == null ? '' : String(v));
        }
        // Trim trailing empties so a sheet with one column of data
        // doesn't render as "value\t\t\t\t\t".
        while (cells.length && cells[cells.length - 1] === '') cells.pop();
        if (cells.length) out.push(cells.join('\t'));
      });
      out.push('');
    });
    return capText(out.join('\n'), 'spreadsheet');
  } catch (e) {
    console.warn('[attachment-routes] Excel text extraction failed:', e.message);
    return null;
  }
}

async function extractDocxText(buffer) {
  if (!mammoth) return null;
  try {
    const result = await mammoth.extractRawText({ buffer });
    return capText(result.value, 'document');
  } catch (e) {
    console.warn('[attachment-routes] Word text extraction failed:', e.message);
    return null;
  }
}

function extractPlainText(buffer) {
  try {
    return capText(buffer.toString('utf8'), 'text file');
  } catch (e) {
    return null;
  }
}

// Mime-routed dispatcher. Returns null when no extractor applies (or
// when the matched extractor failed); upload proceeds either way.
const XLSX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel'
]);
const DOCX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword'
]);
function isPlainTextMime(mime) {
  if (!mime) return false;
  return mime === 'text/plain' || mime === 'text/csv' || mime === 'text/markdown' || mime === 'application/json';
}
async function extractAttachmentText(mime, buffer) {
  if (!mime) return null;
  if (mime === 'application/pdf') return extractPdfText(buffer);
  if (XLSX_MIMES.has(mime))       return extractXlsxText(buffer);
  if (DOCX_MIMES.has(mime))       return extractDocxText(buffer);
  if (isPlainTextMime(mime))      return extractPlainText(buffer);
  return null;
}

const router = express.Router();

// Upload caps. Photos and documents share one pool per entity so a heavy
// drawing-heavy lead doesn't burst past a separate doc cap. Multer
// enforces the per-file ceiling; the per-entity total is checked in the
// handler since it depends on the existing row count.
const MAX_FILES_PER_ENTITY = 30;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB — fits most drawings, big PDFs
const VALID_ENTITY_TYPES = new Set(['lead', 'estimate', 'client', 'job', 'sub']);

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
  // Subs are part of the jobs/back-office surface — anyone with job-edit
  // rights can see the subcontractor directory + their certificates.
  if (entityType === 'sub')      return 'JOBS_VIEW';
  return 'LEADS_VIEW';
}
function writeCapForEntity(entityType) {
  if (entityType === 'estimate') return 'ESTIMATES_EDIT';
  if (entityType === 'client')   return 'ESTIMATES_EDIT';
  if (entityType === 'job')      return 'JOBS_EDIT';
  // Sub uploads (cert PDFs) require the same job-edit capability that
  // sub-routes.js uses for create/update — keeps the perm story coherent.
  if (entityType === 'sub')      return 'JOBS_EDIT_ANY';
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

// GET /api/attachments/raw/:id — stream the attachment bytes back through
// the API so the browser fetches them same-origin. Used by the photo
// markup viewer: <img crossOrigin="anonymous" src="https://attachments.
// wip-agxco.com/...">  fails when R2's CORS isn't configured to allow our
// domain, and without crossOrigin the canvas becomes tainted on draw,
// blocking toBlob(). Routing the bytes through here side-steps both
// problems.
//
// MUST be registered BEFORE the GET /:entityType/:entityId list route
// below — Express matches in declaration order, and that pattern would
// otherwise capture /raw/:id with entityType="raw" and reject it.
//
// Query: ?variant=web|original (default web — smaller / faster).
router.get('/raw/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM attachments WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const att = rows[0];

    const cap = readCapForEntity(att.entity_type);
    const ok = await hasCapability(req.user, cap);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });

    const variant = (req.query.variant || 'web').toLowerCase();
    const key = (variant === 'original' || !att.web_key) ? att.original_key : att.web_key;
    if (!key) return res.status(404).json({ error: 'No bytes for this variant' });

    const buf = await storage.getBuffer(key);
    // Variants are JPEG; originals carry their original mime type.
    const mime = (key === att.original_key) ? (att.mime_type || 'application/octet-stream') : 'image/jpeg';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buf);
  } catch (e) {
    console.error('GET /api/attachments/raw/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

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

      // Text extraction so AG can read the contents instead of just the
      // filename. Routed by mime type — PDF, Excel, Word, plain text /
      // CSV all supported. Failures degrade silently (file still saves,
      // AG just doesn't get the text).
      let extractedText = null;
      let extractedAt = null;
      try {
        extractedText = await extractAttachmentText(mime, buf);
        if (extractedText) extractedAt = new Date();
      } catch (e) {
        console.warn('[attachment-routes] extraction dispatcher threw:', e.message);
      }

      // Position = current count so new uploads append to the end of the list.
      const position = countRes.rows[0].c;

      // Optional markup linkage: form-data field `markup_of` carries the
      // source attachment id when the upload comes from the markup
      // viewer's "Save as new" path. We allow cross-entity references
      // so an estimate's markup can point at a lead's photo (the lead
      // attachments surface read-only on the estimate's Attachments
      // tab, and marking one up uploads the result into the estimate).
      // Validated only to confirm the source exists; the FK enforces
      // referential integrity beyond that.
      let markupOf = null;
      if (req.body && typeof req.body.markup_of === 'string' && req.body.markup_of.trim()) {
        const srcId = req.body.markup_of.trim();
        const srcRes = await pool.query(
          'SELECT id FROM attachments WHERE id = $1',
          [srcId]
        );
        if (srcRes.rows.length) markupOf = srcId;
      }
      // Optional include_in_proposal flag from upload (markup save dialog
      // can pre-set this on the new attachment so the user doesn't have
      // to toggle it separately).
      const includeInProposal = !!(req.body && (
        req.body.include_in_proposal === true ||
        req.body.include_in_proposal === 'true' ||
        req.body.include_in_proposal === '1'
      ));

      const ins = await pool.query(
        `INSERT INTO attachments
         (id, entity_type, entity_id, filename, mime_type, size_bytes,
          width, height,
          thumb_url, web_url, original_url,
          thumb_key, web_key, original_key,
          position, uploaded_by, extracted_text, extracted_text_at,
          markup_of, include_in_proposal)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [
          id, entityType, entityId,
          req.file.originalname, mime, req.file.size,
          width, height,
          thumbUrl, webUrl, originalUrl,
          thumbKey, webKey, originalKey,
          position, req.user.id, extractedText, extractedAt,
          markupOf, includeInProposal
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
    if (req.body && typeof req.body.include_in_proposal === 'boolean') {
      sets.push('include_in_proposal = $' + p++);
      params.push(req.body.include_in_proposal);
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

// POST /api/attachments/extract-text — backfill text extraction across
// every supported attachment that doesn't already have extracted text.
// Useful one-shot after deploying new extractors (Excel, Word, etc.)
// so existing uploaded RFPs / takeoffs / scopes become AG-readable.
// Admin-only since it touches all rows.
//
// ?force=1 re-runs even on rows that already have text.
// ?mime=application/pdf restricts to one mime family.
//
// Streams progress as plain-text lines so the request doesn't time out
// on large catalogs. Each file is fetched from storage, re-parsed, and
// the result written back. Failures are logged but don't halt the run.
router.post('/extract-text', requireAuth, async (req, res) => {
  const ok = await hasCapability(req.user, 'ROLES_MANAGE');
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const force = req.query.force === '1';
  // Mimes we have an extractor for. Used to filter the row scan so we
  // don't try to extract from images / videos / unknown types.
  const supportedMimes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain',
    'text/csv',
    'text/markdown',
    'application/json'
  ];
  const params = [];
  let where;
  if (req.query.mime) {
    params.push(req.query.mime);
    where = `mime_type = $1`;
  } else {
    params.push(supportedMimes);
    where = `mime_type = ANY($1)`;
  }
  if (!force) where += ` AND extracted_text IS NULL`;

  const { rows } = await pool.query(
    `SELECT id, original_key, filename, mime_type FROM attachments WHERE ${where} ORDER BY uploaded_at`,
    params
  );

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.write(`Found ${rows.length} file(s) to process${force ? ' (force re-run)' : ''}${req.query.mime ? ' (mime=' + req.query.mime + ')' : ''}.\n`);

  let extracted = 0, empty = 0, failed = 0;
  for (const att of rows) {
    try {
      let buf = null;
      if (storage.getBuffer) {
        buf = await storage.getBuffer(att.original_key);
      } else if (storage.localRoot) {
        const fs = require('fs');
        const path = require('path');
        const fp = path.join(storage.localRoot, att.original_key);
        buf = fs.readFileSync(fp);
      }
      if (!buf) {
        res.write(`  ✗ ${att.filename} — could not read storage\n`);
        failed++;
        continue;
      }
      const text = await extractAttachmentText(att.mime_type, buf);
      if (text) {
        await pool.query(
          `UPDATE attachments SET extracted_text = $1, extracted_text_at = NOW() WHERE id = $2`,
          [text, att.id]
        );
        res.write(`  ✓ ${att.filename} (${att.mime_type}) — ${text.length} chars\n`);
        extracted++;
      } else {
        await pool.query(
          `UPDATE attachments SET extracted_text_at = NOW() WHERE id = $1`,
          [att.id]
        );
        res.write(`  · ${att.filename} (${att.mime_type}) — no extractable text\n`);
        empty++;
      }
    } catch (e) {
      res.write(`  ✗ ${att.filename} — ${e.message}\n`);
      failed++;
    }
  }
  res.write(`\nDone. Extracted: ${extracted}, no-text: ${empty}, failed: ${failed}.\n`);
  res.end();
});

module.exports = router;
