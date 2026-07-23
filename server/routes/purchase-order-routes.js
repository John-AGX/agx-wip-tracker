// Purchase Order routes — the AGX <-> subcontractor scope-of-work contract.
//
// Net-new entity modeled on Buildertrend POs (see the saved
// reference_buildertrend_po_spec). Shape mirrors change-order-routes:
// canonical lifecycle columns (status, po_number, sub_id, approved_*)
// ride alongside a data JSONB blob holding the editable body — title,
// scope (rich text), lines[], materialsOnly, scheduledCompletion,
// internalNotes, acceptance{name,date,accepted}. Every read/write is
// org-scoped through the job join (the CO routes' hardened pattern).
//
// Endpoints (mounted at /api):
//   GET    /jobs/:jobId/purchase-orders        list POs for a job
//   GET    /purchase-orders                     cross-job org list (Jobs hub)
//   GET    /purchase-orders/scope-template      per-org default scope text
//   PUT    /purchase-orders/scope-template      set per-org default (ROLES_MANAGE)
//   GET    /purchase-orders/:id                 single PO
//   POST   /jobs/:jobId/purchase-orders         create draft (seeds scope template)
//   PUT    /purchase-orders/:id                 update title/scope/lines/sub/etc.
//   POST   /purchase-orders/:id/status          transition + record sub acceptance
//   DELETE /purchase-orders/:id                 delete (blocked once closed)
'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability, hasCapability } = require('../auth');
const { captureExample, TASKS } = require('../services/training-capture');
const jobFin = require('../services/job-financials');

function _norm(v) { return v == null ? '' : String(v).trim().toLowerCase(); }

const router = express.Router();

// draft -> issued (sent to sub) -> approved (sub e-signs) -> work_complete
// -> closed. 'closed' is terminal. You can step back one stage while a PO
// is still in flight (e.g. approved -> issued to revise before work).
const STATUS_VALUES = ['draft', 'issued', 'approved', 'work_complete', 'closed'];
const ALLOWED_TRANSITIONS = {
  draft: ['issued'],
  issued: ['approved', 'draft'],
  approved: ['work_complete', 'issued'],
  work_complete: ['closed', 'approved'],
  closed: []
};

// Built-in default scope-of-work template. Seeded into a new PO's scope
// when the org hasn't set its own (organizations.settings.po_scope_template).
// AGX's standard subcontract agreement — editable per-org in the Command
// Center / org settings. The text lives in services/job-financials.js so a
// PO the AI creates is seeded from the same default as one made in the UI.
const DEFAULT_SCOPE_TEMPLATE = jobFin.DEFAULT_SCOPE_TEMPLATE;


// ── helpers ─────────────────────────────────────────────────────────

// Next PO number — org-wide sequential (Buildertrend numbers POs across the
// company, e.g. "PO-0002"), unlike CO numbers which are per-job. Picks the
// highest numeric suffix on existing PO-#### rows in the org and adds 1.
const nextPoNumber = (orgId) => jobFin.nextPoNumber(pool, orgId);

