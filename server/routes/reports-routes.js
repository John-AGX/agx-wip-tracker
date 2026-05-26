// Polymorphic reports (Phase 2). Writes to the same job_reports
// table the legacy job-scoped route uses — both share the schema
// (sections JSONB shape, photo_ids referencing attachments). The
// table is named job_reports for backward compat; the new
// entity_type + entity_id columns let it hold reports for projects
// (and later: leads, estimates) without renaming.
//
// Mounted at /api/reports.
//   GET    /:entityType/:entityId             — list reports
//   GET    /:entityType/:entityId/:reportId   — single report (hydrated photos)
//   POST   /:entityType/:entityId             — create (seeds Before/During/After)
//   PATCH  /:entityType/:entityId/:reportId   — update title / summary / sections
//   DELETE /:entityType/:entityId/:reportId   — remove
//
// Currently supports entity_type='project'. The legacy
// /api/jobs/:jobId/reports route still owns 'job' (with its own
// photo-source logic that includes building / phase / CO photos).

'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

// For now, projects are the only new surface. Future: 'lead' /
// 'estimate'. job is handled by the legacy /api/jobs/:jobId/reports.
const SUPPORTED_ENTITY_TYPES = new Set(['project']);

// Capability gate per entity type. Projects use LEADS_* per the
// attachments + projects routes posture.
function readCapFor(entityType) {
  if (entityType === 'project') return 'LEADS_VIEW';
  return null;
}
function writeCapFor(entityType) {
  if (entityType === 'project') return 'LEADS_EDIT';
  return null;
}

function newId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// Wave B template registry. Keep this in lockstep with the client
// registry in js/report-templates.js — both lists drive the
// template-specific cover schema + section seeding in the editor.
// 'walkthrough' is the historical default and the safe fallback.
const TEMPLATE_TYPES = new Set([
  'walkthrough',
  'daily-log',
  'weekly-progress',
  'engineers-report',
  'submittal-package',
  'punch-list',
  'pre-con-survey',
  'change-order'
]);
function normalizeTemplateType(raw) {
  if (typeof raw !== 'string') return 'walkthrough';
  return TEMPLATE_TYPES.has(raw) ? raw : 'walkthrough';
}

// Wave B3 section layout enum — kept in lockstep with the client
// LAYOUT_OPTIONS in js/projects.js. Bad/missing values clamp to
// 'photo-grid' (the historical default).
const SECTION_LAYOUTS = new Set([
  'photo-grid',
  'single-photo',
  'before-after',
  'text-block',
  'attachment-list'
]);
function normalizeLayout(raw) {
  return (typeof raw === 'string' && SECTION_LAYOUTS.has(raw)) ? raw : 'photo-grid';
}

function normalizeSections(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(function(s) {
    if (!s || typeof s !== 'object') return null;
    const id = typeof s.id === 'string' ? s.id : newId('sec');
    const label = typeof s.label === 'string' ? s.label.slice(0, 120) : '';
    const layout = normalizeLayout(s.layout);
    // before-after caps at 2 photos. Other photo layouts allow up
    // to 200. Text-block / attachment-list layouts still accept a
    // photo_ids array for cheap layout switching (data isn't lost
    // — just hidden — until the user confirms the switch).
    let photoLimit = 200;
    if (layout === 'before-after') photoLimit = 2;
    const photoIds = Array.isArray(s.photo_ids)
      ? s.photo_ids.filter(function(x) { return typeof x === 'string'; }).slice(0, photoLimit)
      : [];
    const captionsIn = (s.captions && typeof s.captions === 'object') ? s.captions : {};
    const captions = {};
    photoIds.forEach(function(pid) {
      const c = captionsIn[pid];
      if (typeof c === 'string') captions[pid] = c.slice(0, 500);
    });
    const textBody = (typeof s.text_body === 'string') ? s.text_body.slice(0, 20000) : '';
    const attachmentIds = Array.isArray(s.attachment_ids)
      ? s.attachment_ids.filter(function(x) { return typeof x === 'string'; }).slice(0, 50)
      : [];
    // Presentation knobs (per-section). photoSize controls grid
    // columns (S=3/M=2/L=1 per row) or stack-mode photo max-width
    // (S=65%/M=80%/L=100%). descSide is the SECTION default side;
    // descSides[pid] overrides per photo so users can stagger
    // left/right within a section.
    const photoSize = (s.photoSize === 'medium' || s.photoSize === 'large') ? s.photoSize : 'small';
    const descSide  = (s.descSide  === 'left') ? 'left' : 'right';
    const descSidesIn = (s.descSides && typeof s.descSides === 'object') ? s.descSides : {};
    const descSides = {};
    photoIds.forEach(function(pid) {
      const v = descSidesIn[pid];
      if (v === 'left' || v === 'right') descSides[pid] = v;
    });
    return {
      id: id,
      label: label,
      layout: layout,
      photoSize: photoSize,
      descSide: descSide,
      descSides: descSides,
      photo_ids: photoIds,
      captions: captions,
      text_body: textBody,
      attachment_ids: attachmentIds
    };
  }).filter(Boolean).slice(0, 50);
}

