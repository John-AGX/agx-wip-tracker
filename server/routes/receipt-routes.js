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
const { requireAuth, requireCapability } = require('../auth');
const { Anthropic } = require('@anthropic-ai/sdk');
// Per-user AI-spend limiters (20/min, 200/hr; skip SYSTEM_ADMIN) — the OCR
// route makes a real vision call, so it must be bounded like /api/ai/* (SEC A2).
const { aiChatLimiter, aiChatHourlyLimiter } = require('../rate-limit');
// Training-example flywheel — OCR-vs-saved pairs feed future fine-tunes.
const { captureExample, TASKS } = require('../services/training-capture');
// THE ONE normalizer for merchant strings and store identity. Do not add a
// second one — see the header of that file for why a wrong merge has no
// symptom while a wrong split has an obvious one.
const VN = require('../services/vendor-name');
// The accrual / match-only-sub exclusion, in its ONE definition. A vendor
// rollup that quietly counts month-end journal entries overstates spend, and
// there were four drifting copies of this rule before that file existed.
const { classifyCostLine } = require('../services/money/cost-line-filters');

const router = express.Router();

// Single source of truth for the OCR model — also stamped onto training examples.
const OCR_MODEL = 'claude-haiku-4-5';

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
// What a receipt can link to: a job, a lead (pre-sale), or an org cost category
// (a non-job coding bucket like Tools/Overhead). 'category' is the coding itself,
// so the cost_code segment is irrelevant for it (client hides it).
const LINKABLE = new Set(['job', 'lead', 'category']);

const COLS =
  'id, ref, entity_type, entity_id, amount, vendor, cost_code, is_presale, ' +
  'notes, attachment_id, status, purchased_at, entered_by, created_at, updated_at, ' +
  'tags, sub_id, payment_method, reimbursable, reimburse_to, is_billable, invoice_no, ' +
  // Store identity as printed on the paper. EVERY ONE OF THESE IS MODEL OUTPUT
  // AND NONE IS CONFIRMED — there is no store record for a confirmation to live
  // on yet. NULL means "not read", and the client is required to say so in
  // words rather than render an empty cell.
  'store_number, store_name, store_address, store_phone';

// The four store fields, validated through the shared module. Used by POST and
// by PATCH so the two paths cannot drift, which is how `vendor` and `amount`
// should have been written and were not.
function cleanStoreFields(b, vendorForCompare) {
  return {
    store_number: VN.normalizeStoreNumber(b.store_number),
    store_name: VN.cleanStoreName(b.store_name),
    store_address: VN.cleanStoreAddress(b.store_address, b.store_name || vendorForCompare),
    store_phone: VN.normalizePhone(b.store_phone),
  };
}

const PAY_METHODS = new Set(['cash', 'company_card', 'personal_card', 'check', 'ach', 'other']);
// Normalize a tags input (array or comma string) → lowercased, trimmed, deduped,
// ≤32 chars each, max 20. Mirrors the attachments tag rules.
function normalizeTags(v) {
  var arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
  var out = [];
  var seen = {};
  arr.forEach(function (t) {
    var s = String(t == null ? '' : t).trim().toLowerCase().slice(0, 32);
    if (!s || seen[s]) return; seen[s] = true; out.push(s);
  });
  return out.slice(0, 20);
}

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

// Enrich rows with the uploader's display name (entered_by -> users.name). One
// batched query; best-effort (the name is display-only — never gates anything).
// Adds entered_by_name so the Cost Inbox can show an "Uploaded by" column/field.
async function attachUploaderNames(rows) {
  const ids = [...new Set(rows.map((r) => r.entered_by).filter((v) => v != null))];
  if (!ids.length) return rows;
  try {
    const ur = await pool.query('SELECT id, name, email FROM users WHERE id = ANY($1::int[])', [ids]);
    const m = {};
    ur.rows.forEach((u) => { m[u.id] = u; });
    rows.forEach((r) => {
      const u = m[r.entered_by];
      if (u) r.entered_by_name = u.name || u.email || null;
    });
  } catch (_) { /* uploader name is best-effort */ }
  return rows;
}

