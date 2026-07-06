// Applications for Payment — the AIA G702 (certificate) + G703 (continuation)
// billing entity. One pay_applications row per period on a job; the frozen
// Schedule-of-Values snapshot lives in data.lines[] (derived from the job's
// phases + change orders on the client, from the node graph). Org-scoped
// through the job join (the CO/PO hardened pattern). See db.js for the schema.
//
// Endpoints (mounted at /api):
//   GET    /jobs/:jobId/pay-applications     list apps for a job (app_no desc)
//   GET    /pay-applications/:id             single app
//   POST   /jobs/:jobId/pay-applications     create next app (auto app_no,
//                                            carries per-line "previous" from
//                                            the prior app's completed-to-date)
//   PUT    /pay-applications/:id             update lines / period / retainage
//   POST   /pay-applications/:id/status      transition (+ stamp certified_*)
//   DELETE /pay-applications/:id             delete (blocked once certified)
'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

// draft -> submitted -> certified (owner/architect signs) -> paid. You can step
// back one stage while the app is still in flight (e.g. certified -> submitted
// to revise). 'paid' is terminal.
const STATUS_VALUES = ['draft', 'submitted', 'certified', 'paid'];
const ALLOWED_TRANSITIONS = {
  draft: ['submitted'],
  submitted: ['certified', 'draft'],
  certified: ['paid', 'submitted'],
  paid: ['certified']
};

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

// A line's completed-to-date (G703 col G = D+E+F): work completed
// (scheduledValue x pct) plus materials presently stored.
function lineCompleted(l) {
  if (!l) return 0;
  const sched = num(l.scheduledValue);
  const pct = num(l.pctComplete);
  const stored = num(l.stored);
  return (sched * pct / 100) + stored;
}

function shapeRow(r) {
  if (!r) return null;
  const data = (r.data && typeof r.data === 'object') ? r.data : {};
  return {
    id: r.id,
    job_id: r.job_id,
    owner_id: r.owner_id,
    app_no: r.app_no,
    status: r.status,
    period_to: r.period_to,
    retainage_pct: r.retainage_pct != null ? Number(r.retainage_pct) : 10,
    certified_at: r.certified_at,
    certified_by: r.certified_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    lines: Array.isArray(data.lines) ? data.lines : [],
    notes: data.notes || '',
    summary: data.summary || null
  };
}

// Strip canonical columns so they can't be smuggled into the data JSONB.
function cleanData(body) {
  const data = { ...(body || {}) };
  ['id', 'job_id', 'organization_id', 'owner_id', 'app_no', 'status',
   'period_to', 'retainage_pct', 'certified_at', 'certified_by',
   'created_at', 'updated_at'].forEach(k => delete data[k]);
  if (!Array.isArray(data.lines)) data.lines = [];
  return data;
}