function shapeRow(r) {
  return {
    ...(r.data || {}),
    id: r.id,
    job_id: r.job_id,
    owner_id: r.owner_id,
    sub_id: r.sub_id,
    status: r.status,
    po_number: r.po_number,
    approved_at: r.approved_at,
    approved_by: r.approved_by,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}

// Strip canonical column fields out of an incoming data blob so they can't
// be smuggled in via the JSONB body.
const cleanData = jobFin.cleanPoData;

const orgScopeTemplate = (orgId) => jobFin.orgScopeTemplate(pool, orgId);

// ── per-job list ────────────────────────────────────────────────────
router.get('/jobs/:jobId/purchase-orders', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT po.id, po.job_id, po.owner_id, po.sub_id, po.status, po.po_number,
              po.data, po.approved_at, po.approved_by, po.created_at, po.updated_at
         FROM job_purchase_orders po
         JOIN jobs j ON j.id = po.job_id
        WHERE po.job_id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)
        ORDER BY po.updated_at DESC`,
      [req.params.jobId, req.user.organization_id]
    );
    res.json({ purchase_orders: rows.map(shapeRow) });
  } catch (e) {
    console.error('GET /api/jobs/:jobId/purchase-orders error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── cross-job org-wide list (Jobs hub) ──────────────────────────────
// Query: ?status=open|all|draft|issued|approved|work_complete|closed,
//        ?job=<jobId>, ?limit=
//   open (default) = not closed.
router.get('/purchase-orders', requireAuth, async (req, res) => {
  try {
    const where = ['(j.organization_id = $1 OR j.organization_id IS NULL)'];
    const params = [req.user.organization_id];
    let pn = 2;
    const statusQ = String(req.query.status || 'open').toLowerCase();
    if (req.query.job) { where.push('po.job_id = $' + (pn++)); params.push(String(req.query.job)); }
    if (statusQ === 'open') {
      where.push("po.status <> 'closed'");
    } else if (statusQ && statusQ !== 'all' && STATUS_VALUES.includes(statusQ)) {
      where.push('po.status = $' + (pn++)); params.push(statusQ);
    }
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 300));
    const { rows } = await pool.query(
      `SELECT po.id, po.job_id, po.owner_id, po.sub_id, po.status, po.po_number,
              po.data, po.approved_at, po.approved_by, po.created_at, po.updated_at,
              j.data->>'jobNumber' AS job_number,
              j.data->>'title'     AS job_title,
              s.name AS sub_name
         FROM job_purchase_orders po
         JOIN jobs j ON j.id = po.job_id
         LEFT JOIN subs s ON s.id = po.sub_id
        WHERE ${where.join(' AND ')}
        ORDER BY po.updated_at DESC
        LIMIT ${limit}`,
      params
    );
    res.json({
      purchase_orders: rows.map(r => Object.assign(shapeRow(r), {
        job_number: r.job_number, job_title: r.job_title, sub_name: r.sub_name
      }))
    });
  } catch (e) {
    console.error('GET /api/purchase-orders error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── per-org default scope template ──────────────────────────────────
router.get('/purchase-orders/scope-template', requireAuth, async (req, res) => {
  try {
    const tpl = await orgScopeTemplate(req.user.organization_id);
    res.json({ template: tpl, is_default: tpl === DEFAULT_SCOPE_TEMPLATE });
  } catch (e) {
    console.error('GET /api/purchase-orders/scope-template error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/purchase-orders/scope-template', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const tpl = (req.body && typeof req.body.template === 'string') ? req.body.template : '';
    await pool.query(
      `UPDATE organizations
          SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('po_scope_template', $1::text)
        WHERE id = $2`,
      [tpl, req.user.organization_id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/purchase-orders/scope-template error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── single PO ───────────────────────────────────────────────────────
router.get('/purchase-orders/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT po.id, po.job_id, po.owner_id, po.sub_id, po.status, po.po_number,
              po.data, po.approved_at, po.approved_by, po.created_at, po.updated_at,
              j.data->>'jobNumber' AS job_number,
              j.data->>'title'     AS job_title,
              s.name AS sub_name
         FROM job_purchase_orders po
         JOIN jobs j ON j.id = po.job_id
         LEFT JOIN subs s ON s.id = po.sub_id
        WHERE po.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [req.params.id, req.user.organization_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({
      purchase_order: Object.assign(shapeRow(rows[0]), {
        job_number: rows[0].job_number, job_title: rows[0].job_title, sub_name: rows[0].sub_name
      })
    });
  } catch (e) {
    console.error('GET /api/purchase-orders/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── create draft ────────────────────────────────────────────────────
// Body: { title?, sub_id?, scope?, lines?, materialsOnly?, scheduledCompletion?,
//         internalNotes?, po_number? }. Scope defaults to the org template.
router.post('/jobs/:jobId/purchase-orders', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const job = await pool.query(
      `SELECT id, data->>'jobNumber' AS job_number, data->>'title' AS job_title
         FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`,
      [jobId, req.user.organization_id]
    );
    if (!job.rowCount) return res.status(404).json({ error: 'Job not found' });

    const id = 'po_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const poNumber = req.body.po_number || await nextPoNumber(req.user.organization_id);
    const subId = req.body.sub_id || null;

    const data = cleanData(req.body);
    // Seed scope from the org template when the caller didn't supply one.
    if (!data.scope || !String(data.scope).trim()) {
      data.scope = await orgScopeTemplate(req.user.organization_id);
    }

    const { rows } = await pool.query(
      `INSERT INTO job_purchase_orders
         (id, job_id, organization_id, owner_id, sub_id, status, po_number, data)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7)
       RETURNING id, job_id, owner_id, sub_id, status, po_number, data,
                 approved_at, approved_by, created_at, updated_at`,
      [id, jobId, req.user.organization_id, req.user.id, subId, poNumber, JSON.stringify(data)]
    );
    res.json({
      purchase_order: Object.assign(shapeRow(rows[0]), {
        job_number: job.rows[0].job_number, job_title: job.rows[0].job_title
      })
    });
  } catch (e) {
    console.error('POST /api/jobs/:jobId/purchase-orders error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── update editable fields ──────────────────────────────────────────
// Status/approval columns are NOT set here (use /status). sub_id IS
// updatable here (re-assigning the sub before issuing is routine).
router.put('/purchase-orders/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await pool.query(
      `SELECT po.status,
              j.data->>'jobNumber' AS job_number,
              j.data->>'title'     AS job_title
         FROM job_purchase_orders po
         JOIN jobs j ON j.id = po.job_id
        WHERE po.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [id, req.user.organization_id]
    );
    if (!existing.rowCount) return res.status(404).json({ error: 'Not found' });
    if (existing.rows[0].status === 'closed') {
      return res.status(409).json({ error: 'Cannot edit a closed purchase order' });
    }
    const data = cleanData(req.body);
    const subProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, 'sub_id');
    const subId = subProvided ? (req.body.sub_id || null) : undefined;

    const { rows } = await pool.query(
      `UPDATE job_purchase_orders
          SET data = $1::jsonb,
              sub_id = CASE WHEN $2::boolean THEN $3 ELSE sub_id END,
              updated_at = CASE
                WHEN data IS DISTINCT FROM $1::jsonb
                  OR ($2::boolean AND sub_id IS DISTINCT FROM $3) THEN NOW()
                ELSE updated_at END
        WHERE id = $4
        RETURNING id, job_id, owner_id, sub_id, status, po_number, data,
                  approved_at, approved_by, created_at, updated_at`,
      [JSON.stringify(data), !!subProvided, subId === undefined ? null : subId, id]
    );

    // Training flywheel: when this save carries the PDF extraction (from the
    // Buildertrend PO importer's close-flush), log extraction-vs-final ONCE.
    // Deterministic id + ON CONFLICT DO NOTHING captures the first flush — the
    // reviewed/edited values — and ignores later re-imports.
    const _ext = req.body && req.body.extraction;
    if (_ext && typeof _ext === 'object' && !Array.isArray(_ext)) {
      const kept =
        _norm(_ext.title) === _norm(data.title) &&
        ((_ext.lines || []).length === (data.lines || []).length) &&
        (!!_ext.materials_only === !!data.materialsOnly);
      captureExample({
        id: 'tex_po_' + id,
        orgId: req.user.organization_id,
        task: TASKS.PO_EXTRACT,
        sourceKind: 'purchase_order',
        sourceId: id,
        input: { source: 'bt_po_pdf' },
        modelOutput: _ext,
        humanFinal: {
          title: data.title || '', scope: data.scope || '',
          materialsOnly: !!data.materialsOnly, scheduledCompletion: data.scheduledCompletion || '',
          sub_id: subProvided ? (subId || null) : null, lines: data.lines || []
        },
        accepted: kept,
        model: process.env.AI_MODEL || 'claude-opus-4-8'
      });
    }

    res.json({
      purchase_order: Object.assign(shapeRow(rows[0]), {
        job_number: existing.rows[0].job_number, job_title: existing.rows[0].job_title
      })
    });
  } catch (e) {
    console.error('PUT /api/purchase-orders/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── status transition (+ record sub acceptance on approve) ──────────
// Body: { status, acceptance?: { name, date } }. On 'approved' we stamp
// approved_at/by and persist data.acceptance (the sub's e-sign) — the PO
// is the executed contract.
router.post('/purchase-orders/:id/status', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const id = req.params.id;
    const next = String(req.body.status || '').toLowerCase();
    if (!STATUS_VALUES.includes(next)) return res.status(400).json({ error: 'Invalid status' });

    const cur = await pool.query(
      `SELECT po.status, po.data,
              j.data->>'jobNumber' AS job_number,
              j.data->>'title'     AS job_title
         FROM job_purchase_orders po
         JOIN jobs j ON j.id = po.job_id
        WHERE po.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [id, req.user.organization_id]
    );
    if (!cur.rowCount) return res.status(404).json({ error: 'Not found' });
    const current = cur.rows[0].status;
    if (!ALLOWED_TRANSITIONS[current].includes(next)) {
      return res.status(409).json({ error: 'Transition not allowed: ' + current + ' -> ' + next });
    }

    // Only the 'approved' transition touches data (the acceptance merge) —
    // and only when the caller actually sent an acceptance. Every other
    // transition updates status/timestamps alone, so a status POST can
    // never clobber a concurrently-saved data blob (or forge an e-sign
    // block on the bulk path, which sends no acceptance).
    let approvedAt = null, approvedBy = null;
    let newData = null;
    if (next === 'approved') {
      approvedAt = new Date();
      approvedBy = req.user.id;
      const acc = req.body.acceptance;
      if (acc) {
        newData = { ...(cur.rows[0].data || {}) };
        newData.acceptance = {
          name: acc.name ? String(acc.name).slice(0, 200) : '',
          date: acc.date || new Date().toISOString().slice(0, 10),
          accepted: true
        };
      }
    }

    const { rows } = await pool.query(
      `UPDATE job_purchase_orders
          SET status = $1,
              data = CASE WHEN $2::boolean THEN $3::jsonb ELSE data END,
              approved_at = COALESCE($4, approved_at),
              approved_by = COALESCE($5, approved_by),
              updated_at = NOW()
        WHERE id = $6
        RETURNING id, job_id, owner_id, sub_id, status, po_number, data,
                  approved_at, approved_by, created_at, updated_at`,
      [next, newData !== null, newData !== null ? JSON.stringify(newData) : null, approvedAt, approvedBy, id]
    );
    res.json({
      purchase_order: Object.assign(shapeRow(rows[0]), {
        job_number: cur.rows[0].job_number, job_title: cur.rows[0].job_title
      })
    });
  } catch (e) {
    console.error('POST /api/purchase-orders/:id/status error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── delete (admin or owner; blocked once closed) ────────────────────
router.delete('/purchase-orders/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT po.owner_id, po.status FROM job_purchase_orders po
         JOIN jobs j ON j.id = po.job_id
        WHERE po.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [req.params.id, req.user.organization_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const isPrivileged = req.user.role === 'admin' || hasCapability(req.user, 'JOBS_EDIT_ANY');
    if (!isPrivileged && rows[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'No delete access' });
    }
    if (rows[0].status === 'closed') {
      return res.status(409).json({ error: 'Cannot delete a closed purchase order' });
    }
    await pool.query('DELETE FROM job_purchase_orders WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/purchase-orders/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
