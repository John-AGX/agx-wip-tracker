// Project 86 — Job Reports routes
//
// CRUD over job_reports rows. A report is a user-curated photo
// collection grouped into named sections with per-photo captions and
// a top-level summary, designed to print to letter-page PDF.
//
// Photos in a report reference the existing attachments table by id;
// no copies are made. On read, this route enriches the photo_ids on
// each section with the attachment record (filename / thumb_url /
// web_url / mime_type) so the client can render the report without
// a second round-trip per photo.
//
// Capability gate: JOBS_VIEW for read, JOBS_EDIT for write. Same
// audience that can touch the job's data can author reports.
//
// THIS FEATURE WAS DEAD IN PRODUCTION. All five endpoints gated on a
// space-separated capability list ("JOBS_EDIT_ANY JOBS_EDIT_OWN") — a
// documented convention elsewhere in this repo — but requireCapability passed
// the whole string to an exact `caps.has()` lookup. No such capability exists,
// so every caller got 403, up to and including a capability-complete system
// admin. Job Reports has been unreachable since the gate was written.
//
// It was also unscoped: ensureJobExists asked whether a job EXISTED, not whose
// it was. The dead gate was the only thing holding that closed, so the gate and
// the tenant predicate had to be fixed in the same change — repairing the gate
// alone would have opened the hole the day it shipped.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability, getAttributedUserId, requireOrgId } = require('../auth');
// job_reports has no organization_id of its own — the org ALTER in db.js is
// guarded on a table named `reports`, and this table is still `job_reports`.
// Its only tenant pointer is the parent job, so that is what every statement
// here proves.
const { jobInOrg, parentJobInOrgSql } = require('../services/job-org-scope');

const router = express.Router({ mergeParams: true });

// Every endpoint in this file is keyed on a job id from the URL. One gate,
// applied identically, so a new endpoint cannot be added without it.
const READ_CAP = 'JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED JOBS_EDIT_ANY JOBS_EDIT_OWN';
const WRITE_CAP = 'JOBS_EDIT_ANY JOBS_EDIT_OWN';

function newId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// Validate the sections array shape, drop unknown keys, default
// missing fields, and stringify any non-string label / caption text.
// Returns a clean JSONB-safe array.
function normalizeSections(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(function(s) {
    if (!s || typeof s !== 'object') return null;
    const id = typeof s.id === 'string' ? s.id : newId('sec');
    const label = typeof s.label === 'string' ? s.label.slice(0, 120) : '';
    const photoIds = Array.isArray(s.photo_ids)
      ? s.photo_ids.filter(function(x) { return typeof x === 'string'; }).slice(0, 200)
      : [];
    const captionsIn = (s.captions && typeof s.captions === 'object') ? s.captions : {};
    const captions = {};
    photoIds.forEach(function(pid) {
      const c = captionsIn[pid];
      if (typeof c === 'string') captions[pid] = c.slice(0, 500);
    });
    return { id: id, label: label, photo_ids: photoIds, captions: captions };
  }).filter(Boolean).slice(0, 50);
}

// Template + cover-page support (Wave B parity). This legacy job route
// predated per-template cover pages; the columns already exist on
// job_reports (the polymorphic /api/reports sibling writes them), so the
// Daily Log tab can store date / crew / weather / hours here too. The
// whitelist mirrors reports-routes.js's normalizeCoverPage so both write
// paths accept an identical key set; unknown keys are dropped, values capped.
const COVER_PAGE_KEYS = [
  'company_name', 'pm_name', 'date', 'address', 'subtitle',
  'crew', 'weather', 'hours_on_site',
  'week_ending', 'project_phase', 'schedule_status',
  'stamped_by', 'license_number', 'signed_date',
  'submittal_number', 'spec_section', 'supplier', 'approval_block',
  'walkthrough_date', 'walkthrough_with',
  'survey_date', 'surveyed_by', 'building',
  'co_number', 'co_amount', 'requested_by'
];
function normalizeCoverPage(raw) {
  if (!raw || typeof raw !== 'object') return { enabled: false };
  const out = { enabled: !!raw.enabled };
  COVER_PAGE_KEYS.forEach(function(k) {
    if (typeof raw[k] === 'string') out[k] = raw[k].slice(0, 500);
  });
  return out;
}
// Must stay in lockstep with js/report-templates.js + reports-routes.js.
const TEMPLATE_TYPES = [
  'walkthrough', 'daily-log', 'weekly-progress', 'engineers-report',
  'submittal-package', 'punch-list', 'pre-con-survey', 'change-order'
];
function normalizeTemplateType(raw) {
  return (typeof raw === 'string' && TEMPLATE_TYPES.indexOf(raw) !== -1) ? raw : 'walkthrough';
}