// Hydrate sections: for each photo_id, look up the attachment row
// and inline the fields the editor / print view needs. Annotations
// (Phase 1.7) ride along so the print view can render strokes on
// top of the image. Photos that no longer exist drop silently.
async function hydrateSections(sections) {
  const allIds = new Set();
  sections.forEach(function(s) {
    (s.photo_ids || []).forEach(function(pid) { allIds.add(pid); });
  });
  if (!allIds.size) {
    return sections.map(function(s) {
      return { id: s.id, label: s.label, photos: [] };
    });
  }
  const idList = Array.from(allIds);
  const { rows } = await pool.query(
    'SELECT id, entity_type, entity_id, filename, mime_type, ' +
    '       size_bytes, thumb_url, web_url, original_url, ' +
    '       folder, uploaded_at, caption, annotations ' +
    '  FROM attachments WHERE id = ANY($1::text[])',
    [idList]
  );
  const byId = new Map(rows.map(function(r) { return [r.id, r]; }));
  return sections.map(function(s) {
    const captions = s.captions || {};
    const photos = (s.photo_ids || [])
      .map(function(pid) {
        const att = byId.get(pid);
        if (!att) return null;
        return {
          id: att.id,
          filename: att.filename,
          mime_type: att.mime_type,
          thumb_url: att.thumb_url,
          web_url: att.web_url,
          original_url: att.original_url,
          annotations: Array.isArray(att.annotations) ? att.annotations : [],
          caption: captions[pid] || att.caption || ''
        };
      })
      .filter(Boolean);
    // Wave B3: layout + text_body + attachment_ids ride through to
    // the client so the editor can render the right body for each
    // section type. The print view also reads layout off these
    // hydrated entries.
    return {
      id: s.id,
      label: s.label,
      layout: s.layout || 'photo-grid',
      photos: photos,
      text_body: s.text_body || '',
      attachment_ids: Array.isArray(s.attachment_ids) ? s.attachment_ids : []
    };
  });
}

// Confirm the parent entity exists. Projects: SELECT from projects.
// Returns true on existence + (for projects) caller's org match.
async function ensureEntityVisible(entityType, entityId, req) {
  if (entityType === 'project') {
    const orgId = req.user && req.user.organization_id;
    if (!orgId) return false;
    const r = await pool.query(
      'SELECT id FROM projects WHERE id = $1 AND organization_id = $2',
      [entityId, Number(orgId)]
    );
    return r.rowCount > 0;
  }
  return false;
}

function entityTypeOk(t) { return SUPPORTED_ENTITY_TYPES.has(t); }

