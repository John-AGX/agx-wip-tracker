// Accounts receivable — invoices + payments (cash receipts).
// The AR foundation for taking billing in-house: promotes invoices off the
// old localStorage job.data.invoices blob into first-class, org-scoped,
// cross-device records, records customer payments, applies cash to invoices,
// bridges a certified AIA pay application into an invoice, and reports AR
// aging. Org-scoped directly on invoices/payments.organization_id (invoices
// may be standalone, so we don't scope through the job join). See db.js.
//
// Endpoints (mounted at /api):
//   GET    /invoices                                  list (status/job/client filters)
//   GET    /jobs/:jobId/invoices                       per-job list
//   GET    /invoices/:id                               single (+ payments)
//   POST   /invoices                                   create (auto INV-####)
//   POST   /jobs/:jobId/invoices/from-pay-application/:payAppId   bridge a draw → invoice
//   PUT    /invoices/:id                               update (recompute totals)
//   POST   /invoices/:id/status                        draft→sent→paid→void
//   DELETE /invoices/:id                               delete (blocked if paid)
//   GET    /payments                                   list
//   POST   /payments                                   record + apply to invoices
//   PUT    /payments/:id                               update + re-apply
//   DELETE /payments/:id                               delete + re-recompute invoices
//   GET    /ar/aging                                   AR aging summary
'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');
const jobFin = require('../services/job-financials');

const router = express.Router();

