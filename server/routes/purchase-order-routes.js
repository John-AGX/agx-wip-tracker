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
// requireOrgId — see the note in client-routes.js. A PO is a subcontract.
const { requireAuth, requireCapability, hasCapability, requireOrgId } = require('../auth');
const { captureExample, TASKS } = require('../services/training-capture');
const jobFin = require('../services/job-financials');
const fileFolders = require('../services/file-folders');
// The tenant boundary on a caller-supplied SUB id. This file writes
// attachment_folder_grants keyed on a body-supplied sub_id and contained no
// sub-org check at all — see the block comment above syncSubAccessForPO.
const { subInOrg } = require('../services/sub-org-scope');

function _norm(v) { return v == null ? '' : String(v).trim().toLowerCase(); }

// ── #4: PO-driven sub access ────────────────────────────────────────
// When a PO is ISSUED to a sub (or a sub is re-assigned on an already-
// issued PO), the sub auto-gains (a) a job-level job_subs assignment and
// (b) view/upload access to the JOB's folders — so the job they're
// working shows up in their portal. Granted at ISSUE, never on a draft,
// so shopping a PO around can't leak access. Idempotent + best-effort:
// safe to call from multiple hooks, and it never blocks the PO write.
//
// THE HOLE THIS CLOSES. sub_id arrives in the REQUEST BODY on both the create
// and the update door, and this file contained no subInOrg / parentSubInOrgSql
// anywhere — the only thing it proved was that the JOB belongs to the caller.
// So an admin in org A could name org B's sub id on a PO, issue it, and this
// function would write org B's sub an attachment_folder_grants row pointed at
// org A's job folder. The sub portal then reads grants BY sub_id alone
// (sub-portal-routes.js), so that is a DURABLE cross-tenant read channel into
// a job's files — created by a normal, authorized-looking PO issue.
//
// Note what stamping could not have fixed: the job_subs INSERT below already
// reads organization_id off the PARENT JOB, so a forged assignment lands
// stamped org A and is indistinguishable from org A's own data. Stamping the
// row REMOVED the orphaned-NULL tell. The rule (services/sub-org-scope.js) is
// to prove the key at the DOOR: a stamp is where the row says which tenant it
// is in; a predicate is where the server decides.
const PO_ACTIVE_STATUS = new Set(['issued', 'approved', 'work_complete', 'closed']);
async function syncSubAccessForPO(poRow, userId, orgId) {
  try {
    if (!poRow || !poRow.sub_id || !poRow.job_id) return;
    if (!PO_ACTIVE_STATUS.has(String(poRow.status || ''))) return;
    const subId = poRow.sub_id, jobId = poRow.job_id;
    // Fail CLOSED: no org, or a sub outside it, grants nothing. This is
    // best-effort by design (it never blocks the PO write), so the refusal is
    // logged rather than thrown — but it is logged, because a silently skipped
    // grant and a silently granted foreign sub look identical from outside.
    if (orgId == null || !(await subInOrg(pool, subId, orgId))) {
      console.warn('[po sub-access] refused: sub ' + subId + ' is not in org ' + orgId +
        ' — no job_subs assignment and no folder grant written for job ' + jobId);
      return;
    }
    // (a) idempotent job-level assignment (building/phase stay node-driven)
    await pool.query(
      // organization_id off the PARENT JOB, never off the caller. A job_subs
      // row belongs to whatever tenant its job belongs to, so reading the stamp
      // from the row makes it unforgeable. It used to land NULL and be healed by
      // the boot backfill; gating that backfill (9c1626a) was correct and turned
      // this into a STANDING null, visible to every tenant through the tolerance
      // arm on every read. Stamp at insert instead — never un-gate the backfill.
      `INSERT INTO job_subs (id, job_id, sub_id, level, building_id, phase_id,
                             contract_amt, billed_to_date, status, notes, organization_id)
       VALUES ($1, $2, $3, 'job', NULL, NULL, 0, 0, 'active', NULL,
               (SELECT organization_id FROM jobs WHERE id = $2))
       ON CONFLICT (job_id, sub_id) DO NOTHING`,
      ['jsub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), jobId, subId]
    );
    // (b) job folder grant — this row is what surfaces the job in the sub portal
    let folderId = null;
    try {
      const leaf = await fileFolders.ensureFolderChain('job', jobId, 'general');
      if (leaf && leaf.id) folderId = leaf.id;
    } catch (e) { /* folder_id NULL still resolves via the string match */ }
    await pool.query(
      `INSERT INTO attachment_folder_grants
         (id, sub_id, entity_type, entity_id, folder, folder_id, granted_by)
       VALUES ($1, $2, 'job', $3, 'general', $4, $5)
       ON CONFLICT (sub_id, entity_type, entity_id, folder) DO UPDATE
         SET granted_at = NOW(), granted_by = EXCLUDED.granted_by,
             folder_id = COALESCE(EXCLUDED.folder_id, attachment_folder_grants.folder_id)`,
      ['afg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), subId, jobId, folderId, userId || null]
    );
  } catch (e) {
    console.warn('[po sub-access] auto-grant failed (non-fatal):', e && e.message);
  }
}

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
    is_locked: !!r.is_locked,
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
              po.data, po.is_locked, po.approved_at, po.approved_by, po.created_at, po.updated_at,
              s.name AS sub_name
         FROM job_purchase_orders po
         JOIN jobs j ON j.id = po.job_id
         LEFT JOIN subs s ON s.id = po.sub_id
        WHERE po.job_id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)
        ORDER BY po.updated_at DESC`,
      [req.params.jobId, req.user.organization_id]
    );
    // Include sub_name (resolved from the subs join) so the per-job PO list shows
    // the subcontractor — the hub list + single-GET already join; this one didn't,
    // so the per-job tab rendered SUB "—" for every PO.
    res.json({ purchase_orders: rows.map(r => Object.assign(shapeRow(r), { sub_name: r.sub_name })) });
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
              po.data, po.is_locked, po.approved_at, po.approved_by, po.created_at, po.updated_at,
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
              po.data, po.is_locked, po.approved_at, po.approved_by, po.created_at, po.updated_at,
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
router.post('/jobs/:jobId/purchase-orders', requireAuth, requireCapability('ESTIMATES_EDIT'), requireOrgId, async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const job = await pool.query(
      `SELECT id, data->>'jobNumber' AS job_number, data->>'title' AS job_title
         FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`,
      [jobId, req.orgId]
    );
    if (!job.rowCount) return res.status(404).json({ error: 'Job not found' });

    const id = 'po_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const poNumber = req.body.po_number || await nextPoNumber(req.orgId);
    const subId = req.body.sub_id || null;
    // A caller-supplied sub id is proved HERE, not just where the grant is
    // written — a PO addressed to another tenant's sub should never exist,
    // let alone be issued. See the block comment above syncSubAccessForPO.
    if (subId && !(await subInOrg(pool, subId, req.orgId))) {
      return res.status(404).json({ error: 'Subcontractor not found' });
    }

    const data = cleanData(req.body);
    // Seed scope from the org template when the caller didn't supply one.
    if (!data.scope || !String(data.scope).trim()) {
      data.scope = await orgScopeTemplate(req.orgId);
    }

    const { rows } = await pool.query(
      `INSERT INTO job_purchase_orders
         (id, job_id, organization_id, owner_id, sub_id, status, po_number, data)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7)
       RETURNING id, job_id, owner_id, sub_id, status, po_number, data,
                 approved_at, approved_by, created_at, updated_at`,
      [id, jobId, req.orgId, req.user.id, subId, poNumber, JSON.stringify(data)]
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
      `SELECT po.status, po.is_locked, po.data,
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
    const existingData = existing.rows[0].data || {};
    const locked = !!existing.rows[0].is_locked;
    const clean = cleanData(req.body);
    // MERGE onto the existing blob so server-owned keys (acceptance/e-sign,
    // addendums, baselineTotal, revising) survive a body that omits them — this
    // is the e-sign-wipe fix. When the PO is LOCKED, its contract fields (lines,
    // scope, title, sub, etc.) are frozen; only internal notes may change until
    // it's unlocked to revise (which then flows through an addendum).
    let data;
    if (locked) {
      data = { ...existingData };
      if (Object.prototype.hasOwnProperty.call(clean, 'internalNotes')) data.internalNotes = clean.internalNotes;
    } else {
      data = { ...existingData, ...clean };
    }
    // sub_id is a contract field — frozen while locked.
    const subProvided = !locked && req.body && Object.prototype.hasOwnProperty.call(req.body, 'sub_id');
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
        RETURNING id, job_id, owner_id, sub_id, status, po_number, data, is_locked,
                  approved_at, approved_by, created_at, updated_at`,
      [JSON.stringify(data), !!subProvided, subId === undefined ? null : subId, id]
    );
    // #4: re-assigning a sub on an already-issued PO auto-grants access
    // (no-op while the PO is still a draft — see syncSubAccessForPO).
    if (rows[0]) syncSubAccessForPO(rows[0], req.user.id, req.user.organization_id);

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

    // Lock the PO once it leaves draft (sent to the sub = issued, or approved) —
    // its price is now committed and can only change via an addendum. `draft` is
    // the only freely-editable status; reverting to it unlocks + clears the frozen
    // baseline. The status POST is preceded by a save-flush client-side, and we
    // read cur.data fresh above, so writing the merged data here can't clobber.
    const curData = cur.rows[0].data || {};
    const newLocked = next !== 'draft';
    const newData = { ...curData };
    delete newData.revising; // leaving revise mode on any transition
    if (newLocked && newData.baselineTotal == null) {
      // Freeze the approved baseline the first time it locks — Σ current lines.
      newData.baselineTotal = (Array.isArray(newData.lines) ? newData.lines : []).reduce((s, l) => {
        if (!l || l.section === '__section_header__') return s;
        return s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0);
      }, 0);
    } else if (!newLocked) {
      // Back to a clean editable draft — the total reverts to Σ lines.
      delete newData.baselineTotal;
    }
    let approvedAt = null, approvedBy = null;
    if (next === 'approved') {
      approvedAt = new Date();
      approvedBy = req.user.id;
      const acc = req.body.acceptance;
      if (acc) {
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
              is_locked = $2,
              data = $3::jsonb,
              approved_at = COALESCE($4, approved_at),
              approved_by = COALESCE($5, approved_by),
              updated_at = NOW()
        WHERE id = $6
        RETURNING id, job_id, owner_id, sub_id, status, po_number, data, is_locked,
                  approved_at, approved_by, created_at, updated_at`,
      [next, newLocked, JSON.stringify(newData), approvedAt, approvedBy, id]
    );
    // #4: issuing/approving a PO auto-grants the assigned sub job + folder access.
    if (rows[0]) syncSubAccessForPO(rows[0], req.user.id, req.user.organization_id);
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

