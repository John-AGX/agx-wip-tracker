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

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router({ mergeParams: true });

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

// Look up the job and confirm it exists. Reports cannot exist for a
// missing job (FK would block insert) but we want a clear 404 rather
// than a SQL constraint error.
async function ensureJobExists(jobId) {
  const r = await pool.query('SELECT id FROM jobs WHERE id = $1', [jobId]);
  return r.rowCount > 0;
}

// Hydrate sections: for each photo_id in each section, look up the
// attachment record once and inline { id, filename, mime_type,
// thumb_url, web_url, original_url }. Photos that no longer exist
// (attachment was deleted after the report was saved) are dropped
// silently rather than rendering as broken images.
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
    '       folder, uploaded_at ' +
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
router.get('/', requireAuth, requireCapability('JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED JOBS_EDIT_ANY JOBS_EDIT_OWN'),
  async (req, res) => {
    try {
      const jobId = req.params.jobId;
      const { rows } = await pool.query(
        'SELECT r.id, r.job_id, r.title, r.summary, r.sections, ' +
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
router.get('/:reportId', requireAuth,
  requireCapability('JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED JOBS_EDIT_ANY JOBS_EDIT_OWN'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT r.*, u.name AS created_by_name FROM job_reports r ' +
        ' LEFT JOIN users u ON u.id = r.created_by ' +
        ' WHERE r.id = $1 AND r.job_id = $2',
        [req.params.reportId, req.params.jobId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Report not found' });
      const r = rows[0];
      const sections = Array.isArray(r.sections) ? r.sections : [];
      const hydrated = await hydrateSections(sections);
      res.json({
        report: {
          id: r.id,
          job_id: r.job_id,
          title: r.title,
          summary: r.summary,
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
router.post('/', requireAuth, requireCapability('JOBS_EDIT_ANY JOBS_EDIT_OWN'),
  async (req, res) => {
    try {
      const jobId = req.params.jobId;
      const ok = await ensureJobExists(jobId);
      if (!ok) return res.status(404).json({ error: 'Job not found' });
      const id = newId('rpt');
      const title = (req.body && typeof req.body.title === 'string')
        ? req.body.title.slice(0, 200) : 'Untitled report';
      const summary = (req.body && typeof req.body.summary === 'string')
        ? req.body.summary.slice(0, 5000) : '';
      const sections = normalizeSections(req.body && req.body.sections);
      // Seed default Before / During / After if no sections passed.
      const seedSections = sections.length ? sections : [
        { id: newId('sec'), label: 'Before',  photo_ids: [], captions: {} },
        { id: newId('sec'), label: 'During',  photo_ids: [], captions: {} },
        { id: newId('sec'), label: 'After',   photo_ids: [], captions: {} }
      ];
      await pool.query(
        'INSERT INTO job_reports (id, job_id, title, summary, sections, created_by) ' +
        'VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
        [id, jobId, title, summary, JSON.stringify(seedSections), req.user.id]
      );
      res.json({ report: { id, job_id: jobId, title, summary, sections: seedSections } });
    } catch (e) {
      console.error('POST /api/jobs/:jobId/reports error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PATCH /api/jobs/:jobId/reports/:reportId
// Partial update. Any of title / summary / sections may be omitted —
// only the supplied fields are written.
router.patch('/:reportId', requireAuth, requireCapability('JOBS_EDIT_ANY JOBS_EDIT_OWN'),
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
      if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
      sets.push('updated_at = NOW()');
      params.push(req.params.reportId, req.params.jobId);
      const sql =
        'UPDATE job_reports SET ' + sets.join(', ') +
        ' WHERE id = $' + (p++) + ' AND job_id = $' + (p++);
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
router.delete('/:reportId', requireAuth, requireCapability('JOBS_EDIT_ANY JOBS_EDIT_OWN'),
  async (req, res) => {
    try {
      const r = await pool.query(
        'DELETE FROM job_reports WHERE id = $1 AND job_id = $2',
        [req.params.reportId, req.params.jobId]
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
