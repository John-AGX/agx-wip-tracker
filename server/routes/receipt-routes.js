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
const { Anthropic } = require('@anthropic-ai/sdk');
// Per-user AI-spend limiters (20/min, 200/hr; skip SYSTEM_ADMIN) — the OCR
// route makes a real vision call, so it must be bounded like /api/ai/* (SEC A2).
const { aiChatLimiter, aiChatHourlyLimiter } = require('../rate-limit');

const router = express.Router();

// Lazy Anthropic client for receipt OCR (vision). Mirrors the pattern in
// admin-batch-routes.js — reads ANTHROPIC_API_KEY on first use.
let _anth = null;
function anthropic() {
  if (_anth) return _anth;
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return null;
  _anth = new Anthropic({ apiKey: key });
  return _anth;
}

const COST_CODES = new Set(['materials', 'labor', 'sub', 'gc']);
const STATUSES = new Set(['unprocessed', 'processed', 'void']);
const LINKABLE = new Set(['job', 'lead']);

const COLS =
  'id, ref, entity_type, entity_id, amount, vendor, cost_code, is_presale, ' +
  'notes, attachment_id, status, purchased_at, entered_by, created_at, updated_at';

// Enrich receipt rows with the receipt photo's URLs (one batched query — the
// photo lives in attachments, linked by attachment_id). Adds image_thumb_url
// (grid thumbnail) + image_url (full) so the client renders without an extra
// round-trip per row.
async function attachImageUrls(rows) {
  const ids = rows.map((r) => r.attachment_id).filter(Boolean);
  if (!ids.length) return rows;
  try {
    const ar = await pool.query(
      'SELECT id, thumb_url, web_url, original_url FROM attachments WHERE id = ANY($1::text[])',
      [ids]
    );
    const m = {};
    ar.rows.forEach((a) => { m[a.id] = a; });
    rows.forEach((r) => {
      const a = m[r.attachment_id];
      if (a) {
        r.image_thumb_url = a.thumb_url || a.web_url || a.original_url || null;
        r.image_url = a.web_url || a.original_url || a.thumb_url || null;
      }
    });
  } catch (_) { /* image URLs are best-effort */ }
  return rows;
}

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
  // "complete" = linked entity AND a real (> 0) amount. A $0 receipt is treated
  // as an incomplete capture and stays in the Unprocessed bucket.
  return (entityType && entityId && amount != null && Number(amount) > 0) ? 'processed' : 'unprocessed';
}

// Verify a job/lead link target actually belongs to the caller's org. Returns
// true for a valid in-org link; on false the caller drops the dangling link so
// a cost can't be (mis)attributed to a foreign/nonexistent entity id.
async function entityInOrg(entityType, entityId, orgId) {
  if (!entityType || !entityId) return false;
  const table = entityType === 'job' ? 'jobs' : (entityType === 'lead' ? 'leads' : null);
  if (!table) return false;
  try {
    const r = await pool.query('SELECT 1 FROM ' + table + ' WHERE id = $1 AND organization_id = $2', [String(entityId), orgId]);
    return r.rows.length > 0;
  } catch (_) { return false; }
}

