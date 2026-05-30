// Wave 3 — job workflow items (RFIs, submittals, transmittals).
//
// One route file serving all three workflow types via the unified
// job_workflow_items table. Per-type validation lives here so the
// schema layer stays simple.
//
// Routes:
//   GET    /api/jobs/:jobId/workflow-items?type=rfi&status=open
//   POST   /api/jobs/:jobId/workflow-items
//   GET    /api/workflow-items/:id
//   PUT    /api/workflow-items/:id
//   POST   /api/workflow-items/:id/close   — mark closed + set closed_at
//   POST   /api/workflow-items/:id/archive — soft delete
//   GET    /api/workflow-items/mine        — "items where I'm responsible"
//   GET    /api/workflow-items/overdue     — overdue items for the org

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

// One router serves the global endpoints (/api/workflow-items/...).
// The job-scoped endpoints (/api/jobs/:jobId/workflow-items) are
// mounted under the existing job-routes mount path so the URL nests
// naturally. We export both.
const router = express.Router();
const jobNestedRouter = express.Router({ mergeParams: true });

// Per-type status validation. Routes throw 422 with structured detail
// when a status doesn't match its type. Matches the Wave 1.C error
// envelope shape so 86 + UI can parse it the same way.
const VALID_STATUSES = {
  rfi:         new Set(['open', 'answered', 'closed']),
  submittal:   new Set(['submitted', 'approved', 'revise_resubmit', 'rejected', 'closed']),
  transmittal: new Set(['pending', 'sent', 'received'])
};
// Default starting status per type.
const DEFAULT_STATUS = { rfi: 'open', submittal: 'submitted', transmittal: 'pending' };
// Number prefix per type.
const NUMBER_PREFIX = { rfi: 'RFI', submittal: 'SUB', transmittal: 'TRX' };
// Statuses considered "open" (still needs action). Used by the
// overdue + my-open queries.
const OPEN_STATUSES = {
  rfi:         new Set(['open']),
  submittal:   new Set(['submitted', 'revise_resubmit']),
  transmittal: new Set(['pending'])
};

function validationError(res, msg, detail) {
  return res.status(422).json({
    error: msg,
    detail: detail || { code: 'validation_failed' }
  });
}

// Compute the next number for a (job, type) pair. RFI-01, RFI-02, ...
// Scans the existing rows' numeric suffixes and increments. Idempotent:
// re-running with a held-back number returns the same next value.
async function nextNumber(pool, jobId, type) {
  const r = await pool.query(
    `SELECT number FROM job_workflow_items
      WHERE job_id = $1 AND type = $2 AND number IS NOT NULL
      ORDER BY created_at DESC LIMIT 200`,
    [jobId, type]
  );
  let max = 0;
  for (const row of r.rows) {
    const m = /-(\d+)$/.exec(row.number || '');
    if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
  }
  const prefix = NUMBER_PREFIX[type] || type.toUpperCase();
  return prefix + '-' + String(max + 1).padStart(2, '0');
}

// ──────────────────────────────────────────────────────────────────
// Job-scoped endpoints (mounted at /api/jobs/:jobId/workflow-items).
// ──────────────────────────────────────────────────────────────────

// GET /api/jobs/:jobId/workflow-items
//   Query: ?type=rfi&status=open
jobNestedRouter.get('/workflow-items', requireAuth, async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const type = req.query.type ? String(req.query.type).toLowerCase() : null;
    const status = req.query.status ? String(req.query.status).toLowerCase() : null;
    const params = [jobId, req.user.organization_id];
    let typeClause = '';
    let statusClause = '';
    if (type) {
      params.push(type);
      typeClause = `AND type = $${params.length}`;
    }
    if (status) {
      params.push(status);
      statusClause = `AND status = $${params.length}`;
    }
    const r = await pool.query(
      `SELECT id, type, number, subject, body, status, due_date,
              responsible_user_id, metadata, created_by_user_id,
              closed_at, created_at, updated_at
         FROM job_workflow_items
        WHERE job_id = $1
          AND (organization_id = $2 OR organization_id IS NULL)
          AND archived_at IS NULL
          ${typeClause} ${statusClause}
        ORDER BY created_at DESC`,
      params
    );
    res.json({ items: r.rows });
  } catch (err) {
    console.error('[workflow] list failed:', err.message);
    res.status(500).json({ error: 'Failed to list workflow items' });
  }
});