const INVOICE_STATUSES = ['draft', 'sent', 'partial', 'paid', 'void'];
const PAYMENT_METHODS = ['check', 'ach', 'card', 'cash', 'wire', 'other'];

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function round2(n) { return Math.round(num(n) * 100) / 100; }
function genId(p) { return p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

// A line's amount, the invoice totals, and the INV-#### sequence all live in
// services/job-financials.js — the AI payload dispatcher creates invoices
// through that same module, so a total it derives matches this one exactly.
const lineAmount = jobFin.lineAmount;
const computeTotals = jobFin.computeInvoiceTotals;
const nextInvoiceNumber = (orgId) => jobFin.nextInvoiceNumber(pool, orgId);

function shapeInvoice(r) {
  if (!r) return null;
  const data = (r.data && typeof r.data === 'object') ? r.data : {};
  const total = num(r.total), paid = num(r.amount_paid);
  return {
    id: r.id, organization_id: r.organization_id, owner_id: r.owner_id,
    job_id: r.job_id, client_id: r.client_id, pay_application_id: r.pay_application_id,
    invoice_number: r.invoice_number, status: r.status,
    issue_date: r.issue_date, due_date: r.due_date, terms: r.terms,
    subtotal: num(r.subtotal), tax_pct: num(r.tax_pct), tax_amount: num(r.tax_amount),
    retainage_amount: num(r.retainage_amount), total: total, amount_paid: paid,
    balance: round2(total - paid),
    lines: Array.isArray(data.lines) ? data.lines : [],
    notes: data.notes || '', billTo: data.billTo || null,
    sent_at: r.sent_at, paid_at: r.paid_at,
    created_at: r.created_at, updated_at: r.updated_at,
    job_number: r.job_number, job_title: r.job_title
  };
}
function shapePayment(r) {
  if (!r) return null;
  const data = (r.data && typeof r.data === 'object') ? r.data : {};
  const apps = Array.isArray(data.applications) ? data.applications : [];
  const applied = apps.reduce((s, a) => s + num(a.amount), 0);
  return {
    id: r.id, organization_id: r.organization_id, owner_id: r.owner_id,
    client_id: r.client_id, payment_date: r.payment_date, amount: num(r.amount),
    method: r.method, reference: r.reference,
    applications: apps, applied: round2(applied), unapplied: round2(num(r.amount) - applied),
    notes: data.notes || '', created_at: r.created_at, updated_at: r.updated_at
  };
}

// Recompute one invoice's amount_paid + status from all payments that apply to
// it (sum of application amounts across the org's payments). Called after any
// payment create/update/delete. Preserves void; a draft that gets paid becomes
// sent→partial/paid so it never silently jumps past "sent".
async function recomputeInvoicePaid(invoiceId, orgId) {
  const { rows } = await pool.query(
    `SELECT data FROM payments WHERE (organization_id = $1 OR ($1 IS NULL AND organization_id IS NULL))`,
    [orgId]
  );
  let paid = 0;
  for (const r of rows) {
    const apps = (r.data && Array.isArray(r.data.applications)) ? r.data.applications : [];
    apps.forEach(a => { if (a && a.invoice_id === invoiceId) paid += num(a.amount); });
  }
  paid = round2(paid);
  const inv = await pool.query(`SELECT total, status FROM invoices WHERE id = $1`, [invoiceId]);
  if (!inv.rowCount) return;
  const total = num(inv.rows[0].total), cur = inv.rows[0].status;
  let status = cur;
  if (cur !== 'void') {
    if (paid <= 0.005) status = (cur === 'paid' || cur === 'partial') ? 'sent' : cur;
    else if (paid + 0.005 >= total) status = 'paid';
    else status = 'partial';
  }
  const paidAt = (status === 'paid') ? 'NOW()' : 'NULL';
  await pool.query(
    `UPDATE invoices SET amount_paid = $1, status = $2,
        paid_at = CASE WHEN $2 = 'paid' THEN COALESCE(paid_at, NOW()) ELSE NULL END,
        updated_at = NOW() WHERE id = $3`,
    [paid, status, invoiceId]
  );
}

// Org guard for a job (for per-job routes).
async function ownedJob(jobId, orgId) {
  const { rows } = await pool.query(
    `SELECT id, data->>'jobNumber' AS job_number, data->>'title' AS job_title,
            data->>'client' AS client_name, client_id
       FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`,
    [jobId, orgId]
  );
  return rows[0] || null;
}

// ── invoice list ────────────────────────────────────────────────────
router.get('/invoices', requireAuth, requireCapability('FINANCIALS_VIEW'), async (req, res) => {
  try {
    const org = req.user.organization_id;
    const clauses = ['(i.organization_id = $1 OR i.organization_id IS NULL)'];
    const params = [org];
    if (req.query.status && INVOICE_STATUSES.includes(req.query.status)) { params.push(req.query.status); clauses.push(`i.status = $${params.length}`); }
    if (req.query.job_id) { params.push(req.query.job_id); clauses.push(`i.job_id = $${params.length}`); }
    if (req.query.client_id) { params.push(String(req.query.client_id)); clauses.push(`i.client_id = $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT i.*, j.data->>'jobNumber' AS job_number, j.data->>'title' AS job_title
         FROM invoices i LEFT JOIN jobs j ON j.id = i.job_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY i.issue_date DESC NULLS LAST, i.created_at DESC`,
      params
    );
    res.json({ invoices: rows.map(shapeInvoice) });
  } catch (e) { console.error('GET invoices error:', e); res.status(500).json({ error: 'Server error' }); }
});

router.get('/jobs/:jobId/invoices', requireAuth, requireCapability('FINANCIALS_VIEW'), async (req, res) => {
  try {
    const job = await ownedJob(req.params.jobId, req.user.organization_id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const { rows } = await pool.query(
      `SELECT * FROM invoices WHERE job_id = $1 ORDER BY issue_date DESC NULLS LAST, created_at DESC`,
      [req.params.jobId]
    );
    res.json({ invoices: rows.map(shapeInvoice) });
  } catch (e) { console.error('GET job invoices error:', e); res.status(500).json({ error: 'Server error' }); }
});

router.get('/invoices/:id', requireAuth, requireCapability('FINANCIALS_VIEW'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, j.data->>'jobNumber' AS job_number, j.data->>'title' AS job_title
         FROM invoices i LEFT JOIN jobs j ON j.id = i.job_id
        WHERE i.id = $1 AND (i.organization_id = $2 OR i.organization_id IS NULL)`,
      [req.params.id, req.user.organization_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ invoice: shapeInvoice(rows[0]) });
  } catch (e) { console.error('GET invoice error:', e); res.status(500).json({ error: 'Server error' }); }
});

// ── create invoice ──────────────────────────────────────────────────
router.post('/invoices', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const b = req.body || {};
    const org = req.user.organization_id;
    const data = { lines: Array.isArray(b.lines) ? b.lines : [], notes: b.notes || '', billTo: b.billTo || null };
    const t = computeTotals(data, b.tax_pct, b.retainage_amount);
    const id = genId('inv');
    const number = (b.invoice_number && String(b.invoice_number).trim()) || await nextInvoiceNumber(org);
    const { rows } = await pool.query(
      `INSERT INTO invoices (id, organization_id, owner_id, job_id, client_id, pay_application_id,
          invoice_number, status, issue_date, due_date, terms,
          subtotal, tax_pct, tax_amount, retainage_amount, total, amount_paid, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13,$14,$15,0,$16)
       RETURNING *`,
      [id, org, req.user.id, b.job_id || null, b.client_id != null ? String(b.client_id) : null,
       b.pay_application_id || null, number, b.issue_date || null, b.due_date || null, b.terms || null,
       t.subtotal, num(b.tax_pct), t.taxAmount, t.retainageAmount, t.total, JSON.stringify(data)]
    );
    res.json({ invoice: shapeInvoice(rows[0]) });
  } catch (e) { console.error('POST invoice error:', e); res.status(500).json({ error: 'Server error' }); }
});

// ── bridge: certified pay application → draft invoice ───────────────
// Bills the current period's draw (Σ this-period work) less this-period
// retainage, so the invoice total equals the pay app's Current Payment Due.
router.post('/jobs/:jobId/invoices/from-pay-application/:payAppId',
  requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
    try {
      const org = req.user.organization_id;
      const job = await ownedJob(req.params.jobId, org);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      const pa = await pool.query(
        `SELECT pa.* FROM pay_applications pa
          WHERE pa.id = $1 AND pa.job_id = $2 AND (pa.organization_id = $3 OR pa.organization_id IS NULL)`,
        [req.params.payAppId, req.params.jobId, org]
      );
      if (!pa.rowCount) return res.status(404).json({ error: 'Pay application not found' });
      const app = pa.rows[0];
      const paData = (app.data && typeof app.data === 'object') ? app.data : {};
      const paLines = Array.isArray(paData.lines) ? paData.lines : [];
      const appRet = num(app.retainage_pct);
      // this-period gross + retainage from the frozen SOV lines
      let periodGross = 0, periodRetain = 0;
      paLines.forEach(l => {
        const sched = num(l.scheduledValue), pct = num(l.pctComplete), stored = num(l.stored);
        const G = round2(sched * pct / 100 + stored);
        const thisPeriod = round2(G - num(l.previous));
        const rp = (l.retainagePct != null && l.retainagePct !== '') ? num(l.retainagePct) : appRet;
        periodGross += thisPeriod;
        periodRetain += round2(thisPeriod * rp / 100);
      });
      periodGross = round2(periodGross); periodRetain = round2(periodRetain);
      const data = {
        lines: [{ id: genId('il'), description: 'Application for Payment No. ' + app.app_no +
          ' — work completed this period', qty: 1, unitPrice: periodGross, amount: periodGross, taxable: false }],
        notes: 'Generated from certified Application for Payment No. ' + app.app_no + '.',
        billTo: job.client_name ? { name: job.client_name } : null
      };
      const t = computeTotals(data, 0, periodRetain);
      const id = genId('inv');
      const number = await nextInvoiceNumber(org);
      const today = new Date().toISOString().slice(0, 10);
      const { rows } = await pool.query(
        `INSERT INTO invoices (id, organization_id, owner_id, job_id, client_id, pay_application_id,
            invoice_number, status, issue_date, terms,
            subtotal, tax_pct, tax_amount, retainage_amount, total, amount_paid, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,0,$11,$12,$13,0,$14) RETURNING *`,
        [id, org, req.user.id, req.params.jobId, job.client_id != null ? String(job.client_id) : null,
         app.id, number, today, 'Net 30', t.subtotal, t.taxAmount, t.retainageAmount, t.total, JSON.stringify(data)]
      );
      const shaped = shapeInvoice(rows[0]); shaped.job_number = job.job_number; shaped.job_title = job.job_title;
      res.json({ invoice: shaped });
    } catch (e) { console.error('POST invoice-from-payapp error:', e); res.status(500).json({ error: 'Server error' }); }
  });

// ── update invoice ──────────────────────────────────────────────────
router.put('/invoices/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const org = req.user.organization_id;
    const cur = await pool.query(
      `SELECT status, data FROM invoices WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`,
      [req.params.id, org]
    );
    if (!cur.rowCount) return res.status(404).json({ error: 'Not found' });
    if (cur.rows[0].status === 'paid') return res.status(409).json({ error: 'Cannot edit a paid invoice' });
    const b = req.body || {};
    const prev = (cur.rows[0].data && typeof cur.rows[0].data === 'object') ? cur.rows[0].data : {};
    const data = {
      lines: Array.isArray(b.lines) ? b.lines : (prev.lines || []),
      notes: b.notes != null ? b.notes : (prev.notes || ''),
      billTo: b.billTo != null ? b.billTo : (prev.billTo || null)
    };
    const t = computeTotals(data, b.tax_pct, b.retainage_amount);
    const { rows } = await pool.query(
      `UPDATE invoices SET job_id = COALESCE($2, job_id), client_id = COALESCE($3, client_id),
          issue_date = $4, due_date = $5, terms = $6,
          subtotal = $7, tax_pct = $8, tax_amount = $9, retainage_amount = $10, total = $11,
          data = $12::jsonb, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [req.params.id, b.job_id || null, b.client_id != null ? String(b.client_id) : null,
       b.issue_date || null, b.due_date || null, b.terms || null,
       t.subtotal, num(b.tax_pct), t.taxAmount, t.retainageAmount, t.total, JSON.stringify(data)]
    );
    await recomputeInvoicePaid(req.params.id, org); // total may have changed → status
    const fresh = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [req.params.id]);
    res.json({ invoice: shapeInvoice(fresh.rows[0]) });
  } catch (e) { console.error('PUT invoice error:', e); res.status(500).json({ error: 'Server error' }); }
});