// Σ raw line items (skips section headers). The frozen baseline + each addendum
// delta are measured against this. Mirrors js/jobs.js poRowTotal's raw sum.
function rawLinesTotal(data) {
  return (Array.isArray(data && data.lines) ? data.lines : []).reduce((s, l) => {
    if (!l || l.section === '__section_header__') return s;
    return s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0);
  }, 0);
}
function approvedAddSum(data) {
  return (Array.isArray(data && data.addendums) ? data.addendums : [])
    .reduce((s, a) => s + (a && a.status === 'approved' ? (Number(a.delta) || 0) : 0), 0);
}

// ── unlock to revise (admin) ────────────────────────────────────────
// A locked PO's price is frozen; unlocking lets the line items be edited again,
// after which a price change is recorded as an addendum (POST /addendum).
router.post('/purchase-orders/:id/unlock', requireAuth, requireCapability('JOBS_EDIT_ANY'), async (req, res) => {
  try {
    const id = req.params.id;
    const cur = await pool.query(
      `SELECT po.data, po.status,
              j.data->>'jobNumber' AS job_number, j.data->>'title' AS job_title
         FROM job_purchase_orders po JOIN jobs j ON j.id = po.job_id
        WHERE po.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [id, req.user.organization_id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'Not found' });
    if (cur.rows[0].status === 'closed') return res.status(409).json({ error: 'Cannot unlock a closed purchase order' });
    const data = { ...(cur.rows[0].data || {}), revising: true };
    // Legacy PO locked by the backfill without a frozen baseline: freeze it now
    // (= Σ current lines) so a revision can be measured as an addendum.
    if (data.baselineTotal == null) data.baselineTotal = rawLinesTotal(data);
    const { rows } = await pool.query(
      `UPDATE job_purchase_orders SET is_locked = false, data = $1::jsonb, updated_at = NOW()
        WHERE id = $2
        RETURNING id, job_id, owner_id, sub_id, status, po_number, data, is_locked,
                  approved_at, approved_by, created_at, updated_at`,
      [JSON.stringify(data), id]);
    res.json({ purchase_order: Object.assign(shapeRow(rows[0]), {
      job_number: cur.rows[0].job_number, job_title: cur.rows[0].job_title }) });
  } catch (e) {
    console.error('POST /api/purchase-orders/:id/unlock error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── re-lock (no price change) ───────────────────────────────────────
// Re-freeze a PO that was unlocked to revise but whose PRICE didn't change
// (only title/sub/notes/allocation edited). Clears `revising`. Refuses if the
// current lines total drifted from the committed baseline — a real price
// change must go through /addendum (which e-signs the delta). Mirrors the
// client's poPendingDelta (null baseline ⇒ nothing to reconcile).
router.post('/purchase-orders/:id/relock', requireAuth, requireCapability('JOBS_EDIT_ANY'), async (req, res) => {
  try {
    const id = req.params.id;
    const cur = await pool.query(
      `SELECT po.data, po.status,
              j.data->>'jobNumber' AS job_number, j.data->>'title' AS job_title
         FROM job_purchase_orders po JOIN jobs j ON j.id = po.job_id
        WHERE po.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [id, req.user.organization_id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'Not found' });
    if (cur.rows[0].status === 'closed') return res.status(409).json({ error: 'Cannot re-lock a closed purchase order' });
    const data = cur.rows[0].data || {};
    const pending = (data.baselineTotal == null) ? 0
      : Math.round((rawLinesTotal(data) - (Number(data.baselineTotal) + approvedAddSum(data))) * 100) / 100;
    if (Math.abs(pending) >= 0.005) {
      return res.status(409).json({ error: 'price_changed: record the price change as an addendum (e-sign), not a plain re-lock.' });
    }
    const newData = { ...data };
    delete newData.revising;
    const { rows } = await pool.query(
      `UPDATE job_purchase_orders SET is_locked = true, data = $1::jsonb, updated_at = NOW()
        WHERE id = $2
        RETURNING id, job_id, owner_id, sub_id, status, po_number, data, is_locked,
                  approved_at, approved_by, created_at, updated_at`,
      [JSON.stringify(newData), id]);
    res.json({ purchase_order: Object.assign(shapeRow(rows[0]), {
      job_number: cur.rows[0].job_number, job_title: cur.rows[0].job_title }) });
  } catch (e) {
    console.error('POST /api/purchase-orders/:id/relock error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── record a price-change addendum + re-lock ────────────────────────
// Body: { reason?, approve?: bool, acceptance?: {name,date}, addendumId?: string }
//  - addendumId + approve:true  → approve an existing PENDING addendum.
//  - otherwise                  → capture the current price delta vs the approved
//    total as a new addendum (status approved when approve:true / manual sign,
//    else pending = sent for approval) and re-lock the PO.
router.post('/purchase-orders/:id/addendum', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const id = req.params.id;
    const cur = await pool.query(
      `SELECT po.data,
              j.data->>'jobNumber' AS job_number, j.data->>'title' AS job_title,
              COALESCE((SELECT SUM(amount) FROM job_vendor_bills b
                          WHERE b.po_id = po.id AND b.status <> 'void'), 0) AS billed
         FROM job_purchase_orders po JOIN jobs j ON j.id = po.job_id
        WHERE po.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [id, req.user.organization_id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'Not found' });
    const data = { ...(cur.rows[0].data || {}) };
    if (data.baselineTotal == null) {
      return res.status(400).json({ error: 'This PO has no committed baseline yet — issue or approve it first.' });
    }
    const billed = Number(cur.rows[0].billed) || 0;
    const acc = req.body && req.body.acceptance;
    const acceptance = acc ? { name: acc.name ? String(acc.name).slice(0, 200) : '', date: acc.date || new Date().toISOString().slice(0, 10), accepted: true } : null;
    const addendums = Array.isArray(data.addendums) ? data.addendums.slice() : [];

    // (a) approve an existing pending addendum
    if (req.body && req.body.addendumId && req.body.approve) {
      const idx = addendums.findIndex(a => a && a.id === req.body.addendumId);
      if (idx < 0) return res.status(404).json({ error: 'Addendum not found' });
      const prospective = (Number(data.baselineTotal) || 0) + approvedAddSum(data) + (Number(addendums[idx].delta) || 0);
      if (prospective < billed - 0.005) {
        return res.status(409).json({ error: `Approving this addendum would drop the PO total to ${prospective.toFixed(2)} below the ${billed.toFixed(2)} already billed.` });
      }
      addendums[idx] = { ...addendums[idx], status: 'approved', approvedAt: new Date().toISOString(), approvedBy: req.user.id };
      if (acceptance) addendums[idx].acceptance = acceptance;
      data.addendums = addendums;
    } else {
      // (b) capture the current price change as a new addendum
      const approvedTotal = (Number(data.baselineTotal) || 0) + approvedAddSum(data);
      const linesTotal = rawLinesTotal(data);
      const delta = Math.round((linesTotal - approvedTotal) * 100) / 100;
      if (Math.abs(delta) < 0.005) {
        return res.status(400).json({ error: 'No price change to record — the line items still total the current approved amount.' });
      }
      const willApprove = !!(req.body && req.body.approve);
      if (willApprove && linesTotal < billed - 0.005) {
        return res.status(409).json({ error: `This revision (${linesTotal.toFixed(2)}) is below the ${billed.toFixed(2)} already billed against this PO.` });
      }
      const seq = addendums.length + 1;
      addendums.push({
        id: 'add_' + Date.now().toString(36) + '_' + Math.round(Number(String(id).replace(/\D/g, '').slice(-4) || 0)).toString(36),
        seq, delta, reason: req.body && req.body.reason ? String(req.body.reason).slice(0, 2000) : '',
        status: willApprove ? 'approved' : 'pending',
        createdAt: new Date().toISOString(), createdBy: req.user.id,
        approvedAt: willApprove ? new Date().toISOString() : null,
        acceptance: (willApprove && acceptance) ? acceptance : null
      });
      data.addendums = addendums;
    }
    delete data.revising;

    // Re-lock in every case — a submitted/approved addendum means the price is
    // committed again (pending ones await the sub, approved ones are final).
    const { rows } = await pool.query(
      `UPDATE job_purchase_orders SET is_locked = true, data = $1::jsonb, updated_at = NOW()
        WHERE id = $2
        RETURNING id, job_id, owner_id, sub_id, status, po_number, data, is_locked,
                  approved_at, approved_by, created_at, updated_at`,
      [JSON.stringify(data), id]);
    res.json({ purchase_order: Object.assign(shapeRow(rows[0]), {
      job_number: cur.rows[0].job_number, job_title: cur.rows[0].job_title }) });
  } catch (e) {
    console.error('POST /api/purchase-orders/:id/addendum error:', e);
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