// The job this request names, and whether it is the CALLER'S job.
//
// This used to be ensureJobExists: `SELECT id FROM jobs WHERE id = $1`, which
// answered the wrong question. Existence is not permission. It was holding
// only because the capability gate above it was broken for everyone — fixing
// that gate alone would have opened a tenancy hole the same day, which is why
// the gate and the predicate move together in one change.
//
// A foreign job answers exactly like an absent one: job ids are guessable, and
// a distinguishable refusal is a cross-tenant existence oracle.
async function jobIsReachable(jobId, orgId) {
  return jobInOrg(pool, jobId, orgId);
}

// Hydrate sections: for each photo_id in each section, look up the
// attachment record once and inline { id, filename, mime_type,
// thumb_url, web_url, original_url }. Photos that no longer exist
// (attachment was deleted after the report was saved) are dropped
// silently rather than rendering as broken images.
// orgId is required, not optional: photo_ids are written from the request body
// (normalizeSections keeps any string), so a report could be saved holding
// another tenant's attachment ids and this function would then hand back their
// thumb_url and web_url. The stored id is caller-supplied data, so it is
// scoped on the way out as well as being refused on the way in.
async function hydrateSections(sections, orgId) {
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
    '       folder, uploaded_at ' +
    '  FROM attachments WHERE id = ANY($1::text[]) ' +
    '   AND (organization_id = $2 OR organization_id IS NULL)',
    [idList, orgId]
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
          caption: captions[pid] || ''
        };
      })
      .filter(Boolean);
    return { id: s.id, label: s.label, photos: photos };
  });
}