// GET /api/reports/:entityType/:entityId
router.get('/:entityType/:entityId', requireAuth, async (req, res, next) => {
  const { entityType, entityId } = req.params;
  if (!entityTypeOk(entityType)) return res.status(400).json({ error: 'Unsupported entity type' });
  const cap = readCapFor(entityType);
  if (!cap) return res.status(403).json({ error: 'Forbidden' });
  return requireCapability(cap)(req, res, async () => {
    try {
      if (!(await ensureEntityVisible(entityType, entityId, req))) {
        return res.status(404).json({ error: entityType + ' not found' });
      }
      const { rows } = await pool.query(
        'SELECT r.id, r.title, r.summary, r.sections, r.entity_type, r.entity_id, ' +
        '       r.template_type, r.created_at, r.updated_at, u.name AS created_by_name ' +
        '  FROM job_reports r ' +
        '  LEFT JOIN users u ON u.id = r.created_by ' +
        ' WHERE r.entity_type = $1 AND r.entity_id = $2 ' +
        ' ORDER BY r.updated_at DESC',
        [entityType, entityId]
      );
      const list = rows.map(function(r) {
        const sections = Array.isArray(r.sections) ? r.sections : [];
        const photoCount = sections.reduce(function(n, s) {
          return n + (Array.isArray(s.photo_ids) ? s.photo_ids.length : 0);
        }, 0);
        return {
          id: r.id,
          entity_type: r.entity_type,
          entity_id: r.entity_id,
          title: r.title,
          summary: r.summary,
          template_type: r.template_type || 'walkthrough',
          section_count: sections.length,
          photo_count: photoCount,
          created_at: r.created_at,
          updated_at: r.updated_at,
          created_by_name: r.created_by_name
        };
      });
      res.json({ reports: list });
    } catch (e) {
      console.error('GET /api/reports/:entityType/:entityId error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  });
});

// GET /api/reports/:entityType/:entityId/:reportId
router.get('/:entityType/:entityId/:reportId', requireAuth, async (req, res) => {
  const { entityType, entityId, reportId } = req.params;
  if (!entityTypeOk(entityType)) return res.status(400).json({ error: 'Unsupported entity type' });
  const cap = readCapFor(entityType);
  return requireCapability(cap)(req, res, async () => {
    try {
      if (!(await ensureEntityVisible(entityType, entityId, req))) {
        return res.status(404).json({ error: entityType + ' not found' });
      }
      const { rows } = await pool.query(
        'SELECT r.*, u.name AS created_by_name FROM job_reports r ' +
        ' LEFT JOIN users u ON u.id = r.created_by ' +
        ' WHERE r.id = $1 AND r.entity_type = $2 AND r.entity_id = $3',
        [reportId, entityType, entityId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Report not found' });
      const r = rows[0];
      const sections = Array.isArray(r.sections) ? r.sections : [];
      const hydrated = await hydrateSections(sections);
      res.json({
        report: {
          id: r.id,
          entity_type: r.entity_type,
          entity_id: r.entity_id,
          title: r.title,
          summary: r.summary,
          template_type: r.template_type || 'walkthrough',
          sections: hydrated,
          sections_raw: sections,
          cover_page: r.cover_page || {},
          created_at: r.created_at,
          updated_at: r.updated_at,
          created_by_name: r.created_by_name
        }
      });
    } catch (e) {
      console.error('GET /api/reports/:entityType/:entityId/:reportId error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  });
});

// POST /api/reports/:entityType/:entityId
// Creates a fresh report — NO default sections. Users add what they
// need. (The legacy auto-seeded Before/During/After made every
// report start as a generic walkthrough; in practice users wanted
// section structures specific to their report type, so blank-by-
// default is the right ergonomic.)
router.post('/:entityType/:entityId', requireAuth, async (req, res) => {
  const { entityType, entityId } = req.params;
  if (!entityTypeOk(entityType)) return res.status(400).json({ error: 'Unsupported entity type' });
  const cap = writeCapFor(entityType);
  return requireCapability(cap)(req, res, async () => {
    try {
      if (!(await ensureEntityVisible(entityType, entityId, req))) {
        return res.status(404).json({ error: entityType + ' not found' });
      }
      const id = newId('rpt');
      const title = (req.body && typeof req.body.title === 'string')
        ? req.body.title.slice(0, 200) : 'Untitled report';
      const summary = (req.body && typeof req.body.summary === 'string')
        ? req.body.summary.slice(0, 5000) : '';
      const sections = normalizeSections(req.body && req.body.sections);
      const coverPage = normalizeCoverPage(req.body && req.body.cover_page);
      const templateType = normalizeTemplateType(req.body && req.body.template_type);
      await pool.query(
        'INSERT INTO job_reports (id, entity_type, entity_id, title, summary, sections, cover_page, template_type, created_by) ' +
        'VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)',
        [id, entityType, entityId, title, summary, JSON.stringify(sections), JSON.stringify(coverPage), templateType, req.user.id]
      );
      res.json({ report: { id, entity_type: entityType, entity_id: entityId, title, summary, template_type: templateType, sections, cover_page: coverPage } });
    } catch (e) {
      console.error('POST /api/reports/:entityType/:entityId error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  });
});

// Cover page normalization — defensive caps + boolean enabled flag.
// Wave B made the schema per-template (daily-log uses crew + weather,
// engineer's report uses license_number + signed_date, etc.) so the
// whitelist below covers every field across all 8 templates. Unknown
// keys are silently dropped to keep the JSONB from growing unbounded.
const COVER_PAGE_KEYS = [
  // Walkthrough (default)
  'company_name', 'pm_name', 'date', 'address', 'subtitle',
  // Daily Log
  'crew', 'weather', 'hours_on_site',
  // Weekly Progress
  'week_ending', 'project_phase', 'schedule_status',
  // Engineer's Report
  'stamped_by', 'license_number', 'signed_date',
  // Submittal Package
  'submittal_number', 'spec_section', 'supplier', 'approval_block',
  // Punch List
  'walkthrough_date', 'walkthrough_with',
  // Pre-Construction Survey
  'survey_date', 'surveyed_by', 'building',
  // Change Order Justification
  'co_number', 'co_amount', 'requested_by'
];
function normalizeCoverPage(raw) {
  if (!raw || typeof raw !== 'object') return { enabled: false };
  const out = { enabled: !!raw.enabled };
  COVER_PAGE_KEYS.forEach(function(k) {
    if (typeof raw[k] === 'string') {
      out[k] = raw[k].slice(0, 500);
    }
  });
  return out;
}

// PATCH /api/reports/:entityType/:entityId/:reportId
router.patch('/:entityType/:entityId/:reportId', requireAuth, async (req, res) => {
  const { entityType, entityId, reportId } = req.params;
  if (!entityTypeOk(entityType)) return res.status(400).json({ error: 'Unsupported entity type' });
  const cap = writeCapFor(entityType);
  return requireCapability(cap)(req, res, async () => {
    try {
      const sets = [];
      const params = [];
      let p = 1;
      if (typeof req.body.title === 'string') {
        sets.push('title = $' + (p++));
        params.push(req.body.title.slice(0, 200));
      }
      if (typeof req.body.summary === 'string') {
        sets.push('summary = $' + (p++));
        params.push(req.body.summary.slice(0, 5000));
      }
      if (Array.isArray(req.body.sections)) {
        sets.push('sections = $' + (p++) + '::jsonb');
        params.push(JSON.stringify(normalizeSections(req.body.sections)));
      }
      if (req.body.cover_page && typeof req.body.cover_page === 'object') {
        sets.push('cover_page = $' + (p++) + '::jsonb');
        params.push(JSON.stringify(normalizeCoverPage(req.body.cover_page)));
      }
      // template_type can change post-create (user picks the wrong
      // template; switching converts the editor's cover schema + the
      // section seed). Whitelisted; bad values clamp to walkthrough.
      if (typeof req.body.template_type === 'string') {
        sets.push('template_type = $' + (p++));
        params.push(normalizeTemplateType(req.body.template_type));
      }
      if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
      sets.push('updated_at = NOW()');
      params.push(reportId, entityType, entityId);
      const sql =
        'UPDATE job_reports SET ' + sets.join(', ') +
        ' WHERE id = $' + (p++) + ' AND entity_type = $' + (p++) + ' AND entity_id = $' + (p++);
      const r = await pool.query(sql, params);
      if (!r.rowCount) return res.status(404).json({ error: 'Report not found' });
      res.json({ ok: true });
    } catch (e) {
      console.error('PATCH /api/reports/:entityType/:entityId/:reportId error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  });
});

// DELETE /api/reports/:entityType/:entityId/:reportId
router.delete('/:entityType/:entityId/:reportId', requireAuth, async (req, res) => {
  const { entityType, entityId, reportId } = req.params;
  if (!entityTypeOk(entityType)) return res.status(400).json({ error: 'Unsupported entity type' });
  const cap = writeCapFor(entityType);
  return requireCapability(cap)(req, res, async () => {
    try {
      const r = await pool.query(
        'DELETE FROM job_reports WHERE id = $1 AND entity_type = $2 AND entity_id = $3',
        [reportId, entityType, entityId]
      );
      if (!r.rowCount) return res.status(404).json({ error: 'Report not found' });
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /api/reports/:entityType/:entityId/:reportId error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  });
});

module.exports = router;