// Verify the job is in the caller's org; returns the job row or null.
async function ownedJob(jobId, orgId) {
  const { rows } = await pool.query(
    `SELECT j.id, j.data->>'jobNumber' AS job_number, j.data->>'title' AS job_title
       FROM jobs j
      WHERE j.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
    [jobId, orgId]
  );
  return rows[0] || null;
}

// ── per-job list ────────────────────────────────────────────────────
router.get('/jobs/:jobId/pay-applications',
  requireAuth, requireCapability('FINANCIALS_VIEW'),
  async (req, res) => {
    try {
      const job = await ownedJob(req.params.jobId, req.user.organization_id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      const { rows } = await pool.query(
        `SELECT * FROM pay_applications WHERE job_id = $1 ORDER BY app_no DESC`,
        [req.params.jobId]
      );
      res.json({ pay_applications: rows.map(shapeRow) });
    } catch (e) {
      console.error('GET pay-applications list error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ── single ──────────────────────────────────────────────────────────
router.get('/pay-applications/:id',
  requireAuth, requireCapability('FINANCIALS_VIEW'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT pa.*, j.data->>'jobNumber' AS job_number, j.data->>'title' AS job_title
           FROM pay_applications pa
           JOIN jobs j ON j.id = pa.job_id
          WHERE pa.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
        [req.params.id, req.user.organization_id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const shaped = shapeRow(rows[0]);
      shaped.job_number = rows[0].job_number;
      shaped.job_title = rows[0].job_title;
      res.json({ pay_application: shaped });
    } catch (e) {
      console.error('GET pay-application error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ── create next application ─────────────────────────────────────────
// Body: { period_to?, retainage_pct?, lines[], notes? }. app_no auto-increments;
// each line's "previous" is carried from the prior app's completed-to-date
// (matched by line id) so the G703 D/E split is correct without the client
// tracking history.
router.post('/jobs/:jobId/pay-applications',
  requireAuth, requireCapability('ESTIMATES_EDIT'),
  async (req, res) => {
    try {
      const job = await ownedJob(req.params.jobId, req.user.organization_id);
      if (!job) return res.status(404).json({ error: 'Job not found' });

      // Prior app → next number + per-line previous map.
      const prior = await pool.query(
        `SELECT app_no, data FROM pay_applications WHERE job_id = $1 ORDER BY app_no DESC LIMIT 1`,
        [req.params.jobId]
      );
      const nextNo = prior.rows.length ? (Number(prior.rows[0].app_no) || 0) + 1 : 1;
      const prevByLine = {};
      if (prior.rows.length && prior.rows[0].data && Array.isArray(prior.rows[0].data.lines)) {
        prior.rows[0].data.lines.forEach(l => { if (l && l.id != null) prevByLine[l.id] = lineCompleted(l); });
      }

      const data = cleanData(req.body);
      data.lines = data.lines.map(l => ({
        ...l,
        previous: (l && l.id != null && prevByLine[l.id] != null) ? prevByLine[l.id] : num(l && l.previous)
      }));

      const id = 'pa_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const retPct = req.body.retainage_pct != null ? num(req.body.retainage_pct) : 10;
      const periodTo = (req.body.period_to && String(req.body.period_to).trim()) ? req.body.period_to : null;

      const { rows } = await pool.query(
        `INSERT INTO pay_applications
           (id, job_id, organization_id, owner_id, app_no, status, period_to, retainage_pct, data)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8)
         RETURNING *`,
        [id, req.params.jobId, req.user.organization_id, req.user.id, nextNo, periodTo, retPct, JSON.stringify(data)]
      );
      const shaped = shapeRow(rows[0]);
      shaped.job_number = job.job_number; shaped.job_title = job.job_title;
      res.json({ pay_application: shaped });
    } catch (e) {
      console.error('POST pay-application error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ── update (lines / period / retainage) ─────────────────────────────
router.put('/pay-applications/:id',
  requireAuth, requireCapability('ESTIMATES_EDIT'),
  async (req, res) => {
    try {
      const existing = await pool.query(
        `SELECT pa.status FROM pay_applications pa
           JOIN jobs j ON j.id = pa.job_id
          WHERE pa.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
        [req.params.id, req.user.organization_id]
      );
      if (!existing.rowCount) return res.status(404).json({ error: 'Not found' });
      if (existing.rows[0].status === 'paid') {
        return res.status(409).json({ error: 'Cannot edit a paid application' });
      }
      const data = cleanData(req.body);
      const retProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, 'retainage_pct');
      const periodProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, 'period_to');
      const { rows } = await pool.query(
        `UPDATE pay_applications
            SET data = $1::jsonb,
                retainage_pct = CASE WHEN $2::boolean THEN $3 ELSE retainage_pct END,
                period_to = CASE WHEN $4::boolean THEN $5 ELSE period_to END,
                updated_at = NOW()
          WHERE id = $6
          RETURNING *`,
        [
          JSON.stringify(data),
          !!retProvided, retProvided ? num(req.body.retainage_pct) : null,
          !!periodProvided, periodProvided ? (req.body.period_to || null) : null,
          req.params.id
        ]
      );
      res.json({ pay_application: shapeRow(rows[0]) });
    } catch (e) {
      console.error('PUT pay-application error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ── status transition ───────────────────────────────────────────────
// Body: { status }. On 'certified' we stamp certified_at/by (the owner/
// architect signoff that makes the draw payable).
router.post('/pay-applications/:id/status',
  requireAuth, requireCapability('ESTIMATES_EDIT'),
  async (req, res) => {
    try {
      const next = String((req.body && req.body.status) || '').trim();
      if (STATUS_VALUES.indexOf(next) === -1) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      const existing = await pool.query(
        `SELECT pa.status FROM pay_applications pa
           JOIN jobs j ON j.id = pa.job_id
          WHERE pa.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
        [req.params.id, req.user.organization_id]
      );
      if (!existing.rowCount) return res.status(404).json({ error: 'Not found' });
      const cur = existing.rows[0].status;
      if (cur !== next && (ALLOWED_TRANSITIONS[cur] || []).indexOf(next) === -1) {
        return res.status(409).json({ error: `Cannot move from ${cur} to ${next}` });
      }
      const certifying = next === 'certified';
      const { rows } = await pool.query(
        `UPDATE pay_applications
            SET status = $1,
                certified_at = CASE WHEN $2::boolean THEN NOW() ELSE certified_at END,
                certified_by = CASE WHEN $2::boolean THEN $3 ELSE certified_by END,
                updated_at = NOW()
          WHERE id = $4
          RETURNING *`,
        [next, certifying, req.user.id, req.params.id]
      );
      res.json({ pay_application: shapeRow(rows[0]) });
    } catch (e) {
      console.error('POST pay-application status error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ── delete (blocked once certified) ─────────────────────────────────
router.delete('/pay-applications/:id',
  requireAuth, requireCapability('ESTIMATES_EDIT'),
  async (req, res) => {
    try {
      const existing = await pool.query(
        `SELECT pa.status FROM pay_applications pa
           JOIN jobs j ON j.id = pa.job_id
          WHERE pa.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
        [req.params.id, req.user.organization_id]
      );
      if (!existing.rowCount) return res.status(404).json({ error: 'Not found' });
      if (['certified', 'paid'].indexOf(existing.rows[0].status) !== -1) {
        return res.status(409).json({ error: 'Cannot delete a certified or paid application' });
      }
      await pool.query('DELETE FROM pay_applications WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE pay-application error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