// GET /api/jobs/:jobId/reports
// List reports for a job. Lightweight — no photo hydration, just the
// title / summary / counts so the list view can render fast.
router.get('/', requireAuth, requireCapability(READ_CAP), requireOrgId,
  async (req, res) => {
    try {
      const jobId = req.params.jobId;
      if (!(await jobIsReachable(jobId, req.orgId))) return res.status(404).json({ error: 'Job not found' });
      const { rows } = await pool.query(
        'SELECT r.id, r.job_id, r.title, r.summary, r.sections, ' +
        '       r.template_type, r.cover_page, ' +
        '       r.created_at, r.updated_at, u.name AS created_by_name ' +
        '  FROM job_reports r ' +
        '  LEFT JOIN users u ON u.id = r.created_by ' +
        ' WHERE r.job_id = $1 ' +
        ' ORDER BY r.updated_at DESC',
        [jobId]
      );
      const list = rows.map(function(r) {
        const sections = Array.isArray(r.sections) ? r.sections : [];
        const photoCount = sections.reduce(function(n, s) {
          return n + (Array.isArray(s.photo_ids) ? s.photo_ids.length : 0);
        }, 0);
        return {
          id: r.id,
          job_id: r.job_id,
          title: r.title,
          summary: r.summary,
          // Template + cover surfaced so the client can split Reports vs
          // Daily Logs and show cover fields (crew/weather/hours) in the list.
          template_type: r.template_type || 'walkthrough',
          cover_page: r.cover_page || {},
          section_count: sections.length,
          photo_count: photoCount,
          created_at: r.created_at,
          updated_at: r.updated_at,
          created_by_name: r.created_by_name
        };
      });
      res.json({ reports: list });
    } catch (e) {
      console.error('GET /api/jobs/:jobId/reports error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /api/jobs/:jobId/reports/:reportId
// Single report, fully hydrated. Sections come back with each photo
// expanded into { id, filename, thumb_url, web_url, caption } so the
// client can render the editor / print view in one pass.
router.get('/:reportId', requireAuth, requireCapability(READ_CAP), requireOrgId,
  async (req, res) => {
    try {
      if (!(await jobIsReachable(req.params.jobId, req.orgId))) {
        return res.status(404).json({ error: 'Job not found' });
      }
      const { rows } = await pool.query(
        'SELECT r.*, u.name AS created_by_name FROM job_reports r ' +
        ' LEFT JOIN users u ON u.id = r.created_by ' +
        ' WHERE r.id = $1 AND r.job_id = $2',
        [req.params.reportId, req.params.jobId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Report not found' });
      const r = rows[0];
      const sections = Array.isArray(r.sections) ? r.sections : [];
      const hydrated = await hydrateSections(sections, req.orgId);
      res.json({
        report: {
          id: r.id,
          job_id: r.job_id,
          title: r.title,
          summary: r.summary,
          template_type: r.template_type || 'walkthrough',
          cover_page: r.cover_page || {},
          sections: hydrated,
          // Raw sections too so the editor can round-trip the
          // captions object without re-walking the hydrated array.
          sections_raw: sections,
          created_at: r.created_at,
          updated_at: r.updated_at,
          created_by_name: r.created_by_name
        }
      });
    } catch (e) {
      console.error('GET /api/jobs/:jobId/reports/:reportId error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /api/jobs/:jobId/reports
// Create a new report. Body: { title?, summary?, sections? }
router.post('/', requireAuth, requireCapability(WRITE_CAP), requireOrgId,
  async (req, res) => {
    try {
      const jobId = req.params.jobId;
      const ok = await jobIsReachable(jobId, req.orgId);
      if (!ok) return res.status(404).json({ error: 'Job not found' });
      const id = newId('rpt');
      const title = (req.body && typeof req.body.title === 'string')
        ? req.body.title.slice(0, 200) : 'Untitled report';
      const summary = (req.body && typeof req.body.summary === 'string')
        ? req.body.summary.slice(0, 5000) : '';
      const sections = normalizeSections(req.body && req.body.sections);
      const templateType = normalizeTemplateType(req.body && req.body.template_type);
      const coverPage = normalizeCoverPage(req.body && req.body.cover_page);
      // Seed default Before / During / After only when no sections passed
      // AND no template drove its own seed sections (the client seeds Daily
      // Logs from js/report-templates.js, so respect an explicit empty set
      // for a templated create by seeding a single photo section instead).
      const seedSections = sections.length ? sections
        : (templateType && templateType !== 'walkthrough'
            ? [{ id: newId('sec'), label: 'Photos from the field', photo_ids: [], captions: {} }]
            : [
                { id: newId('sec'), label: 'Before',  photo_ids: [], captions: {} },
                { id: newId('sec'), label: 'During',  photo_ids: [], captions: {} },
                { id: newId('sec'), label: 'After',   photo_ids: [], captions: {} }
              ]);
      await pool.query(
        'INSERT INTO job_reports (id, job_id, title, summary, sections, template_type, cover_page, created_by) ' +
        'VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)',
        // created_by = attributed user (acted-as target when disguised);
        // display-only column, never a read filter or access guard.
        [id, jobId, title, summary, JSON.stringify(seedSections), templateType, JSON.stringify(coverPage), getAttributedUserId(req)]
      );
      res.json({ report: { id, job_id: jobId, title, summary, template_type: templateType, cover_page: coverPage, sections: seedSections } });
    } catch (e) {
      console.error('POST /api/jobs/:jobId/reports error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PATCH /api/jobs/:jobId/reports/:reportId
// Partial update. Any of title / summary / sections may be omitted —
// only the supplied fields are written.
router.patch('/:reportId', requireAuth, requireCapability(WRITE_CAP), requireOrgId,
  async (req, res) => {
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
      // Cover page (Daily Log date/crew/weather/hours) + template type —
      // only written when the client sends them, so untouched reports keep
      // whatever they had.
      if (req.body.cover_page && typeof req.body.cover_page === 'object') {
        sets.push('cover_page = $' + (p++) + '::jsonb');
        params.push(JSON.stringify(normalizeCoverPage(req.body.cover_page)));
      }
      if (typeof req.body.template_type === 'string') {
        sets.push('template_type = $' + (p++));
        params.push(normalizeTemplateType(req.body.template_type));
      }
      if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
      sets.push('updated_at = NOW()');
      params.push(req.params.reportId, req.params.jobId, req.orgId);
      // Filtered rather than pre-checked: keyed on the report's own id, so a
      // probe first is a round-trip and a TOCTOU. The tenant comes off the
      // PARENT JOB — job_reports has no org column of its own.
      const sql =
        'UPDATE job_reports SET ' + sets.join(', ') +
        ' WHERE id = $' + (p++) + ' AND job_id = $' + (p++) +
        ' AND ' + parentJobInOrgSql('job_reports.job_id', '$' + (p++));
      const r = await pool.query(sql, params);
      if (!r.rowCount) return res.status(404).json({ error: 'Report not found' });
      res.json({ ok: true });
    } catch (e) {
      console.error('PATCH /api/jobs/:jobId/reports/:reportId error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /api/jobs/:jobId/reports/:reportId
router.delete('/:reportId', requireAuth, requireCapability(WRITE_CAP), requireOrgId,
  async (req, res) => {
    try {
      const r = await pool.query(
        'DELETE FROM job_reports WHERE id = $1 AND job_id = $2 AND ' +
        parentJobInOrgSql('job_reports.job_id', '$3'),
        [req.params.reportId, req.params.jobId, req.orgId]
      );
      if (!r.rowCount) return res.status(404).json({ error: 'Report not found' });
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /api/jobs/:jobId/reports/:reportId error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
