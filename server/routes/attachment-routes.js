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
const exifr = require('exifr');
const { pool } = require('../db');
const { requireAuth, requireCapability, isAdminish } = require('../auth');
const { storage } = require('../storage');
const { eagerUploadAttachmentById, deleteAnthropicFile } = require('../anthropic-files');

// Project activity logging (lazy-required to avoid any startup-time
// circular require risk; project-routes exports recordActivity as a
// fire-and-forget helper). We only invoke this when an attachment's
// entity_type is 'project', so the existing non-project upload paths
// pay no overhead.
function recordProjectActivity(projectId, actorId, kind, detail) {
  try {
    const projectRoutes = require('./project-routes');
    if (projectRoutes && typeof projectRoutes.recordActivity === 'function') {
      projectRoutes.recordActivity(projectId, actorId, kind, detail);
    }
  } catch (e) {
    // Activity logging is best-effort. Never block the parent
    // mutation on a logging hiccup.
    console.warn('[attachments] project activity log failed (' + kind + '):', e.message);
  }
}

// ── Photo geolocation helpers ──────────────────────────────────────
//
// extractExifGps(buf, mime) — reads EXIF GPS + DateTimeOriginal from
// raw image bytes. Returns { lat, lng, taken_at } or null if any
// piece is missing. Uses exifr — more robust than sharp's metadata
// for the GPS subtag tree, and handles the various wonky vendor
// extensions iPhones + Androids emit. Failures degrade silently —
// the photo still saves; it just has no geo data.
//
// pickGeoSource(client, exif) — reconciliation when both upload paths
// produced coords. Rules:
//   - Client-posted coords win when accuracy ≤ 50m (real-time fix
//     from the device is usually fresher than what the JPEG embedded)
//   - Otherwise pick whichever has the smaller accuracy
//   - If only one source has coords, use that one
//   - Returns { lat, lng, geo_accuracy, geo_source } or null
//
// Both helpers normalize lat to [-90, 90] and lng to [-180, 180].
// Out-of-range or NaN inputs produce null.
async function extractExifGps(buf, mime) {
  if (!buf || !mime || !/^image\//i.test(mime)) return null;
  try {
    // Whitelist exactly the EXIF tags we care about so exifr doesn't
    // walk the whole IFD tree (faster + smaller memory).
    const data = await exifr.parse(buf, {
      pick: ['GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef',
             'GPSHPositioningError', 'DateTimeOriginal', 'CreateDate']
    });
    if (!data) return null;
    // exifr.parse returns lat/lng already in decimal degrees when the
    // GPS subtags are present + reference is parseable. Some camera
    // apps drop the GPS sub-IFD entirely; data.GPSLatitude will be
    // undefined and we bail.
    let lat = (typeof data.latitude === 'number') ? data.latitude
            : (typeof data.GPSLatitude === 'number') ? data.GPSLatitude : null;
    let lng = (typeof data.longitude === 'number') ? data.longitude
            : (typeof data.GPSLongitude === 'number') ? data.GPSLongitude : null;
    // The cleaner shortcut — exifr exposes `latitude`/`longitude` as
    // decimal-degree convenience props on top of the raw GPSLatitude
    // arrays. Use it when present.
    if (lat == null || lng == null) {
      const gps = await exifr.gps(buf).catch(() => null);
      if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
        lat = gps.latitude;
        lng = gps.longitude;
      }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    const accuracy = Number.isFinite(data.GPSHPositioningError) ? Number(data.GPSHPositioningError) : null;
    let takenAt = null;
    const d = data.DateTimeOriginal || data.CreateDate;
    if (d) {
      const t = (d instanceof Date) ? d : new Date(d);
      if (!isNaN(t.getTime())) takenAt = t;
    }
    return { lat, lng, geo_accuracy: accuracy, taken_at: takenAt };
  } catch (e) {
    // EXIF parse failures are normal — many images don't have GPS, or
    // exifr's parser doesn't understand a vendor tag. Don't log every
    // one; only log when something unexpected (not "no GPS found")
    // bubbles up.
    if (e && e.message && !/gps/i.test(e.message)) {
      console.warn('[attachments] EXIF parse failed:', e.message);
    }
    return null;
  }
}

function pickGeoSource(client, exif) {
  const hasClient = client && Number.isFinite(client.lat) && Number.isFinite(client.lng);
  const hasExif = exif && Number.isFinite(exif.lat) && Number.isFinite(exif.lng);
  if (!hasClient && !hasExif) return null;
  if (hasClient && !hasExif) {
    return { lat: client.lat, lng: client.lng, geo_accuracy: client.geo_accuracy, geo_source: 'device' };
  }
  if (!hasClient && hasExif) {
    return { lat: exif.lat, lng: exif.lng, geo_accuracy: exif.geo_accuracy, geo_source: 'exif' };
  }
  // Both present — client wins if its accuracy is good (≤50m), else
  // whichever has the smaller accuracy.
  if (Number.isFinite(client.geo_accuracy) && client.geo_accuracy <= 50) {
    return { lat: client.lat, lng: client.lng, geo_accuracy: client.geo_accuracy, geo_source: 'device' };
  }
  const cA = Number.isFinite(client.geo_accuracy) ? client.geo_accuracy : Infinity;
  const eA = Number.isFinite(exif.geo_accuracy) ? exif.geo_accuracy : Infinity;
  if (eA < cA) {
    return { lat: exif.lat, lng: exif.lng, geo_accuracy: exif.geo_accuracy, geo_source: 'exif' };
  }
  return { lat: client.lat, lng: client.lng, geo_accuracy: client.geo_accuracy, geo_source: 'device' };
}

// Parse the upload body's client-posted geo fields. The mobile
// upload form sends these as form-data strings; the JSON copy/move
// path sends them as numbers. Either way, normalize to numbers.
function readClientGeoFromBody(body) {
  if (!body) return null;
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const acc = Number(body.geo_accuracy);
  return { lat, lng, geo_accuracy: Number.isFinite(acc) ? acc : null };
}

// Sanitize a folder name / path. Allows `/` as a subfolder separator
// (max 3 levels deep, segments max 60 chars). Empty → 'general'.
// Mirror of js/my-files.js sanitizeFolder — keep these in lockstep
// so a client-built path is never rejected server-side.
function sanitizeFolderPath(raw) {
  const str = String(raw || '').trim().slice(0, 180);
  const segs = str.split('/')
    .map(s => s.trim().slice(0, 60).toLowerCase()
      .replace(/[^a-z0-9 _\-]/g, '').replace(/\s+/g, '-'))
    .filter(Boolean)
    .slice(0, 3);
  return segs.join('/') || 'general';
}

// Bump the org_tags catalog every time a tag string is added to an
// attachment. Idempotent via the (organization_id, name) UNIQUE
// constraint — INSERT ... ON CONFLICT DO UPDATE bumps use_count for
// existing rows. Best-effort; failures are logged but don't block
// the tag write that triggered them.
async function upsertOrgTags(orgId, tagNames, actorUserId) {
  if (!orgId || !Array.isArray(tagNames) || !tagNames.length) return;
  // Dedupe + clean inside this function so callers don't have to.
  // Preserve case but dedup case-insensitively so a user can't bloat
  // the catalog with "trim", "Trim", "TRIM".
  const seen = new Set();
  const clean = [];
  for (let i = 0; i < tagNames.length; i++) {
    const v = tagNames[i];
    if (typeof v !== 'string') continue;
    const c = v.trim().slice(0, 32);
    if (!c) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(c);
  }
  if (!clean.length) return;
  // Single multi-row INSERT for efficiency. ON CONFLICT targets the
  // case-insensitive expression index (idx_org_tags_ci_name in
  // db.js) so "Trim Carpentry" entered when "trim carpentry" already
  // exists bumps the existing row's use_count rather than creating a
  // dup. The pre-existing case-sensitive UNIQUE(org_id, name) on
  // org_tags also prevents exact dups; the expression index just
  // adds the case-insensitive layer on top.
  const placeholders = clean.map(function(_, i) {
    return '($1, $' + (i + 3) + ', $2)';
  }).join(', ');
  const params = [orgId, actorUserId || null].concat(clean);
  try {
    await pool.query(
      'INSERT INTO org_tags (organization_id, created_by, name) VALUES ' +
      placeholders +
      ' ON CONFLICT (organization_id, (LOWER(name))) DO UPDATE ' +
      '   SET use_count = org_tags.use_count + 1, updated_at = NOW()',
      params
    );
  } catch (e) {
    console.warn('[attachments] org_tags upsert failed:', e.message);
  }
}
// Resolve the org id for an attachment by sniffing its entity. Used
// in PATCH/POST/bulk-tag so we can route tag writes into the
// caller's org catalog. Returns null when no org can be inferred
// (e.g., legacy rows or system-level uploads).
async function resolveAttachmentOrg(req) {
  return req.user && req.user.organization_id ? Number(req.user.organization_id) : null;
}

// Normalize a tags-input from form-data or JSON body. Accepts:
//   - Array of strings (best — JSON body)
//   - JSON-stringified array (form-data field)
//   - Comma-separated string (mobile fallback)
// Returns a deduped lowercase array, max 20 entries of 32 chars.
function normalizeTagsInput(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string' && raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try { arr = JSON.parse(trimmed); } catch (e) { arr = []; }
    } else {
      arr = trimmed.split(',');
    }
  }
  // Preserve the user's input case ("Trim Carpentry" stays "Trim
  // Carpentry", not "trim carpentry"). Dedup is case-INSENSITIVE so
  // ["Foo", "foo"] still collapses to one entry — keeping whichever
  // case showed up first.
  const seen = new Set();
  const out = [];
  for (let i = 0; i < arr.length && out.length < 20; i++) {
    const v = arr[i];
    if (typeof v !== 'string') continue;
    const c = v.trim().slice(0, 32);
    if (!c) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Normalize an annotations-input. Accepts the array directly (JSON
// body) or a JSON-stringified array (form-data). Caps at 200 strokes
// — anything beyond that is almost certainly a bug or DOS attempt.
function normalizeAnnotationsInput(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string' && raw) {
    try { arr = JSON.parse(raw); } catch (e) { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter(function(s) { return s && typeof s === 'object' && typeof s.tool === 'string'; }).slice(0, 200);
}

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
const MAX_FILES_PER_ENTITY = 100;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB — fits most drawings, big PDFs
// 'user' represents the personal-files folder per user. The entity_id
// for a user-type attachment is the stringified users.id of the owner;
// only that user (or an admin) can read/write rows in their bucket.
//
// 'org' is the company-wide knowledge base — accessible to every user
// in the organization for reads; admin-tier capability gates writes.
// The entity_id for an org-type attachment is the stringified
// organizations.id; uploads here become part of the org-wide context
// that 86's search_org_kb tool draws from.
// 'project' is the CompanyCam-style photo bucket. entity_id is the
// projects.id string; reads are allowed for any user in the project's
// org, writes follow LEADS_EDIT (projects belong to the sales/job
// lifecycle and edit rights track that, not a separate capability).
// 'task' is the to-do / task entity (server/routes/tasks-routes.js).
// entity_id is the tasks.id string; task photos/attachments (e.g. a
// punch-list defect photo) attach here. Reads allowed for any user in
// the task's org; writes track the same TASKS capability the task
// routes enforce.
const VALID_ENTITY_TYPES = new Set(['lead', 'estimate', 'client', 'job', 'sub', 'user', 'org', 'project', 'task']);

// Lightweight MIME detection — sharp only handles raster images, so
// anything outside this set bypasses the resize pipeline.
function isImageMime(mime) {
  if (!mime) return false;
  return mime.startsWith('image/') && mime !== 'image/svg+xml'; // sharp can't rasterize SVG without extra deps
}

// ─────────────────────────────────────────────────────────────────
// Magic-byte MIME sniffing — security defense against MIME spoofing.
// Multer trusts the client's `Content-Type` header; an attacker can
// upload `evil.html` with `Content-Type: image/png` and the file
// lands on R2 with our trusted MIME header. Other users download
// the file with that header, and some browsers will sniff/render it
// as HTML based on extension. We defend by checking the first ~12
// bytes of the buffer against well-known magic signatures and
// rejecting when the claimed MIME family disagrees with the actual.
//
// We don't depend on `file-type` npm package — coverage of the
// dozen-or-so formats we actually accept is ~30 LOC inline.
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
  // Job reads accept either the all-jobs view cap or the assigned-only
  // cap. Returning a space-separated list is the convention used in
  // report-routes / qb-cost-routes — see requireDynamicCapability below
  // for the OR-match logic.
  if (entityType === 'job')      return 'JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED JOBS_EDIT_ANY JOBS_EDIT_OWN';
  if (entityType === 'sub')      return 'JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED JOBS_EDIT_ANY JOBS_EDIT_OWN';
  // Personal-files bucket. Capability is universal so authenticated
  // users can land on their own folder; the ownership check below
  // (ensureUserAttachmentOwner) enforces "only you can see your own".
  if (entityType === 'user')     return '__owner__';
  // Org-wide knowledge base — every authenticated user in the org
  // can READ the company files; per-row org_id scoping (enforced by
  // ensureOrgAttachmentScope below) keeps tenants isolated. Writes
  // are gated separately by writeCapForEntity.
  if (entityType === 'org')      return '__org_member__';
  // Projects are sales/job-lifecycle buckets — reads follow the same
  // posture as leads (anyone on the team can see; org isolation is
  // enforced by the project's row org_id elsewhere).
  if (entityType === 'project')  return 'LEADS_VIEW';
  return 'LEADS_VIEW';
}
function writeCapForEntity(entityType) {
  if (entityType === 'estimate') return 'ESTIMATES_EDIT';
  if (entityType === 'client')   return 'ESTIMATES_EDIT';
  // Job writes — JOBS_EDIT was never a real capability (only _ANY and
  // _OWN exist), so the prior single-cap lookup 403'd for every user
  // and broke .xlsx / .docx / generic file uploads attached to a job
  // chat. Accept either edit-tier cap; per-job ownership is enforced
  // upstream by the canEdit() helper in job-routes for the row itself.
  if (entityType === 'job')      return 'JOBS_EDIT_ANY JOBS_EDIT_OWN';
  // Sub uploads (cert PDFs) — same shape; allow OWN-tier too because
  // PMs who own a job often handle their sub paperwork.
  if (entityType === 'sub')      return 'JOBS_EDIT_ANY JOBS_EDIT_OWN';
  // Same owner-only model as the read side.
  if (entityType === 'user')     return '__owner__';
  // Company knowledge base — admin-tier only. Plain users can READ
  // (via the __org_member__ sentinel on the read side) but the
  // bucket is curated by admins so it doesn\'t accumulate noise.
  if (entityType === 'org')      return 'USERS_MANAGE ROLES_MANAGE SYSTEM_ADMIN';
  // Project uploads — anyone with lead-edit capability can drop photos
  // into a project. This is a sales/walk-through bucket; gating it
  // tighter (e.g. behind a per-project ACL) was considered overkill
  // for the v1 ship.
  if (entityType === 'project')  return 'LEADS_EDIT';
  return 'LEADS_EDIT';
}

// Owner gate for user-type attachments. The user can only operate on
// their own bucket; admins can operate on anyone's. Returns true if
// allowed, false otherwise. Caller is responsible for the 403.
function ensureUserAttachmentOwner(req, entityId) {
  if (!req.user) return false;
  if (isAdminish(req.user)) return true;
  return String(entityId) === String(req.user.id);
}

// Org-bucket scope gate. The entity_id for an 'org' attachment is the
// organizations.id; this guard makes sure the caller is a member of
// THAT specific org (cross-tenant access blocked even for non-admins
// who somehow obtained another org\'s id). System admins bypass.
function ensureOrgAttachmentScope(req, entityId) {
  if (!req.user) return false;
  if (req.user.role === 'system_admin') return true;
  const callerOrg = req.user.organization_id;
  if (!callerOrg) return false;
  return String(entityId) === String(callerOrg);
}

// Hand-rolled cap check since the cap depends on a path param. Mirrors
// the requireCapability middleware in server/auth.js — and like the
// OR-style usage in report-routes / qb-cost-routes, accepts a single
// cap OR a space-separated list. ANY match passes.
const { hasCapability } = require('../auth');
function requireDynamicCapability(getCap) {
  return async function(req, res, next) {
    const cap = getCap(req);
    if (!cap) return res.status(400).json({ error: 'Bad entity type' });
    try {
      // Owner sentinel — used by the user-type bucket. Skips the
      // role/cap check; the route body still has to do the per-row
      // owner verification via ensureUserAttachmentOwner.
      if (cap === '__owner__') {
        const entityType = req.params.entityType;
        const entityId = req.params.entityId;
        if (entityType === 'user') {
          if (!ensureUserAttachmentOwner(req, entityId)) {
            return res.status(403).json({ error: 'Forbidden' });
          }
        }
        return next();
      }
      // Org-member sentinel — used by the company knowledge base
      // (entity_type='org') on the READ side. Any authenticated user
      // whose organization matches the entity_id is allowed.
      if (cap === '__org_member__') {
        if (!ensureOrgAttachmentScope(req, req.params.entityId)) {
          return res.status(403).json({ error: 'Forbidden' });
        }
        return next();
      }
      // Split on whitespace so "JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED" reads
      // as "any of these grants access". Single-cap callers still work
      // because the split yields a one-element array.
      const caps = String(cap).split(/\s+/).filter(Boolean);
      let ok = false;
      for (const c of caps) {
        if (await hasCapability(req.user, c)) { ok = true; break; }
      }
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
// project86.net/...">  fails when R2's CORS isn't configured to allow our
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
    if (cap === '__owner__') {
      if (!ensureUserAttachmentOwner(req, att.entity_id)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else {
      const ok = await hasCapability(req.user, cap);
      if (!ok) return res.status(403).json({ error: 'Forbidden' });
    }

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
      // LEFT JOIN users so the client can render the uploader's name
      // (initials chip on photo tiles in the Projects feed). Existing
      // callers were spreading the attachment row directly; the new
      // uploaded_by_name column is additive — no consumer breakage.
      const { rows } = await pool.query(
        `SELECT a.*, u.name AS uploaded_by_name
           FROM attachments a
           LEFT JOIN users u ON u.id = a.uploaded_by
          WHERE a.entity_type = $1 AND a.entity_id = $2
          ORDER BY a.position ASC, a.uploaded_at ASC`,
        [entityType, entityId]
      );
      res.json({ attachments: rows });
    } catch (e) {
      console.error('GET /api/attachments error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /api/attachments/tags/suggest?entity_type=project&entity_id=<id>&q=<prefix>
// Autocomplete for the photo tag editor. Returns distinct tags across
// the entity's attachments matching the prefix. Scoped to the entity
// so the user sees a relevant tag history rather than the org-wide
// firehose.
router.get('/tags/suggest', requireAuth, async (req, res) => {
  try {
    const entityType = String(req.query.entity_type || '').trim();
    const entityId = String(req.query.entity_id || '').trim();
    if (!entityType || !entityId) {
      return res.status(400).json({ error: 'entity_type and entity_id are required' });
    }
    if (!entityTypeOk(entityType)) {
      return res.status(400).json({ error: 'Invalid entity_type' });
    }
    // Same capability gate as the per-entity attachments list — if
    // you can see the attachments, you can see their tags.
    const cap = readCapForEntity(entityType);
    if (cap !== '__owner__' && cap !== '__org_member__') {
      const ok = await hasCapability(req.user, cap);
      if (!ok) return res.status(403).json({ error: 'Forbidden' });
    }
    const q = String(req.query.q || '').trim().toLowerCase();
    const sql =
      'SELECT DISTINCT t AS tag ' +
      '  FROM attachments a, jsonb_array_elements_text(a.tags) AS t ' +
      ' WHERE a.entity_type = $1 AND a.entity_id = $2 ' +
      (q ? '   AND t ILIKE $3 ' : '') +
      ' ORDER BY tag ' +
      ' LIMIT 30';
    const params = q ? [entityType, entityId, q + '%'] : [entityType, entityId];
    const { rows } = await pool.query(sql, params);
    res.json({ tags: rows.map(function(r) { return r.tag; }) });
  } catch (e) {
    console.error('GET /api/attachments/tags/suggest error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/attachments/bulk-tag
// Body: { ids: [string], add?: [string], remove?: [string] }
// Apply tag adds/removes to many attachments in one round-trip. All
// ids must belong to the SAME entity (entity_type + entity_id) — we
// enforce capability + ownership via the first row's entity then
// confirm the rest match it. Caps each attachment to 20 tags.
router.post('/bulk-tag', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const ids = Array.isArray(body.ids) ? body.ids.filter(function(x) { return typeof x === 'string' && x; }) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    if (ids.length > 200) return res.status(400).json({ error: 'too many ids (max 200)' });

    function clean(arr) {
      if (!Array.isArray(arr)) return [];
      const seen = new Set();
      const out = [];
      for (let i = 0; i < arr.length && out.length < 20; i++) {
        const v = arr[i];
        if (typeof v !== 'string') continue;
        const c = v.trim().toLowerCase().slice(0, 32);
        if (!c || seen.has(c)) continue;
        seen.add(c);
        out.push(c);
      }
      return out;
    }
    const add = clean(body.add);
    const remove = clean(body.remove);
    if (!add.length && !remove.length) return res.status(400).json({ error: 'nothing to do' });

    const { rows } = await pool.query(
      'SELECT id, entity_type, entity_id, tags, filename FROM attachments WHERE id = ANY($1::text[])',
      [ids]
    );
    if (rows.length !== ids.length) {
      return res.status(404).json({ error: 'One or more attachments not found' });
    }
    // All must share the same entity for the cap check.
    const firstType = rows[0].entity_type;
    const firstId = rows[0].entity_id;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].entity_type !== firstType || rows[i].entity_id !== firstId) {
        return res.status(400).json({ error: 'All attachments must belong to the same entity' });
      }
    }

    const cap = writeCapForEntity(firstType);
    if (cap === '__owner__') {
      if (!ensureUserAttachmentOwner(req, firstId)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else {
      const ok = await hasCapability(req.user, cap);
      if (!ok) return res.status(403).json({ error: 'Forbidden' });
    }

    // Apply per-row: union of (prior + add) - remove, capped at 20.
    const updates = [];
    for (let i = 0; i < rows.length; i++) {
      const prior = Array.isArray(rows[i].tags) ? rows[i].tags : [];
      const next = [];
      const seen = new Set();
      function push(t) {
        if (!t || seen.has(t) || next.length >= 20) return;
        if (remove.indexOf(t) !== -1) return;
        seen.add(t);
        next.push(t);
      }
      prior.forEach(push);
      add.forEach(push);
      const priorJson = JSON.stringify(prior);
      const nextJson = JSON.stringify(next);
      if (priorJson === nextJson) continue;
      updates.push({ id: rows[i].id, next: nextJson, prior: prior, filename: rows[i].filename });
    }
    if (!updates.length) return res.json({ ok: true, changed: 0 });

    // Single query with CASE — avoids N round-trips.
    const ids2 = updates.map(function(u) { return u.id; });
    await Promise.all(updates.map(function(u) {
      return pool.query('UPDATE attachments SET tags = $1::jsonb WHERE id = $2', [u.next, u.id]);
    }));

    // Activity log for project entities + bump the org_tags catalog
    // for any newly-added tag values across the batch.
    const catalogTags = new Set();
    if (firstType === 'project') {
      updates.forEach(function(u) {
        const nextArr = JSON.parse(u.next);
        const addedHere = nextArr.filter(function(t) { return u.prior.indexOf(t) === -1; });
        const removedHere = u.prior.filter(function(t) { return nextArr.indexOf(t) === -1; });
        addedHere.forEach(function(t) { catalogTags.add(t); });
        if (addedHere.length || removedHere.length) {
          recordProjectActivity(firstId, req.user.id, 'photo_tags_changed', {
            attachment_id: u.id,
            filename: u.filename,
            added: addedHere,
            removed: removedHere
          });
        }
      });
    } else {
      // Non-project entities still benefit from catalog discovery.
      updates.forEach(function(u) {
        const nextArr = JSON.parse(u.next);
        nextArr.filter(function(t) { return u.prior.indexOf(t) === -1; })
               .forEach(function(t) { catalogTags.add(t); });
      });
    }
    // Bulk-tag also honors skip_catalog. When set, every tag in this
    // batch stays local to the attachments and doesn't pollute the
    // org-wide suggestion catalog.
    if (catalogTags.size && !req.body.skip_catalog) {
      upsertOrgTags(req.user && req.user.organization_id, Array.from(catalogTags), req.user && req.user.id);
    }

    res.json({ ok: true, changed: updates.length, ids: ids2 });
  } catch (e) {
    console.error('POST /api/attachments/bulk-tag error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/attachments/recent?limit=10
// Cross-entity recent uploads — drives the "Recent Files" summary
// widget. Returns the most recently uploaded attachments any
// authenticated user can see, capped at 24 to keep payload small.
// We don't enforce per-entity capability filtering here because the
// widget is a discovery surface; the entity-level read still gates
// the deeper view if the user can't actually open a job/lead/etc.
router.get('/recent', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(24, Math.max(1, parseInt(req.query.limit, 10) || 10));
    // Wave A (A1): scope to the caller's org. Attachments are polymorphic
    // (9 entity types), so rather than a casted per-type union we scope by the
    // UPLOADER's org (uploaded_by -> users.organization_id) — correct for a
    // "recent uploads" discovery widget. LEFT JOIN + OR-IS-NULL (org tolerance)
    // keeps it a no-op for AGX today (un-stamped / system uploads still show);
    // tighten by dropping the IS NULL clause once data is fully org-stamped.
    const orgId = req.user.organization_id;
    const { rows } = await pool.query(
      `SELECT a.id, a.entity_type, a.entity_id, a.filename, a.mime_type, a.size_bytes,
              a.thumb_url, a.web_url, a.original_url, a.folder, a.uploaded_at, a.uploaded_by
         FROM attachments a
         LEFT JOIN users u ON u.id = a.uploaded_by
        WHERE (u.organization_id = $2 OR u.organization_id IS NULL)
        ORDER BY a.uploaded_at DESC
        LIMIT $1`,
      [limit, orgId]
    );
    res.json({ attachments: rows });
  } catch (e) {
    console.error('GET /api/attachments/recent error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});


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
      let buf = req.file.buffer;
      const claimedMime = req.file.mimetype || 'application/octet-stream';

      // MIME-spoof defense — sniff magic bytes and reject if they
      // contradict the client's claimed Content-Type. Without this,
      // an attacker can upload evil.html as image/png and other users
      // download it with our trusted MIME header set (some browsers
      // sniff/render as HTML). sniffMimeFromBytes returns null for
      // unrecognized formats — we accept those (plain text/csv/etc).
      const sniffedMime = sniffMimeFromBytes(buf);
      if (!mimeFamilyMatches(claimedMime, sniffedMime)) {
        console.warn('[attachment-routes] MIME spoof rejected',
          'claimed:', claimedMime, 'actual:', sniffedMime,
          'filename:', req.file.originalname,
          'entity:', entityType + '/' + entityId,
          'user:', req.user && req.user.id);
        return res.status(400).json({
          error: 'File content does not match its declared type. ' +
            'Claimed: ' + claimedMime + ', actual: ' + (sniffedMime || 'unknown') + '.'
        });
      }

      // If the sniffed MIME differs cosmetically (e.g. client claimed
      // image/jpg, real is image/jpeg), use the canonical sniffed value
      // for storage so downloads serve with the correct header.
      const mime = sniffedMime || claimedMime;

      // SVG sandbox — scrub <script>, <foreignObject>, on*= handlers,
      // and javascript: URIs before storage. Prevents stored XSS via
      // user-uploaded SVGs rendered by other users' browsers.
      if (mime === 'image/svg+xml') {
        buf = sanitizeSvg(buf);
      }

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

      // Photo geolocation — reconcile EXIF GPS (server-extracted from
      // the original bytes BEFORE the EXIF-stripping resize pipeline
      // runs) with any device coords the client posted in the upload
      // body. See extractExifGps + pickGeoSource at the top of the
      // file for the reconciliation rules.
      const exifGeo = await extractExifGps(buf, mime);
      const clientGeo = readClientGeoFromBody(req.body);
      const geo = pickGeoSource(clientGeo, exifGeo);
      const lat = geo ? geo.lat : null;
      const lng = geo ? geo.lng : null;
      const geoAccuracy = geo ? geo.geo_accuracy : null;
      const geoSource = geo ? geo.geo_source : null;
      // taken_at: prefer EXIF DateTimeOriginal if present, else null
      // (will fall back to uploaded_at in the GET response shape).
      const takenAt = (exifGeo && exifGeo.taken_at) ? exifGeo.taken_at : null;

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

      // Optional folder — same sanitize rules as the PUT/move handlers.
      // Falls back to the column default ('general') when absent.
      // Supports `/`-delimited subfolder paths (max 3 levels deep).
      let folder = 'general';
      if (req.body && typeof req.body.folder === 'string' && req.body.folder.trim()) {
        folder = sanitizeFolderPath(req.body.folder);
      }

      // Walkthrough upload (Phase 1.7): caller can pre-fill caption /
      // tags / annotations in the SAME request so a guided upload
      // doesn't need a follow-up PATCH per field. All three are
      // optional and validated like their dedicated endpoints.
      let initialCaption = null;
      if (req.body && typeof req.body.caption === 'string') {
        initialCaption = req.body.caption.slice(0, 2000);
      }
      const initialTags = (req.body && req.body.tags != null) ? normalizeTagsInput(req.body.tags) : [];
      const initialAnnotations = (req.body && req.body.annotations != null) ? normalizeAnnotationsInput(req.body.annotations) : [];

      const ins = await pool.query(
        `INSERT INTO attachments
         (id, entity_type, entity_id, filename, mime_type, size_bytes,
          width, height,
          thumb_url, web_url, original_url,
          thumb_key, web_key, original_key,
          position, uploaded_by, extracted_text, extracted_text_at,
          markup_of, include_in_proposal, folder,
          caption, tags, annotations,
          lat, lng, geo_accuracy, geo_source, taken_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24::jsonb,$25,$26,$27,$28,$29)
         RETURNING *`,
        [
          id, entityType, entityId,
          req.file.originalname, mime, req.file.size,
          width, height,
          thumbUrl, webUrl, originalUrl,
          thumbKey, webKey, originalKey,
          position, req.user.id, extractedText, extractedAt,
          markupOf, includeInProposal, folder,
          initialCaption,
          JSON.stringify(initialTags),
          JSON.stringify(initialAnnotations),
          lat, lng, geoAccuracy, geoSource, takenAt
        ]
      );
      res.json({ ok: true, attachment: ins.rows[0] });

      // Project activity: log every new photo so the timeline reflects
      // it. detail.filename + count let the feed render "John added 3
      // photos" instead of three separate rows when the renderer
      // collapses bursts.
      if (entityType === 'project') {
        recordProjectActivity(entityId, req.user.id, 'photo_added', {
          attachment_id: id,
          filename: req.file.originalname,
          mime: mime,
          tag_count: initialTags.length,
          annotation_count: initialAnnotations.length,
          has_caption: !!initialCaption
        });
      }

      // Bump the org-level tag catalog for any tags the upload carried.
      if (initialTags.length) {
        upsertOrgTags(req.user && req.user.organization_id, initialTags, req.user && req.user.id);
      }

      // Eager push to the Anthropic Files cache for image attachments
      // so 86's first chat reference doesn't pay an upload latency
      // hit. Runs AFTER the response is sent so the upload-confirm
      // round-trip stays fast — the user sees their photo in the
      // grid as soon as multer + the resize pipeline finish, and the
      // Anthropic Files upload happens in the background. The lazy
      // fallback in ai-routes.js catches anything that misses (e.g.
      // server restart between INSERT and upload).
      if (mime && mime.startsWith('image/')) {
        setImmediate(() => {
          eagerUploadAttachmentById(id).catch(e => {
            console.warn('[attachments POST] background Anthropic Files upload failed for', id, ':', e.message);
          });
        });
      }
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
    if (cap === '__owner__') {
      if (!ensureUserAttachmentOwner(req, att.entity_id)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else {
      const ok = await hasCapability(req.user, cap);
      if (!ok) return res.status(403).json({ error: 'Forbidden' });
    }

    // Documents have null thumb/web keys — only delete what's actually stored.
    const keysToDelete = [att.thumb_key, att.web_key, att.original_key].filter(Boolean);
    await Promise.all(keysToDelete.map(function(k) { return storage.delete(k); }));

    // Clean up the Anthropic Files cache entry if this attachment was
    // cached. Best-effort — failures are logged but don't block the
    // local delete (orphan blobs are cheap; blocked deletes lose data).
    if (att.anthropic_file_id) {
      await deleteAnthropicFile(att.anthropic_file_id);
    }

    await pool.query('DELETE FROM attachments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });

    if (att.entity_type === 'project') {
      recordProjectActivity(att.entity_id, req.user.id, 'photo_removed', {
        attachment_id: att.id,
        filename: att.filename
      });
    }
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
    if (cap === '__owner__') {
      if (!ensureUserAttachmentOwner(req, att.entity_id)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else {
      const ok = await hasCapability(req.user, cap);
      if (!ok) return res.status(403).json({ error: 'Forbidden' });
    }

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
    // Phase 3 — folder rename (within the same entity). Free-text up
    // to 60 chars per segment, supports `/`-delimited subfolder paths
    // (max 3 levels deep). Empty string normalizes back to 'general'.
    if (req.body && typeof req.body.folder === 'string') {
      const folder = sanitizeFolderPath(req.body.folder);
      sets.push('folder = $' + p++);
      params.push(folder);
    }
    // Per-attachment tags (CompanyCam-style). Normalize identically to
    // project tags: lowercase, trimmed, deduped, max 20 entries of 32
    // chars each. Anything non-string in the array is dropped silently.
    let nextTagsForCatalog = null;
    if (req.body && Array.isArray(req.body.tags)) {
      const normTags = normalizeTagsInput(req.body.tags);
      sets.push('tags = $' + p++ + '::jsonb');
      params.push(JSON.stringify(normTags));
      nextTagsForCatalog = normTags;
    }
    // Editable vector annotations (Phase 1.7). Stored as-is from the
    // markup viewer's strokes array. Pre-validated for shape + cap.
    if (req.body && (Array.isArray(req.body.annotations) || typeof req.body.annotations === 'string')) {
      const normAnnos = normalizeAnnotationsInput(req.body.annotations);
      sets.push('annotations = $' + p++ + '::jsonb');
      params.push(JSON.stringify(normAnnos));
    }
    if (!sets.length) return res.json({ ok: true, unchanged: true });
    params.push(req.params.id);
    // SAFE: column names are hardcoded conditionals above (caption / position / include_in_proposal / folder); no user-keys loop.
    await pool.query(`UPDATE attachments SET ${sets.join(', ')} WHERE id = $${p}`, params);
    res.json({ ok: true });

    // Log caption + tag edits on project photos. Other PUT mutations
    // (position, include_in_proposal, folder) aren't worth a feed
    // entry — they're UI plumbing, not user-meaningful changes.
    if (att.entity_type === 'project' &&
        req.body && typeof req.body.caption === 'string' &&
        req.body.caption !== att.caption) {
      recordProjectActivity(att.entity_id, req.user.id, 'caption_edited', {
        attachment_id: att.id,
        filename: att.filename
      });
    }
    if (att.entity_type === 'project' &&
        req.body && Array.isArray(req.body.tags)) {
      // Diff against the prior tags JSONB to write a focused activity
      // row. att.tags came back from the SELECT above as a parsed
      // array.
      const priorTags = Array.isArray(att.tags) ? att.tags : [];
      // Preserve case in the activity log — diff comparison is
      // case-insensitive so re-saving "Trim" when the prior was "trim"
      // doesn't show up as an added+removed pair.
      const nextTagsRaw = req.body.tags.filter(function(v) { return typeof v === 'string'; }).map(function(v) { return v.trim(); }).filter(Boolean);
      const priorLower = priorTags.map(function(t) { return String(t).toLowerCase(); });
      const nextLower = nextTagsRaw.map(function(t) { return t.toLowerCase(); });
      const added = nextTagsRaw.filter(function(t, i) { return priorLower.indexOf(nextLower[i]) === -1; });
      const removed = priorTags.filter(function(t) { return nextLower.indexOf(String(t).toLowerCase()) === -1; });
      if (added.length || removed.length) {
        recordProjectActivity(att.entity_id, req.user.id, 'photo_tags_changed', {
          attachment_id: att.id,
          filename: att.filename,
          added: added,
          removed: removed
        });
      }
      // Bump the org-level tag catalog for any newly-added tags
      // UNLESS the caller passed skip_catalog: true. That's the
      // "tag this attachment privately — don't share with the org"
      // path requested from the walkthrough flow. The tag still
      // saves to attachments.tags so it's searchable on this row;
      // it just doesn't pollute the suggestion catalog.
      if (added.length && !req.body.skip_catalog) {
        upsertOrgTags(req.user && req.user.organization_id, added, req.user && req.user.id);
      }
    }
    // Annotation edits get their own activity kind on project photos.
    if (att.entity_type === 'project' && req.body &&
        (Array.isArray(req.body.annotations) || typeof req.body.annotations === 'string')) {
      const normAnnos = normalizeAnnotationsInput(req.body.annotations);
      const priorCount = Array.isArray(att.annotations) ? att.annotations.length : 0;
      recordProjectActivity(att.entity_id, req.user.id, 'annotations_changed', {
        attachment_id: att.id,
        filename: att.filename,
        before_count: priorCount,
        after_count: normAnnos.length
      });
    }
  } catch (e) {
    console.error('PUT /api/attachments/:id error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// POST /api/attachments/:id/move — cross-entity move. Body:
//   { entity_type: 'job'|'lead'|'estimate'|'client'|'sub',
//     entity_id:   '<id>',
//     folder?:     'photos' | 'rfp' | ... (optional; defaults to 'general') }
// Permissions: requires write capability on BOTH source (current
// owner) and destination entity types. The actual file bytes don't
// move in storage — only the row's entity_type/entity_id/folder
// change, so URLs stay stable. Position is appended at MAX+1 of the
// destination so newly-moved attachments don't shuffle existing
// order at the new home.
router.post('/:id/move', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM attachments WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Attachment not found' });
    const att = rows[0];

    const newType = String(req.body && req.body.entity_type || '').trim();
    const newId   = String(req.body && req.body.entity_id   || '').trim();
    if (!newType || !newId) return res.status(400).json({ error: 'entity_type and entity_id are required' });
    const VALID = ['lead', 'estimate', 'client', 'job', 'sub', 'user'];
    if (VALID.indexOf(newType) === -1) return res.status(400).json({ error: 'invalid entity_type' });

    // Owner-or-cap gate on the SOURCE — must be allowed to move
    // files away from the current home.
    if (!(await canWriteAttachment(req, att))) {
      return res.status(403).json({ error: 'No write access on source entity' });
    }
    // Owner-or-cap gate on the DESTINATION — must be allowed to
    // attach to the new home.
    if (!(await canWriteEntity(req, newType, newId))) {
      return res.status(403).json({ error: 'No write access on destination entity' });
    }

    // Append at the end of the destination's existing order.
    const posR = await pool.query(
      'SELECT COALESCE(MAX(position), -1) AS max_pos FROM attachments WHERE entity_type = $1 AND entity_id = $2',
      [newType, newId]
    );
    const startPos = (posR.rows[0] && posR.rows[0].max_pos != null) ? Number(posR.rows[0].max_pos) + 1 : 0;

    const folderRaw = (req.body && typeof req.body.folder === 'string') ? req.body.folder : 'general';
    const folder = sanitizeFolderPath(folderRaw);

    await pool.query(
      `UPDATE attachments
         SET entity_type = $1, entity_id = $2, folder = $3, position = $4
         WHERE id = $5`,
      [newType, newId, folder, startPos, req.params.id]
    );
    res.json({ ok: true, entity_type: newType, entity_id: newId, folder, position: startPos });
  } catch (e) {
    console.error('POST /api/attachments/:id/move error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// POST /api/attachments/:id/copy — cross-entity duplicate. Body:
//   { entity_type, entity_id, folder? }
// Source row + R2 bytes stay put; we duplicate the bytes into fresh
// R2 keys under the destination prefix and INSERT a new attachments
// row referencing them. That way deleting either the source or the
// copy is independent — no shared-key bookkeeping needed. Driven by
// the My Files "Copy to job/estimate" action.
router.post('/:id/copy', requireAuth, async (req, res) => {
  try {
    const srcR = await pool.query('SELECT * FROM attachments WHERE id = $1', [req.params.id]);
    if (!srcR.rows.length) return res.status(404).json({ error: 'Attachment not found' });
    const src = srcR.rows[0];

    const newType = String(req.body && req.body.entity_type || '').trim();
    const newId   = String(req.body && req.body.entity_id   || '').trim();
    if (!newType || !newId) return res.status(400).json({ error: 'entity_type and entity_id are required' });
    const VALID = ['lead', 'estimate', 'client', 'job', 'sub', 'user'];
    if (VALID.indexOf(newType) === -1) return res.status(400).json({ error: 'invalid entity_type' });

    // Read on source + write on destination.
    if (!(await canReadAttachment(req, src))) {
      return res.status(403).json({ error: 'No read access on source attachment' });
    }
    if (!(await canWriteEntity(req, newType, newId))) {
      return res.status(403).json({ error: 'No write access on destination entity' });
    }

    // New id + R2 key prefix at destination.
    const newAttId = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const baseKey = newType + '/' + newId + '/' + newAttId;
    const ext = (src.filename || '').match(/\.([a-z0-9]+)$/i);
    const extStr = ext ? ext[1].toLowerCase() : 'bin';

    // Copy bytes for each variant the source has. R2 / local both
    // implement put + getBuffer; a server-side copy is cheap (few
    // hundred KB per variant) and keeps semantics simple.
    let newThumbKey = null, newWebKey = null, newOriginalKey = null;
    let newThumbUrl = null, newWebUrl = null, newOriginalUrl;

    if (src.thumb_key) {
      const buf = await storage.getBuffer(src.thumb_key);
      newThumbKey = baseKey + '_thumb.jpg';
      newThumbUrl = await storage.put(newThumbKey, buf, 'image/jpeg');
    }
    if (src.web_key) {
      const buf = await storage.getBuffer(src.web_key);
      newWebKey = baseKey + '_web.jpg';
      newWebUrl = await storage.put(newWebKey, buf, 'image/jpeg');
    }
    if (src.original_key) {
      const buf = await storage.getBuffer(src.original_key);
      newOriginalKey = baseKey + '_orig.' + extStr;
      newOriginalUrl = await storage.put(newOriginalKey, buf, src.mime_type || 'application/octet-stream');
    }

    const folderRaw = (req.body && typeof req.body.folder === 'string') ? req.body.folder : 'general';
    const folder = sanitizeFolderPath(folderRaw);

    const posR = await pool.query(
      'SELECT COALESCE(MAX(position), -1) AS max_pos FROM attachments WHERE entity_type = $1 AND entity_id = $2',
      [newType, newId]
    );
    const startPos = (posR.rows[0] && posR.rows[0].max_pos != null) ? Number(posR.rows[0].max_pos) + 1 : 0;

    const ins = await pool.query(
      `INSERT INTO attachments
         (id, entity_type, entity_id, folder, filename, mime_type, size_bytes,
          width, height,
          thumb_url, web_url, original_url,
          thumb_key, web_key, original_key,
          position, uploaded_by, extracted_text, extracted_text_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        newAttId, newType, newId, folder,
        src.filename, src.mime_type, src.size_bytes,
        src.width, src.height,
        newThumbUrl, newWebUrl, newOriginalUrl,
        newThumbKey, newWebKey, newOriginalKey,
        startPos, req.user.id,
        src.extracted_text, src.extracted_text_at
      ]
    );
    res.json({ ok: true, attachment: ins.rows[0] });
  } catch (e) {
    console.error('POST /api/attachments/:id/copy error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// Owner-or-cap helpers. Centralized so move + copy + future row-keyed
// routes stay consistent on the gating logic.
async function canReadAttachment(req, att) {
  const cap = readCapForEntity(att.entity_type);
  if (cap === '__owner__') return ensureUserAttachmentOwner(req, att.entity_id);
  return await hasCapability(req.user, cap);
}
async function canWriteAttachment(req, att) {
  const cap = writeCapForEntity(att.entity_type);
  if (cap === '__owner__') return ensureUserAttachmentOwner(req, att.entity_id);
  return await hasCapability(req.user, cap);
}
async function canWriteEntity(req, entityType, entityId) {
  const cap = writeCapForEntity(entityType);
  if (cap === '__owner__') return ensureUserAttachmentOwner(req, entityId);
  return await hasCapability(req.user, cap);
}

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
// Internal helpers exposed for test/ coverage (not for runtime use
// from other route modules). Audit finding C5.
module.exports.__internals__ = {
  sniffMimeFromBytes,
  sanitizeSvg,
  mimeFamilyMatches
};
