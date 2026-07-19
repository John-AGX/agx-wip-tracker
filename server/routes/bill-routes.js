// Vendor Bills — Accounts Payable. A Bill is a vendor's invoice recorded
// against a job and (usually) a Purchase Order: the money AGX OWES a
// sub/supplier. This is the mirror image of invoice-routes.js (Accounts
// Receivable). Shape mirrors job_purchase_orders: canonical lifecycle columns
// (status, bill_number, po_id, sub_id, amount, dates) ride alongside a `data`
// JSONB blob (lienWaiver, description, lines[], notes, attachmentId). Every
// read/write is org-scoped through the job join.
//
// Endpoints (mounted at /api):
//   GET    /jobs/:jobId/bills          list bills for a job
//   GET    /bills                       cross-job org list (Jobs hub)  ?status ?job ?po ?limit
//   GET    /bills/ap-aging              AP aging buckets (payables owed)
//   GET    /bills/:id                   single bill
//   POST   /jobs/:jobId/bills           create (links a PO, derives vendor)
//   PUT    /bills/:id                   update editable fields
//   POST   /bills/:id/status            transition status
//   DELETE /bills/:id                   delete
'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability, hasCapability } = require('../auth');

const router = express.Router();

// open (received, unpaid) -> approved (OK to pay) -> paid. void = discarded.
const STATUS_VALUES = ['open', 'approved', 'paid', 'void'];
const ALLOWED_TRANSITIONS = {
  open: ['approved', 'void', 'paid'],
  approved: ['paid', 'open', 'void'],
  paid: ['approved', 'open'],
  void: ['open']
};