// ── invoice status ──────────────────────────────────────────────────
router.post('/invoices/:id/status', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const next = String((req.body && req.body.status) || '').trim();
    if (!INVOICE_STATUSES.includes(next)) return res.status(400).json({ error: 'Invalid status' });
    const cur = await pool.query(
      `SELECT status FROM invoices WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`,
      [req.params.id, req.user.organization_id]
    );
    if (!cur.rowCount) return res.status(404).json({ error: 'Not found' });
    const sentAt = next === 'sent' ? ', sent_at = COALESCE(sent_at, NOW())' : '';
    const { rows } = await pool.query(
      `UPDATE invoices SET status = $1${sentAt}, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [next, req.params.id]
    );
    res.json({ invoice: shapeInvoice(rows[0]) });
  } catch (e) { console.error('POST invoice status error:', e); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/invoices/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const cur = await pool.query(
      `SELECT status, amount_paid FROM invoices WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`,
      [req.params.id, req.user.organization_id]
    );
    if (!cur.rowCount) return res.status(404).json({ error: 'Not found' });
    if (cur.rows[0].status === 'paid' || num(cur.rows[0].amount_paid) > 0.005) {
      return res.status(409).json({ error: 'Cannot delete an invoice with payments applied; void it instead' });
    }
    await pool.query(`DELETE FROM invoices WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error('DELETE invoice error:', e); res.status(500).json({ error: 'Server error' }); }
});