// Log how the OCR suggestion compared to what the user actually saved, per
// field — so the model's hit-rate is measurable + tunable. Best-effort, fire-
// and-forget. `ocr` is the suggestion the client held from POST /ocr; `finals`
// are the values being persisted. A field with no suggestion logs *_ok = null.
async function logOcrFeedback(orgId, receiptId, ocr, finals, isPresale) {
  try {
    if (!ocr || typeof ocr !== 'object' || !orgId) return;
    const norm = (s) => (s == null ? null : String(s).trim().toLowerCase());
    const ov = ocr.vendor != null ? String(ocr.vendor).slice(0, 200) : null;
    const od = /^\d{4}-\d{2}-\d{2}$/.test(String(ocr.date || '')) ? String(ocr.date) : null;
    const occ = COST_CODES.has(String(ocr.cost_code)) ? String(ocr.cost_code) : null;
    let oa = null;
    if (ocr.amount != null) { const n = Number(ocr.amount); if (Number.isFinite(n)) oa = Math.round(n * 100) / 100; }
    const fAmount = (finals.amount == null) ? null : Math.round(Number(finals.amount) * 100) / 100;
    const vendorOk = ov != null ? (norm(ov) === norm(finals.vendor)) : null;
    const dateOk = od != null ? (od === (finals.date || null)) : null;
    // For a lead (pre-sale) receipt the cost code is hidden/irrelevant, so don't
    // score it — it would otherwise log a spurious miss and skew the stat.
    const codeOk = (occ != null && !isPresale) ? (occ === (finals.cost_code || null)) : null;
    const amountOk = oa != null ? (fAmount != null && fAmount === oa) : null;
    if (vendorOk === null && dateOk === null && codeOk === null && amountOk === null) return;
    await pool.query(
      `INSERT INTO receipt_ocr_feedback
         (id, organization_id, receipt_id, ocr_vendor, final_vendor, vendor_ok,
          ocr_date, final_date, date_ok, ocr_cost_code, final_cost_code, cost_code_ok,
          ocr_amount, final_amount, amount_ok)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      ['fb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), orgId, receiptId,
       ov, finals.vendor || null, vendorOk, od, finals.date || null, dateOk,
       occ, finals.cost_code || null, codeOk, oa, fAmount, amountOk]
    );
  } catch (_) { /* feedback is best-effort — never affects the save */ }
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
      // Escape LIKE metacharacters so a literal % or _ in the term matches
      // literally (parameterized already — this is about match semantics).
      const term = '%' + String(q.q).trim().replace(/[\\%_]/g, '\\$&') + '%';
      where.push("(vendor ILIKE $" + p + " ESCAPE '\\' OR ref ILIKE $" + p + " ESCAPE '\\' OR notes ILIKE $" + p +
                 " ESCAPE '\\' OR CAST(amount AS TEXT) ILIKE $" + p + " ESCAPE '\\')");
      params.push(term); p++;
    }
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 200));
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT ${COLS} FROM receipts WHERE ` + where.join(' AND ') +
      ' ORDER BY COALESCE(purchased_at, created_at::date) DESC, created_at DESC LIMIT $' + p,
      params
    );
    await attachImageUrls(rows);
    res.json({ receipts: rows });
  } catch (e) {
    console.error('GET /api/receipts error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/receipts/rollup?entity_type=job&entity_id=X — captured-cost totals
// for one job/lead, grouped by cost code, split COGS (non-presale) vs pre-sale.
// Counts only 'processed' receipts (complete + counting). MUST be declared
// before '/:id' or Express routes "rollup" into that param handler.
router.get('/rollup', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    const et = String(req.query.entity_type || '');
    const eid = req.query.entity_id ? String(req.query.entity_id) : null;
    const empty = { by_code: {}, cogs_total: 0, presale_total: 0, grand_total: 0, count: 0 };
    if (!orgId || !LINKABLE.has(et) || !eid) return res.json({ rollup: empty });
    const { rows } = await pool.query(
      `SELECT cost_code, is_presale, COALESCE(SUM(amount), 0)::numeric(14, 2) AS total, COUNT(*)::int AS count
         FROM receipts
        WHERE organization_id = $1 AND entity_type = $2 AND entity_id = $3 AND status = 'processed'
        GROUP BY cost_code, is_presale`,
      [orgId, et, eid]
    );
    const out = { by_code: {}, cogs_total: 0, presale_total: 0, grand_total: 0, count: 0 };
    rows.forEach((r) => {
      const amt = Number(r.total) || 0;
      out.grand_total += amt;
      out.count += r.count;
      if (r.is_presale) {
        out.presale_total += amt;
      } else {
        const code = r.cost_code || 'materials';
        out.by_code[code] = out.by_code[code] || { total: 0, count: 0 };
        out.by_code[code].total += amt;
        out.by_code[code].count += r.count;
        out.cogs_total += amt;
      }
    });
    res.json({ rollup: out });
  } catch (e) {
    console.error('GET /api/receipts/rollup error:', e);
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

// POST /api/receipts/ocr — read a receipt photo: vendor + date + cost-code
// guess + the grand total (the amount IS read now, but the client flags it
// "AI-read · verify" and the accuracy of every field is tracked on save so the
// model's hit-rate is measurable — see POST / feedback logging) + the receipt's
// 4 corner points (0..1 fractions) so the client can crop + flatten it.
// Learns from the org: known vendor names are passed in to normalize matches.
// Body: { image_base64 (raw or data-URL), media_type }. Best-effort: returns
// { ok:false } on any failure so the capture flow never breaks.
const OCR_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
async function knownVendors(orgId) {
  try {
    const r = await pool.query(
      "SELECT vendor, COUNT(*) AS c FROM receipts WHERE organization_id = $1 AND vendor IS NOT NULL AND TRIM(vendor) <> '' GROUP BY vendor ORDER BY c DESC LIMIT 40",
      [orgId]
    );
    // Sanitize for prompt-content: strip newlines/control chars + clamp length
    // so a stored vendor string can't reshape this org's own OCR prompt.
    return r.rows.map((x) => x.vendor).filter(Boolean)
      .map((v) => String(v).replace(/[\r\n\t]+/g, ' ').slice(0, 60));
  } catch (_) { return []; }
}
router.post('/ocr', requireAuth, aiChatLimiter, aiChatHourlyLimiter, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ ok: false }); // fail closed like the sibling routes
    const b = req.body || {};
    let data = String(b.image_base64 || '');
    if (data.startsWith('data:')) { const i = data.indexOf(','); if (i >= 0) data = data.slice(i + 1); }
    const media = OCR_MEDIA.has(String(b.media_type)) ? String(b.media_type) : 'image/jpeg';
    if (!data || data.length > 9000000) return res.json({ ok: false });
    const client = anthropic();
    if (!client) return res.json({ ok: false, error: 'ocr-unavailable' });
    const vendors = await knownVendors(orgId);
    const vendorHint = vendors.length
      ? '\nThis company already buys from these vendors — if the receipt is from one of them, return that exact spelling: ' + vendors.join(', ') + '.'
      : '';
    const prompt =
      'You are reading a photographed receipt or invoice. Return ONLY a JSON object, no prose:\n' +
      '{"vendor": string|null, "date": "YYYY-MM-DD"|null, "cost_code": "materials"|"labor"|"sub"|"gc"|null, "amount": number|null, "corners": [[x,y],[x,y],[x,y],[x,y]]|null}\n' +
      '- vendor: the store / supplier / company name (usually at the top).' + vendorHint + '\n' +
      '- date: the purchase/transaction date as YYYY-MM-DD; null if not visible.\n' +
      '- cost_code: best category guess — materials (supply/hardware/lumber/paint stores), sub (a subcontractor invoice), labor (payroll/labor), gc (permits, equipment rental, fuel, dump fees); null if unsure.\n' +
      '- amount: the GRAND TOTAL / total due as a plain number (no $ or commas); null if not clearly visible.\n' +
      '- corners: the 4 outer corners of the RECEIPT/paper within the photo, as [x,y] FRACTIONS of image width and height (0=left/top, 1=right/bottom), ordered top-left, top-right, bottom-right, bottom-left. Use this to crop out the background. If the receipt fills the whole frame or you cannot tell, return null.\n' +
      'Use null for anything you cannot read.';
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: media, data: data } },
          { type: 'text', text: prompt }
        ]
      }]
    });
    let text = '';
    try { text = (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''); } catch (_) {}
    let parsed = null;
    try { const m = text.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch (_) {}
    if (!parsed) return res.json({ ok: false });
    const vendor = parsed.vendor ? String(parsed.vendor).trim().slice(0, 200) : null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date || '')) ? String(parsed.date) : null;
    const cost_code = COST_CODES.has(String(parsed.cost_code)) ? String(parsed.cost_code) : null;
    // amount: accept number or "$1,234.56" string; reject non-finite / negative.
    let amount = null;
    if (parsed.amount != null) {
      const n = (typeof parsed.amount === 'number') ? parsed.amount : Number(String(parsed.amount).replace(/[^0-9.\-]/g, ''));
      if (Number.isFinite(n) && n >= 0 && n < 100000000) amount = Math.round(n * 100) / 100;
    }
    // corners: exactly 4 [x,y] in 0..1, else null (client validates the quad too).
    let corners = null;
    if (Array.isArray(parsed.corners) && parsed.corners.length === 4) {
      const c = parsed.corners.map((p) => Array.isArray(p) ? [Number(p[0]), Number(p[1])] : null);
      if (c.every((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= -0.05 && p[0] <= 1.05 && p[1] >= -0.05 && p[1] <= 1.05)) {
        corners = c.map((p) => [Math.min(1, Math.max(0, p[0])), Math.min(1, Math.max(0, p[1]))]);
      }
    }
    res.json({ ok: true, vendor: vendor, date: date, cost_code: cost_code, amount: amount, corners: corners });
  } catch (e) {
    console.error('POST /api/receipts/ocr error:', e && e.message);
    res.json({ ok: false });
  }
});