function money(v) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
}
function dateOrNull(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function shapeRow(r) {
  return {
    ...(r.data || {}),
    id: r.id,
    job_id: r.job_id,
    owner_id: r.owner_id,
    po_id: r.po_id,
    sub_id: r.sub_id,
    status: r.status,
    bill_number: r.bill_number,
    amount: r.amount != null ? Number(r.amount) : 0,
    bill_date: r.bill_date,
    due_date: r.due_date,
    approved_at: r.approved_at,
    approved_by: r.approved_by,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}

// Strip canonical fields from an incoming JSONB body so they can't be smuggled in.
function cleanData(body) {
  const data = { ...(body || {}) };
  ['id', 'job_id', 'owner_id', 'po_id', 'sub_id', 'status', 'bill_number', 'amount',
   'bill_date', 'due_date', 'approved_at', 'approved_by', 'created_at', 'updated_at'].forEach((k) => delete data[k]);
  // Do NOT force lines:[] here — the PUT merges this blob (data || $1), so an
  // injected empty lines would clobber a bill's real data.lines (e.g. future
  // OCR line items). Callers that need lines pass them explicitly.
  return data;
}

// Org-wide sequential BILL-#### (like PO numbers).
async function nextBillNumber(orgId) {
  const { rows } = await pool.query(
    `SELECT bill_number FROM job_vendor_bills
      WHERE (organization_id = $1 OR organization_id IS NULL) AND bill_number ~ '^BILL-[0-9]+$'`,
    [orgId]);
  let maxN = 0;
  for (const r of rows) { const n = parseInt(String(r.bill_number).slice(5), 10); if (!isNaN(n) && n > maxN) maxN = n; }
  return 'BILL-' + String(maxN + 1).padStart(4, '0');
}

const SELECT_COLS = `b.id, b.job_id, b.owner_id, b.po_id, b.sub_id, b.status, b.bill_number,
  b.amount, b.bill_date, b.due_date, b.data, b.approved_at, b.approved_by, b.created_at, b.updated_at`;

// ── per-job list ────────────────────────────────────────────────────
router.get('/jobs/:jobId/bills', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS}, po.po_number AS po_number, s.name AS sub_name
         FROM job_vendor_bills b
         JOIN jobs j ON j.id = b.job_id
         LEFT JOIN job_purchase_orders po ON po.id = b.po_id
         LEFT JOIN subs s ON s.id = b.sub_id
        WHERE b.job_id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)
        ORDER BY b.updated_at DESC`,
      [req.params.jobId, req.user.organization_id]);
    res.json({ bills: rows.map((r) => Object.assign(shapeRow(r), { po_number: r.po_number, sub_name: r.sub_name })) });
  } catch (e) {
    console.error('GET /api/jobs/:jobId/bills error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── cross-job org-wide list (Jobs hub) ──────────────────────────────
router.get('/bills', requireAuth, async (req, res) => {
  try {
    const where = ['(j.organization_id = $1 OR j.organization_id IS NULL)'];
    const params = [req.user.organization_id];
    let pn = 2;
    const statusQ = String(req.query.status || 'open').toLowerCase();
    if (req.query.job) { where.push('b.job_id = $' + (pn++)); params.push(String(req.query.job)); }
    if (req.query.po) { where.push('b.po_id = $' + (pn++)); params.push(String(req.query.po)); }
    if (statusQ === 'open') where.push("b.status IN ('open','approved')");
    else if (statusQ === 'unpaid') where.push("b.status <> 'paid' AND b.status <> 'void'");
    else if (statusQ && statusQ !== 'all' && STATUS_VALUES.includes(statusQ)) { where.push('b.status = $' + (pn++)); params.push(statusQ); }
    // Cap generously: the client boot-load pulls the whole org's bills into
    // the cost-rollup store, so a low cap would silently truncate "billed".
    const limit = Math.min(50000, Math.max(1, parseInt(req.query.limit, 10) || 300));
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS}, j.data->>'jobNumber' AS job_number, j.data->>'title' AS job_title,
              po.po_number AS po_number, s.name AS sub_name
         FROM job_vendor_bills b
         JOIN jobs j ON j.id = b.job_id
         LEFT JOIN job_purchase_orders po ON po.id = b.po_id
         LEFT JOIN subs s ON s.id = b.sub_id
        WHERE ${where.join(' AND ')}
        ORDER BY b.updated_at DESC
        LIMIT ${limit}`,
      params);
    res.json({ bills: rows.map((r) => Object.assign(shapeRow(r),
      { job_number: r.job_number, job_title: r.job_title, po_number: r.po_number, sub_name: r.sub_name })) });
  } catch (e) {
    console.error('GET /api/bills error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── AP aging (payables owed to vendors) ─────────────────────────────
router.get('/bills/ap-aging', requireAuth, requireCapability('FINANCIALS_VIEW'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.status, b.amount, b.due_date, b.bill_date
         FROM job_vendor_bills b JOIN jobs j ON j.id = b.job_id
        WHERE (j.organization_id = $1 OR j.organization_id IS NULL) AND b.status IN ('open','approved')`,
      [req.user.organization_id]);
    const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    rows.forEach((r) => {
      const amt = Number(r.amount) || 0;
      buckets.total += amt;
      const due = r.due_date ? new Date(r.due_date) : (r.bill_date ? new Date(r.bill_date) : null);
      if (!due || due >= today) { buckets.current += amt; return; }
      const days = Math.floor((today - due) / 86400000);
      if (days <= 30) buckets.d1_30 += amt; else if (days <= 60) buckets.d31_60 += amt;
      else if (days <= 90) buckets.d61_90 += amt; else buckets.d90_plus += amt;
    });
    res.json({ aging: buckets });
  } catch (e) {
    console.error('GET /api/bills/ap-aging error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── single bill ─────────────────────────────────────────────────────
router.get('/bills/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS}, j.data->>'jobNumber' AS job_number, j.data->>'title' AS job_title,
              po.po_number AS po_number, s.name AS sub_name
         FROM job_vendor_bills b
         JOIN jobs j ON j.id = b.job_id
         LEFT JOIN job_purchase_orders po ON po.id = b.po_id
         LEFT JOIN subs s ON s.id = b.sub_id
        WHERE b.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [req.params.id, req.user.organization_id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ bill: Object.assign(shapeRow(rows[0]),
      { job_number: rows[0].job_number, job_title: rows[0].job_title, po_number: rows[0].po_number, sub_name: rows[0].sub_name }) });
  } catch (e) {
    console.error('GET /api/bills/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Resolve a PO (org-scoped) → its job_id + sub_id, for link + vendor derivation.
async function poContext(orgId, poId) {
  if (!poId) return null;
  const { rows } = await pool.query(
    `SELECT po.id, po.job_id, po.sub_id FROM job_purchase_orders po
       JOIN jobs j ON j.id = po.job_id
      WHERE po.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
    [poId, orgId]);
  return rows[0] || null;
}

// ── create ──────────────────────────────────────────────────────────
// Body: { po_id?, sub_id?, bill_number?, amount, bill_date?, due_date?,
//         data:{ lienWaiver?, description?, lines?, notes? } }
router.post('/jobs/:jobId/bills', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const job = await pool.query(
      `SELECT id, data->>'jobNumber' AS job_number, data->>'title' AS job_title
         FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`,
      [jobId, req.user.organization_id]);
    if (!job.rowCount) return res.status(404).json({ error: 'Job not found' });

    const b = req.body || {};
    const po = b.po_id ? await poContext(req.user.organization_id, b.po_id) : null;
    if (b.po_id && !po) return res.status(400).json({ error: 'Linked PO not found in this org' });
    if (po && po.job_id !== jobId) return res.status(400).json({ error: 'That PO belongs to a different job' });

    const id = 'bill_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const billNumber = (b.bill_number && String(b.bill_number).trim().slice(0, 60)) || await nextBillNumber(req.user.organization_id);
    // Vendor: explicit sub_id wins, else inherit the PO's sub.
    const subId = (b.sub_id != null ? (b.sub_id || null) : (po ? po.sub_id : null));
    const data = cleanData(b.data || b);

    const { rows } = await pool.query(
      `INSERT INTO job_vendor_bills
         (id, job_id, organization_id, owner_id, po_id, sub_id, status, bill_number, amount, bill_date, due_date, data)
       VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11)
       RETURNING ${SELECT_COLS.replace(/b\./g, '')}`,
      [id, jobId, req.user.organization_id, req.user.id, b.po_id || null, subId, billNumber,
       money(b.amount), dateOrNull(b.bill_date), dateOrNull(b.due_date), JSON.stringify(data)]);
    res.json({ bill: Object.assign(shapeRow(rows[0]), { job_number: job.rows[0].job_number, job_title: job.rows[0].job_title }) });
  } catch (e) {
    console.error('POST /api/jobs/:jobId/bills error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── update editable fields ──────────────────────────────────────────
router.put('/bills/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await pool.query(
      `SELECT b.status, b.job_id FROM job_vendor_bills b
         JOIN jobs j ON j.id = b.job_id
        WHERE b.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [id, req.user.organization_id]);
    if (!existing.rowCount) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    // Re-link PO: validate + inherit vendor if not explicitly set.
    let poId; let subInherit;
    if (has('po_id')) {
      poId = b.po_id || null;
      if (poId) {
        const po = await poContext(req.user.organization_id, poId);
        if (!po) return res.status(400).json({ error: 'Linked PO not found in this org' });
        if (po.job_id !== existing.rows[0].job_id) return res.status(400).json({ error: 'That PO belongs to a different job' });
        if (!has('sub_id')) subInherit = po.sub_id;
      }
    }
    const data = cleanData(b.data || b);
    const { rows } = await pool.query(
      `UPDATE job_vendor_bills SET
          data = COALESCE(data, '{}'::jsonb) || $1::jsonb,
          amount = CASE WHEN $2::boolean THEN $3 ELSE amount END,
          bill_number = CASE WHEN $4::boolean THEN $5 ELSE bill_number END,
          bill_date = CASE WHEN $6::boolean THEN $7 ELSE bill_date END,
          due_date = CASE WHEN $8::boolean THEN $9 ELSE due_date END,
          po_id = CASE WHEN $10::boolean THEN $11 ELSE po_id END,
          sub_id = CASE WHEN $12::boolean THEN $13 WHEN $14::boolean THEN $15 ELSE sub_id END,
          updated_at = NOW()
        WHERE id = $16
        RETURNING ${SELECT_COLS.replace(/b\./g, '')}`,
      [JSON.stringify(data),
       has('amount'), money(b.amount),
       has('bill_number'), b.bill_number ? String(b.bill_number).trim().slice(0, 60) : null,
       has('bill_date'), dateOrNull(b.bill_date),
       has('due_date'), dateOrNull(b.due_date),
       has('po_id'), poId === undefined ? null : poId,
       has('sub_id'), b.sub_id || null, subInherit !== undefined, subInherit === undefined ? null : subInherit,
       id]);
    res.json({ bill: shapeRow(rows[0]) });
  } catch (e) {
    console.error('PUT /api/bills/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── status transition ───────────────────────────────────────────────
router.post('/bills/:id/status', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const id = req.params.id;
    const next = String(req.body.status || '').toLowerCase();
    if (!STATUS_VALUES.includes(next)) return res.status(400).json({ error: 'Invalid status' });
    const cur = await pool.query(
      `SELECT b.status FROM job_vendor_bills b JOIN jobs j ON j.id = b.job_id
        WHERE b.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [id, req.user.organization_id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'Not found' });
    const current = cur.rows[0].status;
    if (!ALLOWED_TRANSITIONS[current].includes(next)) return res.status(409).json({ error: 'Transition not allowed: ' + current + ' -> ' + next });
    const paidAt = next === 'paid' ? new Date() : null;
    const { rows } = await pool.query(
      `UPDATE job_vendor_bills SET status = $1,
          approved_at = CASE WHEN $1 IN ('approved','paid') THEN COALESCE(approved_at, NOW()) ELSE approved_at END,
          approved_by = CASE WHEN $1 IN ('approved','paid') THEN COALESCE(approved_by, $2) ELSE approved_by END,
          data = CASE WHEN $3::timestamptz IS NOT NULL THEN COALESCE(data,'{}'::jsonb) || jsonb_build_object('paidAt', $3::text) ELSE data END,
          updated_at = NOW()
        WHERE id = $4
        RETURNING ${SELECT_COLS.replace(/b\./g, '')}`,
      [next, req.user.id, paidAt, id]);
    res.json({ bill: shapeRow(rows[0]) });
  } catch (e) {
    console.error('POST /api/bills/:id/status error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── delete (admin or owner) ─────────────────────────────────────────
router.delete('/bills/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.owner_id FROM job_vendor_bills b JOIN jobs j ON j.id = b.job_id
        WHERE b.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
      [req.params.id, req.user.organization_id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const isPrivileged = req.user.role === 'admin' || hasCapability(req.user, 'JOBS_EDIT_ANY');
    if (!isPrivileged && rows[0].owner_id !== req.user.id) return res.status(403).json({ error: 'No delete access' });
    await pool.query('DELETE FROM job_vendor_bills WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/bills/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