// ── payments ────────────────────────────────────────────────────────
router.get('/payments', requireAuth, requireCapability('FINANCIALS_VIEW'), async (req, res) => {
  try {
    const params = [req.user.organization_id];
    let where = '(organization_id = $1 OR organization_id IS NULL)';
    if (req.query.client_id) { params.push(String(req.query.client_id)); where += ` AND client_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT * FROM payments WHERE ${where} ORDER BY payment_date DESC NULLS LAST, created_at DESC`, params);
    res.json({ payments: rows.map(shapePayment) });
  } catch (e) { console.error('GET payments error:', e); res.status(500).json({ error: 'Server error' }); }
});

// Record a payment and apply it across invoices. Body: { client_id?, payment_date,
// amount, method, reference, applications:[{invoice_id, amount}], notes }.
router.post('/payments', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const b = req.body || {}, org = req.user.organization_id;
    const apps = Array.isArray(b.applications) ? b.applications
      .filter(a => a && a.invoice_id).map(a => ({ invoice_id: a.invoice_id, amount: round2(a.amount) })) : [];
    const data = { applications: apps, notes: b.notes || '' };
    const id = genId('pay');
    const { rows } = await pool.query(
      `INSERT INTO payments (id, organization_id, owner_id, client_id, payment_date, amount, method, reference, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [id, org, req.user.id, b.client_id != null ? String(b.client_id) : null,
       b.payment_date || null, round2(b.amount), b.method || null, b.reference || null, JSON.stringify(data)]
    );
    for (const a of apps) await recomputeInvoicePaid(a.invoice_id, org);
    res.json({ payment: shapePayment(rows[0]) });
  } catch (e) { console.error('POST payment error:', e); res.status(500).json({ error: 'Server error' }); }
});

router.put('/payments/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const b = req.body || {}, org = req.user.organization_id;
    const cur = await pool.query(
      `SELECT data FROM payments WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`,
      [req.params.id, org]);
    if (!cur.rowCount) return res.status(404).json({ error: 'Not found' });
    const prevApps = (cur.rows[0].data && Array.isArray(cur.rows[0].data.applications)) ? cur.rows[0].data.applications : [];
    const apps = Array.isArray(b.applications) ? b.applications
      .filter(a => a && a.invoice_id).map(a => ({ invoice_id: a.invoice_id, amount: round2(a.amount) })) : prevApps;
    const data = { applications: apps, notes: b.notes != null ? b.notes : ((cur.rows[0].data || {}).notes || '') };
    const { rows } = await pool.query(
      `UPDATE payments SET client_id = $2, payment_date = $3, amount = $4, method = $5, reference = $6,
          data = $7::jsonb, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, b.client_id != null ? String(b.client_id) : null, b.payment_date || null,
       round2(b.amount), b.method || null, b.reference || null, JSON.stringify(data)]);
    // recompute every invoice touched by the old OR new application set
    const touched = new Set([...prevApps, ...apps].map(a => a.invoice_id).filter(Boolean));
    for (const invId of touched) await recomputeInvoicePaid(invId, org);
    res.json({ payment: shapePayment(rows[0]) });
  } catch (e) { console.error('PUT payment error:', e); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/payments/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const org = req.user.organization_id;
    const cur = await pool.query(
      `SELECT data FROM payments WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`,
      [req.params.id, org]);
    if (!cur.rowCount) return res.status(404).json({ error: 'Not found' });
    const apps = (cur.rows[0].data && Array.isArray(cur.rows[0].data.applications)) ? cur.rows[0].data.applications : [];
    await pool.query(`DELETE FROM payments WHERE id = $1`, [req.params.id]);
    for (const a of apps) if (a && a.invoice_id) await recomputeInvoicePaid(a.invoice_id, org);
    res.json({ ok: true });
  } catch (e) { console.error('DELETE payment error:', e); res.status(500).json({ error: 'Server error' }); }
});