// Resolve linked sub names (sub_id -> sub_name) for display/filter. Batched, best-effort.
async function attachSubNames(rows) {
  const ids = [...new Set(rows.map((r) => r.sub_id).filter(Boolean))];
  if (!ids.length) return rows;
  try {
    const sr = await pool.query('SELECT id, name FROM subs WHERE id = ANY($1::text[])', [ids]);
    const m = {};
    sr.rows.forEach((s) => { m[s.id] = s.name; });
    rows.forEach((r) => { if (r.sub_id && m[r.sub_id]) r.sub_name = m[r.sub_id]; });
  } catch (_) { /* sub name is best-effort */ }
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
  const table = entityType === 'job' ? 'jobs'
    : (entityType === 'lead' ? 'leads'
    : (entityType === 'category' ? 'cost_categories' : null));
  if (!table) return false;
  // Categories use a TEXT id like receipts/jobs; cost_categories is keyed by text id too.
  try {
    const r = await pool.query('SELECT 1 FROM ' + table + ' WHERE id = $1 AND organization_id = $2', [String(entityId), orgId]);
    return r.rows.length > 0;
  } catch (_) { return false; }
}

// Verify a sub link belongs to the caller's org (subs may be org-scoped or global).
async function subInOrg(subId, orgId) {
  if (!subId) return false;
  try {
    const r = await pool.query('SELECT 1 FROM subs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)', [String(subId), orgId]);
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
    const fbId = 'fb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await pool.query(
      `INSERT INTO receipt_ocr_feedback
         (id, organization_id, receipt_id, ocr_vendor, final_vendor, vendor_ok,
          ocr_date, final_date, date_ok, ocr_cost_code, final_cost_code, cost_code_ok,
          ocr_amount, final_amount, amount_ok)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [fbId, orgId, receiptId,
       ov, finals.vendor || null, vendorOk, od, finals.date || null, dateOk,
       occ, finals.cost_code || null, codeOk, oa, fAmount, amountOk]
    );
    // Mirror into the training-example flywheel. Ids reuse the feedback row's
    // id in the SAME scheme the db.js backfill uses ('tex_<fbId>_fields' /
    // '_code'), so boot backfills and live captures can never double-insert.
    const imageRef = finals.attachment_id || null;
    captureExample({
      id: 'tex_' + fbId + '_fields', orgId, task: TASKS.RECEIPT_FIELDS,
      sourceKind: 'receipt_ocr_feedback', sourceId: fbId,
      input: { receipt_id: receiptId, image_ref: imageRef },
      modelOutput: { vendor: ov, date: od, cost_code: occ, amount: oa },
      humanFinal: { vendor: finals.vendor || null, date: finals.date || null, cost_code: finals.cost_code || null, amount: fAmount },
      accepted: (vendorOk !== false && dateOk !== false && codeOk !== false && amountOk !== false),
      model: OCR_MODEL
    });
    if (occ != null && codeOk !== null) {
      captureExample({
        id: 'tex_' + fbId + '_code', orgId, task: TASKS.COST_CODE,
        sourceKind: 'receipt_ocr_feedback', sourceId: fbId,
        input: { receipt_id: receiptId, vendor: finals.vendor || null, date: finals.date || null, amount: fAmount, image_ref: imageRef },
        modelOutput: { cost_code: occ },
        humanFinal: { cost_code: finals.cost_code || null },
        accepted: codeOk,
        model: OCR_MODEL
      });
    }
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
    await attachUploaderNames(rows);
    await attachSubNames(rows);
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

// ══════════════════════════════════════════════════════════════════════════
// GET /api/receipts/merchants — WHAT THE RECEIPTS AND THE LEDGER ALREADY KNOW
//
// READ-ONLY. It writes nothing, creates nothing, and suggests nothing. There
// is no vendor record in this schema and this route does not make one: it
// answers "who do we buy from, how often, for how much, at which branches, and
// what address and phone have we actually captured" out of rows that already
// exist. John looks at his real list BEFORE anything is written down.
//
// ── TWO ARMS, TWO DIFFERENT TENANCY MODELS, AND THAT IS THE HAZARD ────────
// `receipts` is classified DIRECT (org-table-classification.js:64): its own
// organization_id IS the tenant, and the predicate is strict.
//
// `qb_cost_lines` is classified PARENT via jobs (:87). Its own
// organization_id column is a DENORMALISED CACHE, not the anchor, so scoping
// the QB arm on `q.organization_id` because the column is right there is a
// cross-tenant read that a single-tenant production can never surface. The
// predicate below is the one GET /api/qb-costs already uses
// (qb-cost-routes.js:466-482), copied deliberately rather than re-derived:
//
//     LEFT JOIN jobs j ON j.id = q.job_id, filtered on the JOB's org with the
//     un-stamped tolerance arm — see the statement itself, below.
//
// (Written in prose rather than quoted verbatim on purpose: the graduation
// checklist counts occurrences of that tolerance predicate across server/ by
// plain text match, so a comment repeating it inflates a number somebody is
// using to decide when org #2 can be created. docs/TENANCY-GRADUATION.md
// item 9.)
//
// The tolerance arm is inherited with the predicate and is worth saying out
// loud: a QB line whose job is not org-stamped is visible to every tenant.
// That is a no-op for AGX (one org) and it is NOT a no-op the day there are
// two. Tightening it is the same one-line change in both routes, together.
//
// ── FINANCIALS_VIEW, NOT THE ROUTER'S HABIT ──────────────────────────────
// Everything else in this file rides on requireAuth alone, because a receipt
// is a field capture. This route folds in QuickBooks spend, which
// qb-cost-routes.js:454 gates on FINANCIALS_VIEW — a capability that
// deliberately excludes roles allowed to photograph receipts. Inheriting the
// file's habit would have exposed the ledger to them.
//
// ── THREE MONEY FIGURES, NEVER SUMMED ────────────────────────────────────
// A Home Depot receipt photographed in September appears on the QuickBooks
// export in October. Same dollar, two rows. This route returns receipt money
// and QB money as SEPARATE fields and computes no total, structurally, so a
// client cannot render one by reading a field that does not exist.
// Accrual journal entries are excluded by the shared classifier — and their
// count is reported, because an exclusion nobody can see is indistinguishable
// from a bug.
// ══════════════════════════════════════════════════════════════════════════

// Bounds. AGX had 697 QB cost lines on 2026-08-12 (js/cost-buckets.js:64), so
// these are far above the real data — they exist so an unbounded scan cannot
// appear later, and a hit is REPORTED rather than silently truncating the list.
const MERCHANT_RECEIPT_CAP = 20000;
const MERCHANT_QB_CAP = 50000;

// What one OCR pass costs today, for the backfill estimate below. Priced from
// the real config, not a guess: OCR_MODEL is claude-haiku-4-5 at $1.00/MTok in
// and $5.00/MTok out. A receipt photo is downscaled to 1400px on its long edge
// (js/cost-inbox.js:994) -> ~1050x1400 -> ~1,960 image tokens (w*h/750), plus
// ~580 tokens of prompt and up to ~600 of known-vendor hint; output is the JSON
// object at ~200 tokens with the four store fields.
//   in  ~3,100 tok * $1/MTok  = $0.0031
//   out ~  200 tok * $5/MTok  = $0.0010
const OCR_COST_PER_RECEIPT_USD = 0.0041;

function money(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// One merchant bucket, keyed by the normalizer. Nothing here decides that two
// keys are the same merchant — see services/vendor-name.js.
function bucketFor(map, raw) {
  const n = VN.normalizeVendorName(raw);
  if (!n.key) return null;
  let b = map.get(n.key);
  if (!b) {
    b = {
      key: n.key,
      variants: new Map(),           // raw spelling -> counts
      receipts: { count: 0, amount: 0 },
      qb_cost: { lines: 0, amount: 0 },
      qb_sub: { lines: 0, amount: 0 },
      qb_accrual_excluded: { lines: 0 },
      first_seen: null,
      last_seen: null,
      branches: new Map(),           // branch code (or '') -> readings
    };
    map.set(n.key, b);
  }
  let v = b.variants.get(n.raw);
  if (!v) { v = { raw: n.raw, receipts: 0, receipt_amount: 0, qb_lines: 0, qb_amount: 0 }; b.variants.set(n.raw, v); }
  return { bucket: b, variant: v, branch: n.branch };
}

function seen(b, date) {
  const d = date ? String(date).slice(0, 10) : null;
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
  if (!b.first_seen || d < b.first_seen) b.first_seen = d;
  if (!b.last_seen || d > b.last_seen) b.last_seen = d;
}

function branchFor(b, code) {
  const key = code || '';
  let br = b.branches.get(key);
  if (!br) {
    br = { branch: code || null, receipts: 0, names: [], addresses: [], phones: [] };
    b.branches.set(key, br);
  }
  return br;
}

router.get('/merchants', requireAuth, requireCapability('FINANCIALS_VIEW'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ merchants: [], sources: null, backfill: null });

    // ARM 1 — receipts. DIRECT tenancy: the row's own organization_id.
    const rc = await pool.query(
      `SELECT vendor, amount, purchased_at, created_at, store_number, store_name,
              store_address, store_phone, attachment_id
         FROM receipts
        WHERE organization_id = $1 AND status <> 'void'
        ORDER BY created_at DESC
        LIMIT ${MERCHANT_RECEIPT_CAP}`,
      [orgId]
    );

    // ARM 2 — QuickBooks cost lines. PARENT tenancy, through the job.
    const qb = await pool.query(
      `SELECT q.vendor, q.amount, q.txn_date, q.txn_type, q.account, q.account_type, q.bucket
         FROM qb_cost_lines q
         LEFT JOIN jobs j ON j.id = q.job_id
        WHERE (j.organization_id = $1 OR j.organization_id IS NULL)
        ORDER BY q.txn_date DESC
        LIMIT ${MERCHANT_QB_CAP}`,
      [orgId]
    );

    const map = new Map();
    let receiptsNoVendor = 0;
    let qbNoVendor = 0;

    rc.rows.forEach((r) => {
      const hit = bucketFor(map, r.vendor);
      if (!hit) { receiptsNoVendor++; return; }
      const { bucket, variant, branch } = hit;
      const amt = money(r.amount);
      bucket.receipts.count++;
      bucket.receipts.amount = money(bucket.receipts.amount + amt);
      variant.receipts++;
      variant.receipt_amount = money(variant.receipt_amount + amt);
      seen(bucket, r.purchased_at || r.created_at);
      // The branch the row belongs to: the captured store_number wins, and the
      // number lifted off the merchant string is the fallback.
      const code = VN.normalizeStoreNumber(r.store_number) || branch || null;
      const br = branchFor(bucket, code);
      br.receipts++;
      if (r.store_name) br.names.push(r.store_name);
      if (r.store_address) br.addresses.push(r.store_address);
      if (r.store_phone) br.phones.push(r.store_phone);
    });

    qb.rows.forEach((l) => {
      const hit = bucketFor(map, l.vendor);
      if (!hit) { qbNoVendor++; return; }
      const { bucket, variant } = hit;
      const amt = money(l.amount);
      const cls = classifyCostLine(l);
      if (cls === 'accrual') { bucket.qb_accrual_excluded.lines++; return; }
      const arm = cls === 'sub' ? bucket.qb_sub : bucket.qb_cost;
      arm.lines++;
      arm.amount = money(arm.amount + amt);
      variant.qb_lines++;
      variant.qb_amount = money(variant.qb_amount + amt);
      seen(bucket, l.txn_date);
    });

    const merchants = [...map.values()].map((b) => {
      const variants = [...b.variants.values()]
        .sort((a, z) => (z.qb_amount + z.receipt_amount) - (a.qb_amount + a.receipt_amount)
          || String(a.raw).localeCompare(String(z.raw)));
      const stores = [...b.branches.values()].map((br) => {
        const phone = VN.agreement(br.phones);
        return {
          branch: br.branch,
          receipts: br.receipts,
          name_as_printed: VN.agreement(br.names),
          address: VN.agreement(br.addresses),
          // DIALABLE IS COMPUTED HERE, not left to the client. A number is a
          // tel: link only when at least two independent receipts read the
          // same digits. One reading is a reading, not a confirmation — and
          // nobody has vouched for any of these, because there is nowhere yet
          // for a person's confirmation to be recorded.
          phone: Object.assign(VN.agreement(br.phones), { dialable: phone.verdict === 'agreed' }),
        };
      }).sort((a, z) => z.receipts - a.receipts
        || String(a.branch || '').localeCompare(String(z.branch || '')));
      return {
        key: b.key,
        // Display comes from a spelling a HUMAN wrote, never from the
        // normalized key — "home depot" is a grouping token, not a name.
        display: variants[0] ? variants[0].raw : b.key,
        variants,
        receipts: b.receipts,
        qb_cost: b.qb_cost,
        qb_sub: b.qb_sub,
        qb_accrual_excluded: b.qb_accrual_excluded,
        first_seen: b.first_seen,
        last_seen: b.last_seen,
        stores,
      };
    }).sort((a, z) => (z.qb_cost.amount + z.qb_sub.amount + z.receipts.amount)
      - (a.qb_cost.amount + a.qb_sub.amount + a.receipts.amount)
      || String(a.display).localeCompare(String(z.display)));

    // What a re-OCR of the photos already on file WOULD cost. Reported, never
    // run: a backfill writes model guesses across the whole history at once
    // with nobody having looked at any of them, and the agreement signal above
    // would then report high confidence for a store whose address four
    // unreviewed reads happened to agree on. The switch is off, and this is
    // what is behind it.
    const bf = await pool.query(
      `SELECT COUNT(*)::int AS n FROM receipts
        WHERE organization_id = $1 AND status <> 'void'
          AND attachment_id IS NOT NULL
          AND store_number IS NULL AND store_name IS NULL
          AND store_address IS NULL AND store_phone IS NULL`,
      [orgId]
    );
    const candidates = Number(bf.rows[0] && bf.rows[0].n) || 0;

    res.json({
      merchants,
      sources: {
        receipts: {
          rows: rc.rows.length,
          truncated: rc.rows.length >= MERCHANT_RECEIPT_CAP,
          without_vendor: receiptsNoVendor,
        },
        qb_cost_lines: {
          rows: qb.rows.length,
          truncated: qb.rows.length >= MERCHANT_QB_CAP,
          without_vendor: qbNoVendor,
        },
      },
      backfill: {
        candidates,
        model: OCR_MODEL,
        usd_per_receipt: OCR_COST_PER_RECEIPT_USD,
        estimated_usd: Math.round(candidates * OCR_COST_PER_RECEIPT_USD * 10000) / 10000,
        enabled: false,
      },
    });
  } catch (e) {
    console.error('GET /api/receipts/merchants error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Cost categories (org-defined non-job coding buckets) ───────────────────
// These literal paths MUST sit before '/:id' or Express routes "categories"
// into the param handler.
const CAT_COLS = 'id, name, position, archived, created_at';

// GET /api/receipts/categories — the org's active cost categories (Tools, etc.).
// Lazily seeds a default "Tools" category the first time an org has none, so the
// feature works out of the box. ?all=1 includes archived (for the Admin pane).
router.get('/categories', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ categories: [] });
    let { rows } = await pool.query(
      `SELECT ${CAT_COLS} FROM cost_categories WHERE organization_id = $1 ORDER BY position, lower(name)`,
      [orgId]
    );
    if (!rows.length) {
      // Seed the default bucket once. ON CONFLICT no-ops if a race created it.
      await pool.query(
        `INSERT INTO cost_categories (id, organization_id, name, position, created_by)
         VALUES ($1, $2, 'Tools', 0, $3)
         ON CONFLICT (organization_id, lower(name)) DO NOTHING`,
        ['cat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), orgId, callerUserId(req)]
      );
      rows = (await pool.query(
        `SELECT ${CAT_COLS} FROM cost_categories WHERE organization_id = $1 ORDER BY position, lower(name)`,
        [orgId]
      )).rows;
    }
    if (String(req.query.all || '') !== '1') rows = rows.filter((r) => !r.archived);
    res.json({ categories: rows });
  } catch (e) {
    console.error('GET /api/receipts/categories error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/receipts/categories — add a category. Org config → admin-gated.
router.post('/categories', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'Organization required' });
    const name = cleanStr((req.body || {}).name, 60);
    if (!name) return res.status(400).json({ error: 'Name required' });
    const id = 'cat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    try {
      const { rows } = await pool.query(
        `INSERT INTO cost_categories (id, organization_id, name, position, created_by)
         VALUES ($1, $2, $3, COALESCE((SELECT MAX(position) + 1 FROM cost_categories WHERE organization_id = $2), 0), $4)
         RETURNING ${CAT_COLS}`,
        [id, orgId, name, callerUserId(req)]
      );
      res.json({ category: rows[0] });
    } catch (dup) {
      if (dup && dup.code === '23505') return res.status(409).json({ error: 'A category with that name already exists.' });
      throw dup;
    }
  } catch (e) {
    console.error('POST /api/receipts/categories error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/receipts/categories/:id — rename / archive / restore. Admin-gated.
router.patch('/categories/:id', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'Organization required' });
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    const cur = await pool.query('SELECT * FROM cost_categories WHERE id = $1 AND organization_id = $2', [req.params.id, orgId]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Category not found' });
    const name = has('name') ? (cleanStr(b.name, 60) || cur.rows[0].name) : cur.rows[0].name;
    const archived = has('archived') ? !!b.archived : cur.rows[0].archived;
    try {
      const { rows } = await pool.query(
        `UPDATE cost_categories SET name = $3, archived = $4, updated_at = NOW()
          WHERE id = $1 AND organization_id = $2 RETURNING ${CAT_COLS}`,
        [req.params.id, orgId, name, archived]
      );
      res.json({ category: rows[0] });
    } catch (dup) {
      if (dup && dup.code === '23505') return res.status(409).json({ error: 'A category with that name already exists.' });
      throw dup;
    }
  } catch (e) {
    console.error('PATCH /api/receipts/categories/:id error:', e);
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
      '{"vendor": string|null, "date": "YYYY-MM-DD"|null, "cost_code": "materials"|"labor"|"sub"|"gc"|null, "amount": number|null, "corners": [[x,y],[x,y],[x,y],[x,y]]|null, "store_name": string|null, "store_number": string|null, "store_address": string|null, "store_phone": string|null}\n' +
      '- vendor: the store / supplier / company name (usually at the top).' + vendorHint + '\n' +
      '- date: the purchase/transaction date as YYYY-MM-DD; null if not visible.\n' +
      '- cost_code: best category guess — materials (supply/hardware/lumber/paint stores), sub (a subcontractor invoice), labor (payroll/labor), gc (permits, equipment rental, fuel, dump fees); null if unsure.\n' +
      '- amount: the GRAND TOTAL / total due as a plain number (no $ or commas); null if not clearly visible.\n' +
      '- corners: the 4 outer corners of the RECEIPT/paper within the photo, as [x,y] FRACTIONS of image width and height (0=left/top, 1=right/bottom), ordered top-left, top-right, bottom-right, bottom-left. Use this to crop out the background. If the receipt fills the whole frame or you cannot tell, return null.\n' +
      // ── STORE IDENTITY ────────────────────────────────────────────────────
      // Four fields, each written so that the answer to "I am not sure" is
      // null rather than a plausible guess. Two of these are traps and the
      // wording is aimed straight at them:
      //   (1) the store number is often a BARE 3-5 digit field inside a run of
      //       numbers next to the register and transaction ids, so a rule
      //       keyed on the "#" glyph misses the common case and a rule that
      //       grabs any 4-digit token eats the register number;
      //   (2) a branch distributor (ABC Supply, White Cap, QXO) issues a
      //       PICKUP TICKET, not a register tape, and the most prominent
      //       address on it is AGX'S OWN under Bill To / Ship To. "The address
      //       at the top" captures our address as the vendor's.
      '- store_name: the merchant name EXACTLY as printed in the header, including any legal suffix. This may differ from "vendor" above; return what is on the paper.\n' +
      '- store_number: the STORE / BRANCH number of the location, as printed. It may appear as "#0242", "STORE 0242", or as a labelled field. Receipts often print the store, register and transaction numbers side by side in one row of digits — if you cannot tell WHICH of them is the store number, return null. Never return the register number, the transaction number, or the cashier id.\n' +
      '- store_address: the SELLER\'S OWN street address — the address of the store or branch that sold the goods, printed in the header above the items. If the only address on the page is under "Bill To", "Sold To", "Ship To" or "Remit To", that is the BUYER\'S address and you must return null. Never return the customer\'s address.\n' +
      '- store_phone: the phone number OF THAT STORE, from the header. Return it only if every digit is legible; if any digit is blurred, cropped or ambiguous, return null. A wrong phone number is worse than no phone number.\n' +
      'Use null for anything you cannot read. Guessing is worse than null on every field here.';
    const msg = await client.messages.create({
      model: OCR_MODEL,
      // 400 -> 500 for the four extra fields. This is a CAP, not a charge —
      // billing is on tokens actually emitted — and a truncated JSON object
      // fails the whole parse, taking the amount and the crop corners down
      // with it. The extra headroom removes that cliff for free.
      max_tokens: 500,
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
    // Store identity, through the SAME validators the save path uses, so the
    // client is never shown a value the server would refuse to store.
    const store = cleanStoreFields({
      store_number: parsed.store_number,
      store_name: parsed.store_name,
      store_address: parsed.store_address,
      store_phone: parsed.store_phone,
    }, vendor);
    // A branch number printed in the merchant string ("HOME DEPOT #0242") but
    // not in the store_number field is still a branch number. Only as a
    // fallback — the labelled field wins.
    if (!store.store_number) {
      const fromName = VN.normalizeVendorName(store.store_name || vendor || '');
      if (fromName.branch) store.store_number = VN.normalizeStoreNumber(fromName.branch);
    }
    res.json({
      ok: true, vendor: vendor, date: date, cost_code: cost_code, amount: amount, corners: corners,
      store_number: store.store_number, store_name: store.store_name,
      store_address: store.store_address, store_phone: store.store_phone,
    });
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

// DELETE /api/receipts/ocr/feedback/reset — wipe this org's OCR accuracy
// history (receipt_ocr_feedback) so the stats start fresh. Admin-gated
// (ROLES_MANAGE) + org-scoped. Receipts + their photos are NOT touched.
// 3-segment path — no conflict with the '/:id' param routes.
router.delete('/ocr/feedback/reset', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'Organization required' });
    const { rowCount } = await pool.query('DELETE FROM receipt_ocr_feedback WHERE organization_id = $1', [orgId]);
    res.json({ ok: true, deleted: rowCount || 0 });
  } catch (e) {
    console.error('DELETE /api/receipts/ocr/feedback/reset error:', e);
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
    // Drop a link that doesn't point at one of THIS org's jobs/leads, so a cost
    // can't be attributed to a foreign or nonexistent entity id.
    if (entityId && !(await entityInOrg(entityType, entityId, orgId))) { entityType = null; entityId = null; }
    const amount = cleanAmount(b.amount);
    const costCode = (b.cost_code && COST_CODES.has(String(b.cost_code))) ? String(b.cost_code) : 'materials';
    const isPresale = (entityType === 'lead');
    const purchasedAt = validDate(b.purchased_at) || new Date().toISOString().slice(0, 10);
    const status = deriveStatus(null, entityType, entityId, amount);
    // Slice 3 fields
    const tags = normalizeTags(b.tags);
    let subId = b.sub_id ? String(b.sub_id) : null;
    if (subId && !(await subInOrg(subId, orgId))) subId = null; // drop a foreign/unknown sub
    const paymentMethod = (b.payment_method && PAY_METHODS.has(String(b.payment_method))) ? String(b.payment_method) : null;
    const reimbursable = !!b.reimbursable;
    const reimburseTo = cleanStr(b.reimburse_to, 120);
    const isBillable = !!b.is_billable;
    const invoiceNo = cleanStr(b.invoice_no, 80);
    const id = newId();
    // Store identity, revalidated here rather than trusted from the client:
    // the values arrive from POST /ocr, but a body is a body.
    const store = cleanStoreFields(b, b.vendor);
    const { rows } = await pool.query(
      `INSERT INTO receipts
         (id, organization_id, ref, entity_type, entity_id, amount, vendor,
          cost_code, is_presale, notes, attachment_id, status, purchased_at, entered_by,
          tags, sub_id, payment_method, reimbursable, reimburse_to, is_billable, invoice_no,
          store_number, store_name, store_address, store_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       RETURNING ${COLS}`,
      [id, orgId, newRef(), entityType, entityId, amount, cleanStr(b.vendor, 200),
       costCode, isPresale, cleanStr(b.notes, 5000), cleanStr(b.attachment_id, 200),
       status, purchasedAt, callerUserId(req),
       JSON.stringify(tags), subId, paymentMethod, reimbursable, reimburseTo, isBillable, invoiceNo,
       store.store_number, store.store_name, store.store_address, store.store_phone]
    );
    res.json({ receipt: rows[0] });
    // Record OCR-suggestion-vs-saved accuracy (fire-and-forget; after response).
    if (b.ocr) {
      logOcrFeedback(orgId, id, b.ocr, {
        vendor: cleanStr(b.vendor, 200), date: purchasedAt, cost_code: costCode, amount: amount,
        attachment_id: cleanStr(b.attachment_id, 200)
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
    // Slice 3 fields (preserve existing on unrelated PATCHes)
    const tags = has('tags') ? normalizeTags(b.tags) : (row.tags || []);
    let subId = has('sub_id') ? (b.sub_id ? String(b.sub_id) : null) : row.sub_id;
    if (has('sub_id') && subId && !(await subInOrg(subId, orgId))) subId = null;
    const paymentMethod = has('payment_method') ? ((b.payment_method && PAY_METHODS.has(String(b.payment_method))) ? String(b.payment_method) : null) : row.payment_method;
    const reimbursable = has('reimbursable') ? !!b.reimbursable : row.reimbursable;
    const reimburseTo = has('reimburse_to') ? cleanStr(b.reimburse_to, 120) : row.reimburse_to;
    const isBillable = has('is_billable') ? !!b.is_billable : row.is_billable;
    const invoiceNo = has('invoice_no') ? cleanStr(b.invoice_no, 80) : row.invoice_no;
    // ── THE PRESERVE IDIOM, AND WHY THESE FOUR NEED IT MOST ─────────────────
    // Every unrelated PATCH goes through this SET list: the photo-attach step
    // (js/cost-inbox.js sends only attachment_id after the upload) and the
    // void / restore buttons (only status). A column named in the SET without
    // the `has(...) ? ... : row.<col>` fallback is NULLED by all of them —
    // one fact, two writers, one of them silent. The store fields are the
    // likeliest victims because the photo-attach PATCH fires moments after the
    // POST that captured them.
    const cleanedStore = cleanStoreFields(b, b.vendor || vendor);
    const storeNumber = has('store_number') ? cleanedStore.store_number : row.store_number;
    const storeName = has('store_name') ? cleanedStore.store_name : row.store_name;
    const storeAddress = has('store_address') ? cleanedStore.store_address : row.store_address;
    const storePhone = has('store_phone') ? cleanedStore.store_phone : row.store_phone;

    const { rows } = await pool.query(
      `UPDATE receipts SET
         entity_type = $3, entity_id = $4, amount = $5, vendor = $6, cost_code = $7,
         is_presale = $8, notes = $9, attachment_id = $10, status = $11,
         purchased_at = $12, tags = $13, sub_id = $14, payment_method = $15,
         reimbursable = $16, reimburse_to = $17, is_billable = $18, invoice_no = $19,
         store_number = $20, store_name = $21, store_address = $22, store_phone = $23,
         updated_at = NOW()
       WHERE id = $1 AND organization_id = $2
       RETURNING ${COLS}`,
      [req.params.id, orgId, entityType, entityId, amount, vendor, costCode,
       isPresale, notes, attachmentId, status, purchasedAt,
       JSON.stringify(tags), subId, paymentMethod, reimbursable, reimburseTo, isBillable, invoiceNo,
       storeNumber, storeName, storeAddress, storePhone]
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