// GET /api/receipts/ocr/stats — the model's per-field OCR hit-rate for this org
// (from receipt_ocr_feedback). Powers the "OCR accuracy" line in the Cost Inbox.
router.get('/ocr/stats', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ stats: null });
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)::int AS samples,
         COUNT(vendor_ok)::int AS vendor_n,    COUNT(*) FILTER (WHERE vendor_ok)::int    AS vendor_ok,
         COUNT(date_ok)::int AS date_n,        COUNT(*) FILTER (WHERE date_ok)::int      AS date_ok,
         COUNT(cost_code_ok)::int AS code_n,   COUNT(*) FILTER (WHERE cost_code_ok)::int AS code_ok,
         COUNT(amount_ok)::int AS amount_n,    COUNT(*) FILTER (WHERE amount_ok)::int    AS amount_ok
       FROM receipt_ocr_feedback WHERE organization_id = $1`,
      [orgId]
    );
    const r = rows[0] || {};
    const rate = (ok, n) => (n > 0 ? Math.round((100 * ok) / n) : null);
    res.json({ stats: {
      samples: r.samples || 0,
      vendor: { n: r.vendor_n || 0, rate: rate(r.vendor_ok, r.vendor_n) },
      date: { n: r.date_n || 0, rate: rate(r.date_ok, r.date_n) },
      cost_code: { n: r.code_n || 0, rate: rate(r.code_ok, r.code_n) },
      amount: { n: r.amount_n || 0, rate: rate(r.amount_ok, r.amount_n) }
    } });
  } catch (e) {
    console.error('GET /api/receipts/ocr/stats error:', e);
    res.json({ stats: null });
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
    // Drop a link that doesn't point at one of THIS org's jobs/leads, so a cost
    // can't be attributed to a foreign or nonexistent entity id.
    if (entityId && !(await entityInOrg(entityType, entityId, orgId))) { entityType = null; entityId = null; }
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
    // Record OCR-suggestion-vs-saved accuracy (fire-and-forget; after response).
    if (b.ocr) {
      logOcrFeedback(orgId, id, b.ocr, {
        vendor: cleanStr(b.vendor, 200), date: purchasedAt, cost_code: costCode, amount: amount
      }, isPresale);
    }
  } catch (e) {
    console.error('POST /api/receipts error:', e);
    res.status(500).json({ error: 'Server error' });
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
    // Only when the link is actually being changed: drop it if it doesn't point
    // at one of this org's jobs/leads (keeps unrelated PATCHes — e.g. attaching
    // a photo — from re-validating an existing stored link).
    if ((has('entity_type') || has('entity_id')) && entityId && !(await entityInOrg(entityType, entityId, orgId))) { entityType = null; entityId = null; }
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
    res.status(500).json({ error: 'Server error' });
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
