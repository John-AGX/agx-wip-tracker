// Cost Inbox — receipt CRUD. A receipt is a field-captured cost (photo +
// amount + cost code) attached to a JOB or a LEAD (lead = pre-sale cost).
//
// SECURITY POSTURE — ORG-scoped (NOT per-user): receipts are shared org data
// (the whole team sees the org's cost inbox, filtered by job). Every query
// filters organization_id = <caller org> from the authenticated req.user —
// never the body/params. entered_by records who captured it but does not gate
// reads. (Per-role hardening — e.g. a COSTS_VIEW capability — is a follow-up;
// for v1 any authenticated org user can capture + view, matching how PO/tasks
// started.)
//
// Mounted at /api/receipts (see server/index.js).
'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const COST_CODES = new Set(['materials', 'labor', 'sub', 'gc']);
const STATUSES = new Set(['unprocessed', 'processed', 'void']);
const LINKABLE = new Set(['job', 'lead']);

const COLS =
  'id, ref, entity_type, entity_id, amount, vendor, cost_code, is_presale, ' +
  'notes, attachment_id, status, purchased_at, entered_by, created_at, updated_at';

function newId() {
  return 'rcpt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}
// Short human-facing code shown as "ReceiptID" (matches the AppSpace look).
function newRef() {
  return Math.random().toString(16).slice(2, 10);
}
function callerOrgId(req) {
  const oid = req.user && req.user.organization_id;
  return oid ? Number(oid) : null;
}
function callerUserId(req) {
  return Number(req.user && req.user.id);
}
function cleanStr(v, max) {
  return (typeof v === 'string') ? v.trim().slice(0, max || 300) : null;
}
function cleanAmount(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function validDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : v;
}

// A receipt is "processed" (counts toward the entity's actual costs) once it
// has BOTH a linked entity AND an amount. Photo-only quick-captures stay
// 'unprocessed' in the inbox until completed. void is sticky (explicit).
function deriveStatus(prev, entityType, entityId, amount) {
  if (prev === 'void') return 'void';
  return (entityType && entityId && amount != null) ? 'processed' : 'unprocessed';
}

// GET /api/receipts — org's receipts, newest first. Filters:
//   entity_type, entity_id (one job/lead) · status · cost_code · is_presale=1
//   from / to (purchased_at range) · q (vendor / ref / notes / amount text)
//   limit (default 200, max 500)
router.get('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ receipts: [] });
    const where = ['organization_id = $1'];
    const params = [orgId];
    let p = 2;
    const q = req.query;
    if (q.entity_type && LINKABLE.has(String(q.entity_type))) {
      where.push('entity_type = $' + p++); params.push(String(q.entity_type));
      if (q.entity_id) { where.push('entity_id = $' + p++); params.push(String(q.entity_id)); }
    }
    if (q.status && STATUSES.has(String(q.status))) { where.push('status = $' + p++); params.push(String(q.status)); }
    else if (String(q.status || '') !== 'all') where.push("status <> 'void'"); // default hides voided
    if (q.cost_code && COST_CODES.has(String(q.cost_code))) { where.push('cost_code = $' + p++); params.push(String(q.cost_code)); }
    if (String(q.is_presale || '') === '1') where.push('is_presale = TRUE');
    if (validDate(q.from)) { where.push('purchased_at >= $' + p++); params.push(q.from); }
    if (validDate(q.to))   { where.push('purchased_at <= $' + p++); params.push(q.to); }
    if (q.q) {
      const term = '%' + String(q.q).trim() + '%';
      where.push('(vendor ILIKE $' + p + ' OR ref ILIKE $' + p + ' OR notes ILIKE $' + p +
                 ' OR CAST(amount AS TEXT) ILIKE $' + p + ')');
      params.push(term); p++;
    }
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 200));
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT ${COLS} FROM receipts WHERE ` + where.join(' AND ') +
      ' ORDER BY COALESCE(purchased_at, created_at::date) DESC, created_at DESC LIMIT $' + p,
      params
    );
    res.json({ receipts: rows });
  } catch (e) {
    console.error('GET /api/receipts error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/receipts/:id — one receipt (org-scoped).
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    const { rows } = await pool.query(
      `SELECT ${COLS} FROM receipts WHERE id = $1 AND organization_id = $2`,
      [req.params.id, orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Receipt not found' });
    res.json({ receipt: rows[0] });
  } catch (e) {
    console.error('GET /api/receipts/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/receipts — create. Body: { entity_type?, entity_id?, amount?,
// vendor?, cost_code?, notes?, attachment_id?, purchased_at? }. A lead-linked
// receipt is auto-flagged is_presale. status derives from completeness.
router.post('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'Organization required' });
    const b = req.body || {};
    let entityType = (b.entity_type && LINKABLE.has(String(b.entity_type))) ? String(b.entity_type) : null;
    let entityId = entityType && b.entity_id ? String(b.entity_id) : null;
    if (!entityId) entityType = null; // never store a dangling type
    const amount = cleanAmount(b.amount);
    const costCode = (b.cost_code && COST_CODES.has(String(b.cost_code))) ? String(b.cost_code) : 'materials';
    const isPresale = (entityType === 'lead');
    const purchasedAt = validDate(b.purchased_at) || new Date().toISOString().slice(0, 10);
    const status = deriveStatus(null, entityType, entityId, amount);
    const id = newId();
    const { rows } = await pool.query(
      `INSERT INTO receipts
         (id, organization_id, ref, entity_type, entity_id, amount, vendor,
          cost_code, is_presale, notes, attachment_id, status, purchased_at, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${COLS}`,
      [id, orgId, newRef(), entityType, entityId, amount, cleanStr(b.vendor, 200),
       costCode, isPresale, cleanStr(b.notes, 5000), cleanStr(b.attachment_id, 200),
       status, purchasedAt, callerUserId(req)]
    );
    res.json({ receipt: rows[0] });
  } catch (e) {
    console.error('POST /api/receipts error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// PATCH /api/receipts/:id — update any subset of fields. Re-derives is_presale
// (from the linked entity) + status (from completeness) on every save.
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    const cur = await pool.query(
      'SELECT * FROM receipts WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Receipt not found' });
    const row = cur.rows[0];
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

    let entityType = has('entity_type')
      ? ((b.entity_type && LINKABLE.has(String(b.entity_type))) ? String(b.entity_type) : null)
      : row.entity_type;
    let entityId = has('entity_id') ? (b.entity_id ? String(b.entity_id) : null) : row.entity_id;
    if (!entityId) entityType = null;
    const amount = has('amount') ? cleanAmount(b.amount) : (row.amount == null ? null : Number(row.amount));
    const costCode = has('cost_code')
      ? ((b.cost_code && COST_CODES.has(String(b.cost_code))) ? String(b.cost_code) : row.cost_code)
      : row.cost_code;
    const vendor = has('vendor') ? cleanStr(b.vendor, 200) : row.vendor;
    const notes = has('notes') ? cleanStr(b.notes, 5000) : row.notes;
    const attachmentId = has('attachment_id') ? cleanStr(b.attachment_id, 200) : row.attachment_id;
    const purchasedAt = has('purchased_at') ? (validDate(b.purchased_at) || row.purchased_at) : row.purchased_at;
    // Explicit void/unvoid wins; otherwise completeness derives the status.
    let status = row.status;
    if (has('status') && STATUSES.has(String(b.status))) status = String(b.status);
    status = deriveStatus(status === 'void' ? 'void' : null, entityType, entityId, amount);
    if (has('status') && String(b.status) === 'void') status = 'void';
    const isPresale = (entityType === 'lead');

    const { rows } = await pool.query(
      `UPDATE receipts SET
         entity_type = $3, entity_id = $4, amount = $5, vendor = $6, cost_code = $7,
         is_presale = $8, notes = $9, attachment_id = $10, status = $11,
         purchased_at = $12, updated_at = NOW()
       WHERE id = $1 AND organization_id = $2
       RETURNING ${COLS}`,
      [req.params.id, orgId, entityType, entityId, amount, vendor, costCode,
       isPresale, notes, attachmentId, status, purchasedAt]
    );
    res.json({ receipt: rows[0] });
  } catch (e) {
    console.error('PATCH /api/receipts/:id error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// DELETE /api/receipts/:id — soft-void by default (keeps the photo + audit
// trail); ?hard=1 removes the row entirely.
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (String(req.query.hard || '') === '1') {
      const r = await pool.query('DELETE FROM receipts WHERE id = $1 AND organization_id = $2', [req.params.id, orgId]);
      return res.json({ ok: true, deleted: r.rowCount });
    }
    const r = await pool.query(
      `UPDATE receipts SET status = 'void', updated_at = NOW()
        WHERE id = $1 AND organization_id = $2 RETURNING ${COLS}`,
      [req.params.id, orgId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Receipt not found' });
    res.json({ ok: true, receipt: r.rows[0] });
  } catch (e) {
    console.error('DELETE /api/receipts/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