// POST /api/jobs/:jobId/workflow-items
//   Body: { type, subject, body?, status?, due_date?, responsible_user_id?,
//           metadata?: {...type-specific fields...} }
jobNestedRouter.post('/workflow-items', requireAuth, async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const body = req.body || {};
    const type = String(body.type || '').toLowerCase();
    if (!VALID_STATUSES[type]) {
      return validationError(res, `Unsupported workflow type: '${type}'`, {
        code: 'invalid_enum', field_path: 'type',
        received: type, expected: Object.keys(VALID_STATUSES),
        suggestion: 'Use one of: ' + Object.keys(VALID_STATUSES).join(', ')
      });
    }
    if (!body.subject || !String(body.subject).trim()) {
      return validationError(res, 'subject is required', {
        code: 'missing_field', field_path: 'subject'
      });
    }
    const status = body.status ? String(body.status).toLowerCase() : DEFAULT_STATUS[type];
    if (!VALID_STATUSES[type].has(status)) {
      return validationError(res, `Invalid status '${status}' for type '${type}'`, {
        code: 'invalid_enum', field_path: 'status',
        received: status, expected: [...VALID_STATUSES[type]]
      });
    }
    // Verify job exists + is in caller's org.
    const job = await pool.query(
      'SELECT id FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [jobId, req.user.organization_id]
    );
    if (!job.rows.length) return res.status(404).json({ error: 'Job not found' });

    const id = type + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const number = await nextNumber(pool, jobId, type);
    const r = await pool.query(
      `INSERT INTO job_workflow_items
         (id, organization_id, job_id, type, number, subject, body, status,
          due_date, responsible_user_id, metadata, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
       RETURNING *`,
      [
        id, req.user.organization_id, jobId, type, number,
        String(body.subject).trim(),
        body.body ? String(body.body) : null,
        status,
        body.due_date || null,
        body.responsible_user_id ? Number(body.responsible_user_id) : null,
        JSON.stringify(body.metadata || {}),
        req.user.id
      ]
    );
    res.json({ ok: true, item: r.rows[0] });
  } catch (err) {
    console.error('[workflow] create failed:', err.message);
    res.status(500).json({ error: 'Failed to create workflow item' });
  }
});

// ──────────────────────────────────────────────────────────────────
// Global endpoints (mounted at /api/workflow-items/...).
// ──────────────────────────────────────────────────────────────────

// GET /api/workflow-items/mine — items where I'm the responsible party
// AND status is still "open" per the type.
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, type, number, subject, status, due_date,
              job_id, metadata, created_at
         FROM job_workflow_items
        WHERE responsible_user_id = $1
          AND (organization_id = $2 OR organization_id IS NULL)
          AND archived_at IS NULL
          AND closed_at IS NULL
        ORDER BY (CASE WHEN due_date < CURRENT_DATE THEN 0 ELSE 1 END),
                 due_date ASC NULLS LAST,
                 created_at DESC
        LIMIT 100`,
      [req.user.id, req.user.organization_id]
    );
    res.json({ items: r.rows });
  } catch (err) {
    console.error('[workflow] mine failed:', err.message);
    res.status(500).json({ error: 'Failed to list assigned items' });
  }
});

// GET /api/workflow-items/overdue — org-wide overdue items.
router.get('/overdue', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, type, number, subject, status, due_date,
              job_id, responsible_user_id,
              (CURRENT_DATE - due_date) AS days_overdue
         FROM job_workflow_items
        WHERE (organization_id = $1 OR organization_id IS NULL)
          AND archived_at IS NULL
          AND closed_at IS NULL
          AND due_date IS NOT NULL
          AND due_date < CURRENT_DATE
        ORDER BY due_date ASC
        LIMIT 200`,
      [req.user.organization_id]
    );
    res.json({ items: r.rows });
  } catch (err) {
    console.error('[workflow] overdue failed:', err.message);
    res.status(500).json({ error: 'Failed to list overdue items' });
  }
});