// ── AR aging ────────────────────────────────────────────────────────
// Open invoices (sent/partial) bucketed by age from due_date (or issue_date).
router.get('/ar/aging', requireAuth, requireCapability('FINANCIALS_VIEW'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, j.data->>'jobNumber' AS job_number, j.data->>'title' AS job_title
         FROM invoices i LEFT JOIN jobs j ON j.id = i.job_id
        WHERE (i.organization_id = $1 OR i.organization_id IS NULL)
          AND i.status IN ('sent','partial')`,
      [req.user.organization_id]
    );
    const now = Date.now();
    const buckets = { current: 0, d31: 0, d61: 0, d90: 0 };
    const byClient = {};
    let totalOpen = 0;
    const open = [];
    rows.forEach(r => {
      const inv = shapeInvoice(r);
      const bal = inv.balance;
      if (bal <= 0.005) return;
      const dueStr = r.due_date || r.issue_date;
      const days = dueStr ? Math.floor((now - new Date(dueStr).getTime()) / 86400000) : 0;
      let bucket = 'current';
      if (days > 90) bucket = 'd90'; else if (days > 60) bucket = 'd61'; else if (days > 30) bucket = 'd31';
      buckets[bucket] = round2(buckets[bucket] + bal);
      totalOpen = round2(totalOpen + bal);
      const ck = inv.client_id || inv.billTo && inv.billTo.name || 'Unassigned';
      byClient[ck] = round2((byClient[ck] || 0) + bal);
      open.push({ id: inv.id, invoice_number: inv.invoice_number, job_number: inv.job_number,
        client_id: inv.client_id, balance: bal, days_past_due: days, bucket, due_date: dueStr, status: inv.status });
    });
    open.sort((a, b) => b.days_past_due - a.days_past_due);
    res.json({ total_open: totalOpen, buckets, by_client: byClient, invoices: open });
  } catch (e) { console.error('GET ar/aging error:', e); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