// GET /api/workflow-items/:id — single item with full detail.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM job_workflow_items
        WHERE id = $1
          AND (organization_id = $2 OR organization_id IS NULL)
          AND archived_at IS NULL`,
      [req.params.id, req.user.organization_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ item: r.rows[0] });
  } catch (err) {
    console.error('[workflow] get failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch item' });
  }
});

// PUT /api/workflow-items/:id — update editable fields.
//   Body: { subject?, body?, status?, due_date?, responsible_user_id?,
//           metadata?: {...partial merge into existing JSONB...} }
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    // Fetch existing so we can validate the type-specific status + merge
    // the metadata JSONB.
    const existing = await pool.query(
      `SELECT id, type, status, metadata
         FROM job_workflow_items
        WHERE id = $1
          AND (organization_id = $2 OR organization_id IS NULL)
          AND archived_at IS NULL`,
      [req.params.id, req.user.organization_id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Not found' });
    const cur = existing.rows[0];
    const sets = [];
    const params = [];
    let p = 1;
    function set(col, val) {
      sets.push(`${col} = $${p}`); params.push(val); p++;
    }
    if (body.subject != null) set('subject', String(body.subject).trim());
    if (body.body != null) set('body', body.body ? String(body.body) : null);
    if (body.due_date !== undefined) set('due_date', body.due_date || null);
    if (body.responsible_user_id !== undefined) {
      set('responsible_user_id', body.responsible_user_id ? Number(body.responsible_user_id) : null);
    }
    if (body.status != null) {
      const s = String(body.status).toLowerCase();
      if (!VALID_STATUSES[cur.type].has(s)) {
        return validationError(res, `Invalid status '${s}' for type '${cur.type}'`, {
          code: 'invalid_enum', field_path: 'status',
          received: s, expected: [...VALID_STATUSES[cur.type]]
        });
      }
      set('status', s);
      // closed_at auto-set when status transitions to a terminal one.
      if (s === 'closed' || s === 'approved' || s === 'rejected' || s === 'received') {
        sets.push(`closed_at = NOW()`);
      } else {
        // Re-opening clears closed_at.
        sets.push(`closed_at = NULL`);
      }
    }
    if (body.metadata && typeof body.metadata === 'object') {
      // Shallow merge: pass JSONB || existing for each top-level key in
      // body.metadata. Using `metadata || $N::jsonb` would overwrite —
      // we want a true merge, so build the patch in JS first then write
      // the whole blob. For deeper merging the route caller can read +
      // PATCH explicitly.
      const merged = Object.assign({}, cur.metadata || {}, body.metadata);
      set('metadata', JSON.stringify(merged));
      // The metadata column is JSONB so cast on the way in.
      sets[sets.length - 1] = sets[sets.length - 1] + '::jsonb';
    }
    if (!sets.length) return res.json({ ok: true, unchanged: true });
    sets.push('updated_at = NOW()');
    params.push(req.params.id);
    params.push(req.user.organization_id);
    const r = await pool.query(
      `UPDATE job_workflow_items SET ${sets.join(', ')}
        WHERE id = $${p} AND (organization_id = $${p + 1} OR organization_id IS NULL)
        RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, item: r.rows[0] });
  } catch (err) {
    console.error('[workflow] update failed:', err.message);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// POST /api/workflow-items/:id/archive — soft delete.
router.post('/:id/archive', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE job_workflow_items SET archived_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)
          AND archived_at IS NULL
        RETURNING id`,
      [req.params.id, req.user.organization_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found or already archived' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[workflow] archive failed:', err.message);
    res.status(500).json({ error: 'Failed to archive' });
  }
});

module.exports = router;
module.exports.jobNested = jobNestedRouter;
