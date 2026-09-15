'use strict';
// ── BUILDERTREND → PROJECT 86: APPLY ─────────────────────────────────────
//
// The write half of the Buildertrend preview (sync-preview.js is the read
// half). An admin presses Apply on a row, or "Apply safe updates" for a whole
// dataset, and this module:
//
//   1. re-reads Clickr (or reuses the preview's read of the last few minutes)
//      and re-reads P86, then re-runs the SAME matcher. Nothing the browser
//      sends is trusted except which Buildertrend ids to act on;
//   2. acts only on rows the matcher calls matched/conflict — never ambiguous,
//      possible duplicate, new, change order or refused;
//   3. writes only the fields below, only when P86 still holds the value the
//      proposal was made from (a field someone edited since is skipped, named);
//   4. stamps the Buildertrend id (jobs.bt_job_id / leads.bt_lead_id, and
//      clients.bt_contact_id when the lead's client is the Buildertrend contact),
//      so every later preview finds the pair by id.
//
// MONEY AND IDENTITY: Buildertrend's contract price is a correction (owner: BT
// is the source of truth), applied when its box is ticked and never by safe
// mode. The job number and lead revenue are applied ONLY when a person ticks
// them (fields list). A job's approved-CO total is never written (P86 sums it
// from its change orders). CHANGE ORDERS (co-match.js) take title, status,
// price and cost from Buildertrend when their boxes are ticked; a sync never
// un-approves one and never edits an applied one. PURCHASE ORDERS (po-match.js)
// move forward in status only, take cost on an unlocked line or as an approved
// addendum on a locked PO, and never create a bill. A PO that ends a create,
// apply or link sent or approved (any active status) with a sub of this
// organization gives that sub portal access to the job's files, exactly as the
// PO page does on every save: the SAME grant (services/po-sub-access.js), run
// after the purchase-order transaction commits on the PO row re-read from the
// database, never for a draft, a PO without a sub, a foreign sub, or a write
// that failed. Estimates and crew-side data are never written.
//
// MODES
//   rows — the given Buildertrend ids: link + the ticked fields (every correction
//          on the row when no fields list is sent).
//   safe — every confident row in the dataset: link + fill a BLANK P86 start
//          date from Buildertrend's projected start (the owner's call: that is
//          safe to fill without review; P86's own start date is never replaced).
//
// Gates are the preview's: the host route's ROLES_MANAGE, then the caller's
// organization must be the one CLICKR_API_KEY belongs to (ownerSlug).
//
// Reached as a MODE of PUT /api/admin/organizations/me (?action=buildertrend-apply),
// so the committed route census does not move.

const { DATASETS, readRecord } = require('./field-map');
const { fetchDataset } = require('./client');
const match = require('./bt-match');
const preview = require('./sync-preview');
const { auditLog } = require('../../audit');
const jobTypes = require('../job-types');
const reconcile = require('./reconcile-merge');
const jobFin = require('../job-financials');
const coMatch = require('./co-match');
const poMatch = require('./po-match');
const coMoney = require('../money/change-order-totals');
const { coNumberKey } = require('../job-financials');
const { grantSubAccessForPO } = require('../po-sub-access');

const ACTION_PARAM = 'buildertrend-apply';
const MAX_ROWS = 200;

const JOB_FIELD_KEYS = { title: 'title', street: 'street_address', city: 'city', state: 'state', zip: 'zip', status: 'status', startDate: 'startDate' };
const LEAD_FIELD_COLUMNS = { title: 'title', street: 'street_address', city: 'city', state: 'state', zip: 'zip', source: 'source', confidence: 'confidence' };
const LEAD_ADDRESS = ['street', 'city', 'state', 'zip'];
const JOB_ADDRESS = ['street', 'city', 'state', 'zip'];

const str = (v) => (v == null ? '' : String(v));
const norm = (v) => str(v).trim().replace(/\s+/g, ' ');
const CONFIDENT = new Set(['matched', 'conflict']);

// P86 may hold 0, '' or null for "no figure": compared as numbers.
const moneyEq = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;
const LEAD_REVENUE_COLUMNS = { estimatedRevenueMin: 'estimated_revenue_low', estimatedRevenueMax: 'estimated_revenue_high' };
// Client contact details: correction/held-back field -> clients column. The name is never written.
const CLIENT_COLUMNS = { email: 'email', phone: 'phone', cell: 'cell', street: 'address', city: 'city', state: 'state', zip: 'zip' };
const CO_FIELDS = { title: 1, price: 1, cost: 1, status: 1 };
const PO_FIELDS = { status: 1, title: 1, costCode: 1, scheduledCompletion: 1, sub: 1, cost: 1 };
const PO_DATA_KEYS = { title: 'title', costCode: 'costCode', scheduledCompletion: 'scheduledCompletion' };
const DATASET_KINDS = ['jobs', 'leads', 'clients', 'changeOrders', 'purchaseOrders'];

function isSafeCorrection(kind, c) {
  return kind === 'jobs' && c.field === 'startDate' && c.kind === 'fill';
}

// Which corrections a row may write in this mode. In rows mode a `fields` list
// (the boxes a person left ticked) narrows it; without one every correction on
// the row applies. Safe mode is the blank start date only — never money.
function writable(kind, row, mode, fields) {
  const allowed = kind === 'jobs'
    ? Object.assign({ contractPrice: 1 }, JOB_FIELD_KEYS)
    : kind === 'changeOrders' ? CO_FIELDS
    : kind === 'purchaseOrders' ? PO_FIELDS
    : kind === 'clients' ? CLIENT_COLUMNS
    : Object.assign({ salesperson: 1, client: 1 }, LEAD_FIELD_COLUMNS);
  const pick = fields ? new Set(fields) : null;
  return (row.corrections || []).filter((c) => allowed[c.field]
    && (mode === 'rows' ? (!pick || pick.has(c.field)) : isSafeCorrection(kind, c)));
}

// Held-back items a person TICKED. Only in rows mode, only when the request
// names the field, only items the matcher marks applicable (job number, lead
// revenue). Approved change orders and unparsed money are never applicable.
function pickedHeldBack(kind, row, mode, fields) {
  if (mode !== 'rows' || !fields || kind === 'changeOrders') return [];
  // A locked purchase order's cost, as an approved addendum.
  if (kind === 'purchaseOrders') return (row.heldBack || []).filter((h) => h.applicable === true && h.field === 'cost' && fields.indexOf('cost') !== -1);
  const allowed = kind === 'jobs' ? { jobNumber: 1 } : kind === 'clients' ? CLIENT_COLUMNS : LEAD_REVENUE_COLUMNS;
  const pick = new Set(fields);
  return (row.heldBack || []).filter((h) => h.applicable === true && allowed[h.field] && pick.has(h.field));
}

async function readDataset(org, kind, deps) {
  const cached = preview.cachedFetch && preview.cachedFetch(org.id, kind, deps.maxAgeMs);
  if (cached) return cached;
  const env = deps.env || process.env;
  const apiKey = env.CLICKR_API_KEY ? String(env.CLICKR_API_KEY).trim() : '';
  return fetchDataset({ datasetId: DATASETS[kind].datasetId, label: DATASETS[kind].label, idKey: DATASETS[kind].idKey, apiKey,
    transport: deps.transport, limits: deps.limits, now: deps.now, baseUrl: deps.baseUrl });
}

// ── jobs ─────────────────────────────────────────────────────────────────
async function applyJob(db, orgId, row, mode, fields) {
  const btId = norm(row.bt.btId);
  const cur = await db.query('SELECT id, data, bt_job_id FROM jobs WHERE id = $1 AND organization_id = $2 FOR UPDATE', [row.p86.id, orgId]);
  if (!cur.rows.length) return { skipped: 'The P86 job is no longer there.' };
  const job = cur.rows[0];
  const linkedTo = norm(job.bt_job_id);
  if (linkedTo && linkedTo !== btId) return { skipped: 'This P86 job is already linked to a different Buildertrend job.' };
  const taken = await db.query('SELECT id FROM jobs WHERE organization_id = $1 AND bt_job_id = $2 AND id <> $3', [orgId, btId, job.id]);
  if (taken.rows.length) return { skipped: 'Another P86 job is already linked to this Buildertrend job.' };

  const data = (job.data && typeof job.data === 'object') ? Object.assign({}, job.data) : {};
  const applied = [];
  const stale = [];
  for (const c of writable('jobs', row, mode, fields)) {
    if (c.field === 'contractPrice') {
      if (!moneyEq(data.contractAmount, c.p86Value) || !Number.isFinite(c.value)) { stale.push(c.label || c.field); continue; }
      data.contractAmount = c.value;
      applied.push({ field: c.field, from: c.from, to: c.to });
      continue;
    }
    const key = JOB_FIELD_KEYS[c.field];
    const now = c.field === 'title' ? (data.title || data.name) : data[key];
    if (norm(now) !== norm(c.from)) { stale.push(c.label || c.field); continue; }
    const value = c.field === 'status' ? (c.toP86 || c.to) : c.to;
    data[key] = value;
    applied.push({ field: c.field, from: c.from, to: value });
  }
  for (const h of pickedHeldBack('jobs', row, mode, fields)) {
    // JOB NUMBER, ticked on purpose. Still refused when P86 changed it since the
    // preview, or when another job of this organization already carries it.
    if (norm(data.jobNumber) !== norm(h.p86)) { stale.push(h.label || h.field); continue; }
    const clash = await db.query(
      "SELECT id FROM jobs WHERE organization_id = $1 AND id <> $2 AND UPPER(TRIM(data->>'jobNumber')) = UPPER(TRIM($3))",
      [orgId, job.id, h.value]);
    if (clash.rows.length) { stale.push((h.label || h.field) + ' — another P86 job already uses ' + h.value); continue; }
    data.jobNumber = h.value;
    applied.push({ field: h.field, from: h.p86, to: h.value });
  }
  if (applied.some((a) => JOB_ADDRESS.includes(a.field))) {
    // Same composition the job page uses (js/jobs.js saveJobAddress); the map
    // re-geocodes lazily when geocode_address no longer equals it.
    data.address = [data.street_address, data.city, data.state, data.zip].filter((x) => norm(x)).join(', ');
  }
  const wasLinked = linkedTo === btId;
  if (!applied.length && wasLinked) return { unchanged: true, stale };
  await db.query('UPDATE jobs SET data = $1::jsonb, bt_job_id = $2, updated_at = NOW() WHERE id = $3 AND organization_id = $4',
    [JSON.stringify(data), btId, job.id, orgId]);
  return { applied, linked: !wasLinked, stale };
}

// ── change orders ────────────────────────────────────────────────────────
// Reached only through its job, which must still be in this organization and
// still linked to the Buildertrend job the change order belongs to. Its own
// organization must agree or be empty, as in sync-preview.js readP86, and every
// write repeats the job's organization in the statement.
async function lockedChangeOrder(db, orgId, coId, btJobId) {
  await db.query('SELECT id FROM job_change_orders WHERE id = $1 FOR UPDATE', [coId]);
  const cur = await db.query(
    'SELECT co.id, co.job_id, co.status, co.co_number, co.data, co.is_locked, co.linked_node_id, co.bt_co_id FROM job_change_orders co JOIN jobs j ON j.id = co.job_id '
    + 'WHERE co.id = $1 AND j.organization_id = $2 AND j.bt_job_id = $3 AND j.bt_archived_at IS NULL AND (co.organization_id = $2 OR co.organization_id IS NULL)',
    [coId, orgId, btJobId]);
  return cur.rows[0] || null;
}

async function coLinkedElsewhere(db, orgId, btId, exceptId) {
  const taken = await db.query(
    'SELECT co.id FROM job_change_orders co JOIN jobs j ON j.id = co.job_id WHERE j.organization_id = $1 AND co.bt_co_id = $2 AND co.id <> $3',
    [orgId, btId, exceptId || '']);
  return taken.rows.length > 0;
}

function parseData(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return {}; }
}

async function applyChangeOrder(db, orgId, row, mode, fields) {
  const btId = norm(row.bt.btId);
  const co = await lockedChangeOrder(db, orgId, row.p86.id, norm(row.bt.jobId));
  if (!co) return { skipped: 'The P86 change order is no longer on the job linked to this Buildertrend job.' };
  const linkedTo = norm(co.bt_co_id);
  if (linkedTo && linkedTo !== btId) return { skipped: 'This P86 change order is already linked to a different Buildertrend change order.' };
  if (await coLinkedElsewhere(db, orgId, btId, co.id)) return { skipped: 'Another P86 change order is already linked to this Buildertrend change order.' };

  let data = parseData(co.data);
  const applied = [];
  const stale = [];
  let approve = null;
  for (const c of writable('changeOrders', row, mode, fields)) {
    if (c.field === 'status') { approve = c; continue; }
    if (co.status === 'applied') { stale.push((c.label || c.field) + ' — the change order is applied'); continue; }
    if (c.field === 'title') {
      if (norm(data.title) !== norm(c.from)) { stale.push(c.label || c.field); continue; }
      data = Object.assign({}, data, { title: c.to });
      applied.push({ field: 'title', from: c.from, to: c.to });
      continue;
    }
    const now = coMoney.changeOrderMoney(data);
    const current = c.field === 'price' ? now.income : now.costs;
    if (!moneyEq(current, c.p86Value)) { stale.push(c.label || c.field); continue; }
    const next = c.field === 'price' ? coMatch.withPrice(data, c.value) : coMatch.withCost(data, c.value);
    if (!next) { stale.push((c.label || c.field) + ' — P86 could not reach ' + c.to + ' on this change order'); continue; }
    data = next;
    applied.push({ field: c.field, from: c.from, to: c.to });
  }
  const wasLinked = linkedTo === btId;
  let approvedAt = null;
  if (approve) {
    if (co.status !== 'draft') stale.push('Status — P86 is no longer a draft');
    else if (norm(co.linked_node_id)) stale.push('Status — linked to a Site Plan node; approve it in P86');
    else {
      approvedAt = coMatch.approvalInstant(row.bt.statusChangedDate) || new Date().toISOString();
      data = Object.assign({}, data, { approvedInBuildertrend: { by: norm(row.bt.statusChangedBy), date: match.dateKey(row.bt.statusChangedDate) || null } });
      applied.push({ field: 'status', from: 'draft', to: 'approved' });
    }
  }
  if (!applied.length && wasLinked) return { unchanged: true, stale };
  await db.query('UPDATE job_change_orders SET data = $1::jsonb, bt_co_id = $2, updated_at = NOW() WHERE id = $3 AND job_id IN (SELECT id FROM jobs WHERE organization_id = $4)',
    [JSON.stringify(data), btId, co.id, orgId]);
  if (approvedAt) {
    // Approved = locked, as the status route does. The approver is Buildertrend's
    // (kept in data.approvedInBuildertrend): no P86 user is stamped as approver.
    await db.query("UPDATE job_change_orders SET status = 'approved', approved_at = $1, approved_by = NULL, is_locked = TRUE WHERE id = $2 AND status = 'draft' AND job_id IN (SELECT id FROM jobs WHERE organization_id = $3)",
      [approvedAt, co.id, orgId]);
  }
  return { applied, linked: !wasLinked, stale };
}

async function createChangeOrder(db, orgId, row, user) {
  const bt = row.bt;
  const btId = norm(bt.btId);
  if (row.createBlocked) return { skipped: row.createBlocked };
  const job = await db.query("SELECT id, data->'changeOrders' AS legacy FROM jobs WHERE organization_id = $1 AND bt_job_id = $2 AND bt_archived_at IS NULL", [orgId, norm(bt.jobId)]);
  if (job.rows.length !== 1) return { skipped: 'Its Buildertrend job is not linked to a P86 job.' };
  const jobId = job.rows[0].id;
  if (await coLinkedElsewhere(db, orgId, btId, null)) return { skipped: 'A P86 change order is already linked to this Buildertrend change order.' };
  const existing = await db.query('SELECT co_number FROM job_change_orders WHERE job_id = $1', [jobId]);
  const legacy = parseData(job.rows[0].legacy);
  if (!existing.rows.length && Array.isArray(legacy) && legacy.length) {
    return { skipped: 'This job\'s change orders still live in its old per-job list; creating one here would hide them from WIP.' };
  }
  const number = match.isBtBlank(bt.coNumber) ? '' : norm(bt.coNumber);
  if (!number) return { skipped: 'This Buildertrend change order has no number, so it is not created.' };
  if (existing.rows.some((r) => coNumberKey(r.co_number) === coNumberKey(number))) {
    return { skipped: 'P86 already has a change order numbered ' + number + ' on this job.' };
  }
  const priceM = match.parseMoney(bt.totalPrice);
  const costM = match.parseMoney(bt.builderCost);
  if (priceM.kind === 'unparsed' || priceM.kind === 'range' || costM.kind === 'unparsed' || costM.kind === 'range') {
    return { skipped: 'Buildertrend\'s price or cost on this change order is not readable money, so it is not created.' };
  }
  const price = priceM.kind === 'value' ? priceM.value : 0;
  const cost = costM.kind === 'value' ? costM.value : 0;
  const notes = [];
  const title = match.isBtBlank(bt.title) ? number : norm(bt.title);
  const line = { id: 'line_bt_' + btId, description: title, qty: 1, unitCost: cost, unitSell: price };
  if (!cost && price > 0) {
    // No cost in Buildertrend: the cost is the price, flagged — the importer's
    // conservative reading (zero profit until a real cost is entered), never $0.
    line.unitCost = price;
    line.costPending = true;
    notes.push('“' + title + '” has no builder cost in Buildertrend, so its cost is set to the price and marked as a placeholder.');
  }
  const approved = coMatch.btCoState(bt.statusText) === 'approved';
  const data = { title, lines: [line], defaultMarkup: 0, btStatus: match.isBtBlank(bt.statusText) ? '' : norm(bt.statusText) };
  if (approved) data.approvedInBuildertrend = { by: norm(bt.statusChangedBy), date: match.dateKey(bt.statusChangedDate) || null };
  const m = coMoney.changeOrderMoney(data);
  if (Math.abs(m.income - price) >= 0.005) return { skipped: 'P86 could not reproduce Buildertrend\'s price on this change order, so it is not created.' };
  const id = genId('co_');
  await db.query(
    'INSERT INTO job_change_orders (id, job_id, owner_id, status, co_number, data, approved_at, approved_by, is_locked, organization_id, bt_co_id) '
    + 'VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NULL, $8, (SELECT organization_id FROM jobs WHERE id = $2), $9)',
    [id, jobId, user && user.id != null ? user.id : null, approved ? 'approved' : 'draft', number, JSON.stringify(data),
      approved ? (coMatch.approvalInstant(bt.statusChangedDate) || new Date().toISOString()) : null, approved, btId]);
  return { created: id, notes };
}

// ── purchase orders ──────────────────────────────────────────────────────
async function lockedPurchaseOrder(db, orgId, poId, btJobId) {
  await db.query('SELECT id FROM job_purchase_orders WHERE id = $1 FOR UPDATE', [poId]);
  const cur = await db.query(
    'SELECT po.id, po.job_id, po.status, po.po_number, po.data, po.is_locked, po.sub_id, po.bt_po_id, '
    + "(SELECT COALESCE(SUM(b.amount), 0) FROM job_vendor_bills b WHERE b.po_id = po.id AND b.status <> 'void') AS billed "
    + 'FROM job_purchase_orders po JOIN jobs j ON j.id = po.job_id '
    + 'WHERE po.id = $1 AND j.organization_id = $2 AND j.bt_job_id = $3 AND j.bt_archived_at IS NULL AND (po.organization_id = $2 OR po.organization_id IS NULL)',
    [poId, orgId, btJobId]);
  return cur.rows[0] || null;
}

async function poLinkedElsewhere(db, orgId, btId, exceptId) {
  const taken = await db.query(
    'SELECT po.id FROM job_purchase_orders po JOIN jobs j ON j.id = po.job_id WHERE j.organization_id = $1 AND po.bt_po_id = $2 AND po.id <> $3',
    [orgId, btId, exceptId || '']);
  return taken.rows.length > 0;
}

async function subOfOrg(db, orgId, subId) {
  const r = await db.query('SELECT id, name FROM subs WHERE id = $1 AND organization_id = $2', [String(subId), orgId]);
  return r.rows[0] || null;
}

async function applyPurchaseOrder(db, orgId, row, mode, fields) {
  const btId = norm(row.bt.btId);
  const po = await lockedPurchaseOrder(db, orgId, row.p86.id, norm(row.bt.jobId));
  if (!po) return { skipped: 'The P86 purchase order is no longer on the job linked to this Buildertrend job.' };
  const linkedTo = norm(po.bt_po_id);
  if (linkedTo && linkedTo !== btId) return { skipped: 'This P86 purchase order is already linked to a different Buildertrend purchase order.' };
  if (await poLinkedElsewhere(db, orgId, btId, po.id)) return { skipped: 'Another P86 purchase order is already linked to this Buildertrend purchase order.' };

  let data = parseData(po.data);
  let subId = po.sub_id || null;
  const applied = [];
  const stale = [];
  let move = null;
  const locked = po.is_locked === true || po.is_locked === 1;
  const editable = !locked && po.status !== 'closed';
  for (const c of writable('purchaseOrders', row, mode, fields)) {
    if (c.field === 'status') { move = c; continue; }
    if (!editable) { stale.push((c.label || c.field) + ' — the purchase order is locked'); continue; }
    if (PO_DATA_KEYS[c.field]) {
      if (norm(data[PO_DATA_KEYS[c.field]]) !== norm(c.from)) { stale.push(c.label || c.field); continue; }
      data = Object.assign({}, data, { [PO_DATA_KEYS[c.field]]: c.to });
      applied.push({ field: c.field, from: c.from, to: c.to });
    } else if (c.field === 'sub') {
      if (subId) { stale.push('Sub/vendor — P86 has one now'); continue; }
      const sub = await subOfOrg(db, orgId, c.value);
      if (!sub) { stale.push('Sub/vendor — not a sub of this organization'); continue; }
      subId = sub.id;
      applied.push({ field: 'sub', from: '', to: sub.name });
    } else if (c.field === 'cost') {
      if (!moneyEq(poMatch.poTotal(data), c.p86Value)) { stale.push(c.label || c.field); continue; }
      const next = poMatch.withLineCost(data, c.value, row.bt.title);
      if (!next) { stale.push('Cost — P86 could not set ' + c.to + ' on this purchase order'); continue; }
      data = next;
      applied.push({ field: 'cost', from: c.from, to: c.to });
    }
  }
  for (const h of pickedHeldBack('purchaseOrders', row, mode, fields)) {
    if (!locked || po.status === 'closed') { stale.push('Cost — the purchase order is no longer locked'); continue; }
    if (!moneyEq(poMatch.poTotal(data), h.p86Value)) { stale.push('Cost'); continue; }
    if (h.value < (Number(po.billed) || 0) - 0.005) { stale.push('Cost — below what is already billed'); continue; }
    const next = poMatch.withAddendum(data, h.value);
    if (!next) { stale.push('Cost — no difference to record'); continue; }
    data = next;
    applied.push({ field: 'cost', from: h.p86, to: h.bt, addendum: true });
  }
  let status = po.status;
  let nowLocked = locked;
  if (move) {
    if (poMatch.RANK[move.value] == null || poMatch.RANK[po.status] == null || poMatch.RANK[move.value] <= poMatch.RANK[po.status]) {
      stale.push('Status — P86 is no longer behind Buildertrend');
    } else {
      status = move.value;
      if (status !== 'draft') {
        nowLocked = true;
        // Freeze the committed baseline the first time it locks, as the status route does.
        if (data.baselineTotal == null) data = Object.assign({}, data, { baselineTotal: poMatch.poTotal(Object.assign({}, data, { baselineTotal: undefined })) });
        if (data.revising) { data = Object.assign({}, data); delete data.revising; }
      }
      if (poMatch.RANK[status] >= poMatch.RANK.approved && !data.approvedInBuildertrend) {
        data = Object.assign({}, data, { approvedInBuildertrend: { by: norm(row.bt.approvalUser) } });
      }
      applied.push({ field: 'status', from: po.status, to: status });
    }
  }
  const wasLinked = linkedTo === btId;
  if (!applied.length && wasLinked) return { unchanged: true, stale };
  await db.query(
    `UPDATE job_purchase_orders SET data = $1::jsonb, sub_id = $2, status = $3, is_locked = $4, bt_po_id = $5,
       approved_at = CASE WHEN $3 IN ('approved', 'work_complete') AND approved_at IS NULL THEN NOW() ELSE approved_at END, updated_at = NOW()
     WHERE id = $6 AND job_id IN (SELECT id FROM jobs WHERE organization_id = $7)`,
    [JSON.stringify(data), subId, status, nowLocked, btId, po.id, orgId]);
  return { applied, linked: !wasLinked, stale };
}

// SUB PORTAL ACCESS, as the PO page grants it. Called only AFTER the
// purchase-order transaction has committed and its client is released: the
// grant writes through the pool, so inside the transaction it would either
// miss the uncommitted row or survive a rollback of it. The FINAL row is
// re-read here, org-scoped through its job (never the matcher's in-memory
// values), and handed to the PO page's own grant, which refuses a draft, a PO
// without a sub, and a sub outside this organization — so Apply or Link on a PO
// synced before this rule gives its sub access too.
// True only when this call gave the sub access it did not have. A sub already
// assigned to the job AND granted its files is left alone: nothing is written,
// so a repeat Apply or safe sweep never rewrites who first granted that access
// or when (a save on the PO page still refreshes granted_by, as it always has).
// Access someone removed by hand IS given again, as the PO page's next save
// would; the page counts those POs on its safe button and says so first.
// Never throws: access is best-effort, as on the PO page, and never turns a
// committed write into a failure. Scoped the way this file's purchase-order
// UPDATEs are — through the job, with no tolerance arm of its own: the id is
// one this operation just wrote or linked.
const truthy = (v) => v === true || v === 1 || v === '1' || v === 't';
async function grantPoSubAccessAfterCommit(pool, orgId, poId, user) {
  if (!poId) return false;
  try {
    const r = await pool.query(
      'SELECT po.id, po.job_id, po.sub_id, po.status, '
      + 'EXISTS (SELECT 1 FROM job_subs js WHERE js.job_id = po.job_id AND js.sub_id = po.sub_id) AS assigned, '
      + "EXISTS (SELECT 1 FROM attachment_folder_grants g WHERE g.sub_id = po.sub_id AND g.entity_type = 'job' AND g.entity_id = po.job_id AND g.folder = 'general') AS granted "
      + 'FROM job_purchase_orders po '
      + 'WHERE po.id = $1 AND po.job_id IN (SELECT id FROM jobs WHERE organization_id = $2)',
      [poId, orgId]);
    if (!r.rows.length) return false;
    const po = r.rows[0];
    if (truthy(po.assigned) && truthy(po.granted)) return false;
    return (await grantSubAccessForPO({ id: po.id, job_id: po.job_id, sub_id: po.sub_id, status: po.status },
      user && user.id != null ? user.id : null, orgId)) === true;
  } catch (e) {
    console.warn('[clickr-apply] purchase order sub access was not granted');
    return false;
  }
}

async function createPurchaseOrder(db, orgId, row, user) {
  const bt = row.bt;
  const btId = norm(bt.btId);
  if (row.createBlocked) return { skipped: row.createBlocked };
  const job = await db.query("SELECT id, data->'purchaseOrders' AS legacy FROM jobs WHERE organization_id = $1 AND bt_job_id = $2 AND bt_archived_at IS NULL", [orgId, norm(bt.jobId)]);
  if (job.rows.length !== 1) return { skipped: 'Its Buildertrend job is not linked to a P86 job.' };
  const jobId = job.rows[0].id;
  if (await poLinkedElsewhere(db, orgId, btId, null)) return { skipped: 'A P86 purchase order is already linked to this Buildertrend purchase order.' };
  const existing = await db.query('SELECT po_number FROM job_purchase_orders WHERE job_id = $1', [jobId]);
  const legacy = parseData(job.rows[0].legacy);
  if (!existing.rows.length && Array.isArray(legacy) && legacy.length) {
    return { skipped: 'This job\'s purchase orders still live in its old per-job list; creating one here would hide them.' };
  }
  const number = match.isBtBlank(bt.poNumber) ? '' : norm(bt.poNumber);
  if (!number) return { skipped: 'This Buildertrend purchase order has no number, so it is not created.' };
  if (existing.rows.some((r) => poMatch.poNumberKey(r.po_number) === poMatch.poNumberKey(number))) {
    return { skipped: 'P86 already has a purchase order numbered ' + number + ' on this job.' };
  }
  const costM = match.parseMoney(bt.cost);
  if (costM.kind === 'unparsed' || costM.kind === 'range') return { skipped: 'Buildertrend\'s cost on this purchase order is not readable money, so it is not created.' };
  const cost = costM.kind === 'value' ? costM.value : 0;
  const notes = [];
  const status = poMatch.btPoState(bt.statusText, bt.workStatusText) || 'draft';
  const code = (bt.costCodes || []).length === 1 ? norm(bt.costCodes[0]) : '';
  const title = match.isBtBlank(bt.title) ? (code || 'Purchase order ' + number) : norm(bt.title);
  const rs = poMatch.resolveSub((await db.query("SELECT id, name FROM subs WHERE organization_id = $1 AND COALESCE(status, 'active') <> 'closed'", [orgId])).rows, bt.subName);
  if (rs.why) notes.push('“' + title + '”: ' + rs.why);
  const data = { title, lines: [{ description: title, qty: 1, unitCost: cost }], scope: await jobFin.orgScopeTemplate(db, orgId) };
  if (code) data.costCode = code;
  const day = match.dateKey(bt.estCompleteDate);
  if (day) data.scheduledCompletion = day;
  if (!rs.sub && !match.isBtBlank(bt.subName)) data.vendorName = norm(bt.subName);
  const locked = status !== 'draft';
  if (locked) data.baselineTotal = cost;
  if (poMatch.RANK[status] >= poMatch.RANK.approved) data.approvedInBuildertrend = { by: norm(bt.approvalUser) };
  if (Math.abs(poMatch.poTotal(data) - cost) >= 0.005) return { skipped: 'P86 could not reproduce Buildertrend\'s cost on this purchase order, so it is not created.' };
  const id = genId('po_');
  await db.query(
    'INSERT INTO job_purchase_orders (id, job_id, organization_id, owner_id, sub_id, status, po_number, data, is_locked, approved_at, approved_by, bt_po_id) '
    + "VALUES ($1, $2, (SELECT organization_id FROM jobs WHERE id = $2), $3, $4, $5, $6, $7::jsonb, $8, CASE WHEN $5 IN ('approved', 'work_complete') THEN NOW() ELSE NULL END, NULL, $9)",
    [id, jobId, user && user.id != null ? user.id : null, rs.sub ? rs.sub.id : null, status, number, JSON.stringify(data), locked, btId]);
  return { created: id, notes };
}

// ── leads ────────────────────────────────────────────────────────────────
async function applyLead(db, orgId, row, mode, fields) {
  const btId = norm(row.bt.btId);
  // Lock the lead row on its own: Postgres refuses FOR UPDATE across the outer
  // joins below.
  await db.query('SELECT id FROM leads WHERE id = $1 AND organization_id = $2 FOR UPDATE', [row.p86.id, orgId]);
  const cur = await db.query(
    'SELECT l.id, l.title, l.street_address, l.city, l.state, l.zip, l.source, l.confidence, l.salesperson_id, l.client_id, l.bt_lead_id, '
    + 'l.estimated_revenue_low, l.estimated_revenue_high, '
    + 'u.name AS salesperson_name, c.name AS client_name '
    + 'FROM leads l '
    + 'LEFT JOIN users u ON u.id = l.salesperson_id AND u.organization_id = $2 '
    + 'LEFT JOIN clients c ON c.id = l.client_id AND c.organization_id = $2 '
    + 'WHERE l.id = $1 AND l.organization_id = $2', [row.p86.id, orgId]);
  if (!cur.rows.length) return { skipped: 'The P86 lead is no longer there.' };
  const lead = cur.rows[0];
  const linkedTo = norm(lead.bt_lead_id);
  if (linkedTo && linkedTo !== btId) return { skipped: 'This P86 lead is already linked to a different Buildertrend lead.' };
  const taken = await db.query('SELECT id FROM leads WHERE organization_id = $1 AND bt_lead_id = $2 AND id <> $3', [orgId, btId, lead.id]);
  if (taken.rows.length) return { skipped: 'Another P86 lead is already linked to this Buildertrend lead.' };

  const sets = {};
  const applied = [];
  const stale = [];
  for (const h of pickedHeldBack('leads', row, mode, fields)) {
    // LEAD REVENUE, ticked on purpose.
    const col = LEAD_REVENUE_COLUMNS[h.field];
    if (!moneyEq(lead[col], h.p86Value) || !Number.isFinite(h.value)) { stale.push(h.label || h.field); continue; }
    sets[col] = h.value;
    applied.push({ field: h.field, from: h.p86, to: h.bt });
  }
  for (const c of writable('leads', row, mode, fields)) {
    if (c.field === 'salesperson' || c.field === 'client') {
      const current = c.field === 'salesperson' ? lead.salesperson_name : lead.client_name;
      if (norm(current) !== norm(c.from)) { stale.push(c.label || c.field); continue; }
      // The matcher names exactly one org record; confirm it still is exactly one.
      const hit = c.field === 'salesperson'
        ? await db.query('SELECT id FROM users WHERE organization_id = $1 AND active = true AND LOWER(TRIM(name)) = LOWER(TRIM($2))', [orgId, c.to])
        : await db.query('SELECT id FROM clients WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2))', [orgId, c.to]);
      if (hit.rows.length !== 1) { stale.push(c.label || c.field); continue; }
      sets[c.field === 'salesperson' ? 'salesperson_id' : 'client_id'] = hit.rows[0].id;
      applied.push({ field: c.field, from: c.from, to: c.to });
      continue;
    }
    const col = LEAD_FIELD_COLUMNS[c.field];
    if (norm(lead[col]) !== norm(c.from)) { stale.push(c.label || c.field); continue; }
    sets[col] = c.field === 'confidence' ? Math.max(0, Math.min(100, parseInt(c.to, 10) || 0)) : c.to;
    applied.push({ field: c.field, from: c.from, to: c.to });
  }
  const addressChanged = applied.some((a) => LEAD_ADDRESS.includes(a.field));
  if (addressChanged) { sets.geocode_lat = null; sets.geocode_lng = null; }
  const wasLinked = linkedTo === btId;

  let contactLinked = false;
  const contactId = norm(row.bt.contactId);
  if (contactId) {
    // The lead's client (after this apply) IS the Buildertrend contact when the
    // names agree exactly; stamp its id once, never over a different one.
    const clientId = sets.client_id != null ? sets.client_id : lead.client_id;
    if (clientId != null) {
      const cl = await db.query('SELECT id, name, bt_contact_id FROM clients WHERE id = $1 AND organization_id = $2', [clientId, orgId]);
      const client = cl.rows[0];
      if (client && !norm(client.bt_contact_id) && norm(client.name).toLowerCase() === norm(row.bt.contactName).toLowerCase()) {
        const other = await db.query('SELECT id FROM clients WHERE organization_id = $1 AND bt_contact_id = $2', [orgId, contactId]);
        if (!other.rows.length) {
          await db.query('UPDATE clients SET bt_contact_id = $1 WHERE id = $2 AND organization_id = $3', [contactId, client.id, orgId]);
          contactLinked = true;
        }
      }
    }
  }

  if (!applied.length && wasLinked) return { unchanged: !contactLinked, contactLinked, stale };
  const cols = Object.keys(sets);
  const params = cols.map((k) => sets[k]);
  params.push(btId, lead.id, orgId);
  const n = params.length;
  await db.query('UPDATE leads SET ' + cols.map((k, i) => k + ' = $' + (i + 1)).concat(['bt_lead_id = $' + (n - 2), 'updated_at = NOW()']).join(', ')
    + ' WHERE id = $' + (n - 1) + ' AND organization_id = $' + n, params);
  return { applied, linked: !wasLinked, stale, contactLinked, regeocode: addressChanged ? lead.id : null };
}

// ── clients ──────────────────────────────────────────────────────────────
async function applyClient(db, orgId, row, mode, fields) {
  const btId = norm(row.bt.btId);
  const cur = await db.query('SELECT id, name, email, phone, cell, address, city, state, zip, bt_contact_id FROM clients WHERE id = $1 AND organization_id = $2 FOR UPDATE', [row.p86.id, orgId]);
  if (!cur.rows.length) return { skipped: 'The P86 client is no longer there.' };
  const client = cur.rows[0];
  const linkedTo = norm(client.bt_contact_id);
  if (linkedTo && linkedTo !== btId) return { skipped: 'This P86 client is already linked to a different Buildertrend contact.' };
  const taken = await db.query('SELECT id FROM clients WHERE organization_id = $1 AND bt_contact_id = $2 AND id <> $3', [orgId, btId, client.id]);
  if (taken.rows.length) return { skipped: 'Another P86 client is already linked to this Buildertrend contact.' };

  const sets = {};
  const applied = [];
  const stale = [];
  for (const c of writable('clients', row, mode, fields)) {
    const col = CLIENT_COLUMNS[c.field];
    if (norm(client[col]) !== norm(c.from)) { stale.push(c.label || c.field); continue; }
    sets[col] = c.to;
    applied.push({ field: c.field, from: c.from, to: c.to });
  }
  for (const h of pickedHeldBack('clients', row, mode, fields)) {
    const col = CLIENT_COLUMNS[h.field];
    if (norm(client[col]) !== norm(h.p86)) { stale.push(h.label || h.field); continue; }
    sets[col] = h.value;
    applied.push({ field: h.field, from: h.p86, to: h.value });
  }
  const wasLinked = linkedTo === btId;
  if (!applied.length && wasLinked) return { unchanged: true, stale };
  const cols = Object.keys(sets);
  const params = cols.map((k) => sets[k]);
  params.push(btId, client.id, orgId);
  const n = params.length;
  await db.query('UPDATE clients SET ' + cols.map((k, i) => k + ' = $' + (i + 1)).concat(['bt_contact_id = $' + (n - 2), 'updated_at = NOW()']).join(', ')
    + ' WHERE id = $' + (n - 1) + ' AND organization_id = $' + n, params);
  return { applied, linked: !wasLinked, stale };
}

async function geocodeLeadLater(pool, id) {
  try {
    const r = await pool.query('SELECT street_address, city, state, zip FROM leads WHERE id = $1', [id]);
    const l = r.rows[0];
    if (!l) return;
    const parts = [l.street_address, l.city, l.state, l.zip].map((s) => norm(s)).filter(Boolean);
    if (parts.length < 2) return;
    const g = await require('../../geocoder').geocodeAddress(parts.join(', '));
    if (g && Number.isFinite(g.lat) && Number.isFinite(g.lng) && !(g.lat === 0 && g.lng === 0)) {
      await pool.query("UPDATE leads SET geocode_lat = $1, geocode_lng = $2, geocode_status = 'ok', geocode_at = NOW() WHERE id = $3", [g.lat, g.lng, id]);
    } else {
      await pool.query("UPDATE leads SET geocode_status = 'failed', geocode_at = NOW() WHERE id = $1", [id]);
    }
  } catch (e) { console.error('[clickr-apply] lead geocode failed'); }
}

// ── CREATE: bring a Buildertrend-only record into P86 ──────────────────────
//
// Only rows the matcher calls "new" — never ambiguous, possible duplicate, a
// change-order row, a bucket without a number, or a refused row. The created
// record carries its Buildertrend id, so the next read finds it by id and the
// same Buildertrend record can never be created twice (unique index per org).
// Owner decisions (2026-09-13): jobs are created in bulk for Open + Warranty
// only; a Closed job is created one at a time on request. Create clients
// first: leads and jobs link to a client only through its Buildertrend id.

function genId(prefix) {
  return prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function clientIdForContact(db, orgId, contactIds) {
  for (const cid of contactIds || []) {
    if (!norm(cid)) continue;
    const r = await db.query('SELECT id, name FROM clients WHERE organization_id = $1 AND bt_contact_id = $2', [orgId, norm(cid)]);
    if (r.rows.length === 1) return r.rows[0];
  }
  return null;
}

async function createClient(db, orgId, row) {
  const bt = row.bt;
  const btId = norm(bt.btId);
  const taken = await db.query('SELECT id FROM clients WHERE organization_id = $1 AND bt_contact_id = $2', [orgId, btId]);
  if (taken.rows.length) return { skipped: 'A P86 client is already linked to this Buildertrend contact.' };
  const id = genId('client_');
  const val = (v) => (match.isBtBlank(v) ? null : norm(v));
  await db.query(
    'INSERT INTO clients (id, organization_id, name, email, phone, cell, address, city, state, zip, bt_contact_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id, orgId, norm(bt.name), val(bt.email), val(bt.phone), val(bt.cell), val(bt.street), val(bt.city), val(bt.state), val(bt.zip), btId]);
  return { created: id, fields: ['name'].concat(['email', 'phone', 'cell', 'street', 'city', 'state', 'zip'].filter((k) => val(bt[k]))) };
}

async function createLead(db, orgId, row, user) {
  const bt = row.bt;
  const btId = norm(bt.btId);
  const taken = await db.query('SELECT id FROM leads WHERE organization_id = $1 AND bt_lead_id = $2', [orgId, btId]);
  if (taken.rows.length) return { skipped: 'A P86 lead is already linked to this Buildertrend lead.' };
  const notes = [];
  let clientId = null;
  if (norm(bt.contactId)) {
    const c = await clientIdForContact(db, orgId, [bt.contactId]);
    if (c) clientId = c.id;
    else if (!match.isBtBlank(bt.contactName)) notes.push('No P86 client is linked to Buildertrend contact "' + norm(bt.contactName) + '" yet — create or link it on the Clients tab, then apply the client on this lead.');
  }
  let salespersonId = null;
  if (!match.isBtBlank(bt.salesperson)) {
    const u = await db.query('SELECT id FROM users WHERE organization_id = $1 AND active = true AND LOWER(TRIM(name)) = LOWER(TRIM($2))', [orgId, norm(bt.salesperson)]);
    if (u.rows.length === 1) salespersonId = u.rows[0].id;
    else notes.push('Salesperson "' + norm(bt.salesperson) + '" is not exactly one active P86 user, so it was left blank.');
  }
  const conf = Number(bt.confidence);
  const val = (v) => (match.isBtBlank(v) ? null : norm(v));
  const id = genId('lead_');
  await db.query(
    'INSERT INTO leads (id, created_by, organization_id, title, status, street_address, city, state, zip, source, confidence, client_id, salesperson_id, bt_lead_id) '
    + 'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
    [id, user && user.id != null ? user.id : null, orgId, norm(bt.title), 'new', val(bt.street), val(bt.city), val(bt.state), val(bt.zip),
      val(bt.source), Number.isFinite(conf) && conf > 0 ? Math.max(0, Math.min(100, Math.round(conf))) : null, clientId, salespersonId, btId]);
  return { created: id, notes, regeocode: val(bt.street) || val(bt.city) ? id : null };
}

function p86JobStatus(btStatus) {
  const s = match.btJobState(btStatus);
  if (s === 'closed') return 'Completed';
  return 'In Progress';
}

async function createJob(db, orgId, row, user) {
  const bt = row.bt;
  const btId = norm(bt.btId);
  const taken = await db.query('SELECT id FROM jobs WHERE organization_id = $1 AND bt_job_id = $2', [orgId, btId]);
  if (taken.rows.length) return { skipped: 'A P86 job is already linked to this Buildertrend job.' };
  const number = norm(bt.number);
  if (!number) return { skipped: 'This Buildertrend job has no job number, so it is not created.' };
  const clash = await db.query("SELECT id FROM jobs WHERE organization_id = $1 AND UPPER(TRIM(data->>'jobNumber')) = UPPER($2)", [orgId, number]);
  if (clash.rows.length) return { skipped: 'P86 already has a job numbered ' + number + '.' };

  const notes = [];
  const org = await db.query('SELECT branding FROM organizations WHERE id = $1', [orgId]);
  const branding = (org.rows[0] && org.rows[0].branding) || {};
  const types = jobTypes.normJobTypes(Array.isArray(branding.job_types) ? branding.job_types : []);
  const registry = types.length ? types : jobTypes.defaultJobTypes();
  const prefix = (number.match(/^[A-Za-z]+/) || [''])[0].toUpperCase();
  const type = registry.find((t) => t.prefix === prefix);
  if (!type) notes.push('Job number prefix "' + (prefix || 'none') + '" is not in P86\'s job numbering list, so the job type is blank.');

  const client = await clientIdForContact(db, orgId, bt.contactIds);
  if (!client && (bt.contactIds || []).length) notes.push('The Buildertrend client is not linked to a P86 client yet — link it on the Clients tab.');
  const val = (v) => (match.isBtBlank(v) ? '' : norm(v));
  const start = match.dateKey(bt.projectedStart);
  const now = new Date().toISOString();
  const data = {
    jobNumber: number,
    title: val(bt.title),
    client: client ? client.name : '',
    clientId: client ? client.id : null,
    pm: '',
    jobType: type ? type.label : '',
    status: p86JobStatus(bt.status),
    btStatus: val(bt.status),
    contractAmount: Number.isFinite(bt.contractValue) ? bt.contractValue : 0,
    estimatedCosts: 0,
    totalProductionDays: 0,
    startDate: start || '',
    endDate: '',
    street_address: val(bt.street), city: val(bt.city), state: val(bt.state), zip: val(bt.zip),
    notes: match.btJobState(bt.status) === 'warranty' ? 'Buildertrend status: Warranty.' : '',
    pctComplete: 0,
    invoicedToDate: 0,
    createdAt: now,
    updatedAt: now,
  };
  data.address = [data.street_address, data.city, data.state, data.zip].filter(Boolean).join(', ');
  const id = genId('job');
  data.id = id;
  await db.query('INSERT INTO jobs (id, owner_id, data, organization_id, bt_job_id, client_id) VALUES ($1, $2, $3::jsonb, $4, $5, $6)',
    [id, user && user.id != null ? user.id : null, JSON.stringify(data), orgId, btId, client ? client.id : null]);
  return { created: id, notes };
}

async function createRecords(org, kind, rows, input, deps) {
  let targets;
  if (input.btIds.length) {
    const wanted = new Set(input.btIds.map(norm));
    targets = rows.filter((r) => wanted.has(norm(r.bt.btId)));
  } else {
    // Bulk: jobs Open + Warranty only (owner's call); leads and clients all;
    // change orders and purchase orders all except those a job's old per-job
    // list blocks.
    targets = rows.filter((r) => r.class === 'new' && (kind !== 'jobs' || r.bt.scope === 'open') && !r.createBlocked);
  }
  const results = [];
  const regeocode = [];
  const seen = new Set(targets.map((r) => norm(r.bt.btId)));
  for (const id of input.btIds.map(norm)) {
    if (!seen.has(id)) results.push({ btId: id, outcome: 'skipped', reason: 'No Buildertrend record with that id in this read.' });
  }
  for (const row of targets) {
    const base = { btId: norm(row.bt.btId), label: row.bt.raw || row.bt.title || '' };
    if (row.class !== 'new') {
      results.push(Object.assign(base, { outcome: 'skipped', reason: 'Only a record Project 86 does not have is created; this one is ' + row.class.replace(/_/g, ' ') + '.' }));
      continue;
    }
    if (!norm(row.bt.btId)) {
      results.push(Object.assign(base, { outcome: 'skipped', reason: 'Buildertrend sent this record without an id, so it is not created.' }));
      continue;
    }
    let grantFor = null;
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      const r = kind === 'jobs' ? await createJob(client, org.id, row, deps.user)
        : kind === 'changeOrders' ? await createChangeOrder(client, org.id, row, deps.user)
        : kind === 'purchaseOrders' ? await createPurchaseOrder(client, org.id, row, deps.user)
        : kind === 'clients' ? await createClient(client, org.id, row)
        : await createLead(client, org.id, row, deps.user);
      await client.query('COMMIT');
      if (r.skipped) results.push(Object.assign(base, { outcome: 'skipped', reason: r.skipped }));
      else {
        results.push(Object.assign(base, { outcome: 'created', p86Id: r.created, notes: r.notes || [] }));
        if (r.regeocode) regeocode.push(r.regeocode);
        if (kind === 'purchaseOrders') grantFor = base;
      }
    } catch (e) {
      grantFor = null;
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      results.push(Object.assign(base, { outcome: 'failed', reason: 'The create failed inside this server; nothing was written for this record.' }));
    } finally {
      client.release();
    }
    // Committed and released: the created PO's sub gets access if it is active.
    if (grantFor && await grantPoSubAccessAfterCommit(deps.pool, org.id, grantFor.p86Id, deps.user)) grantFor.subAccess = true;
  }
  const counts = { created: 0, skipped: 0, failed: 0 };
  for (const r of results) {
    counts[r.outcome] = (counts[r.outcome] || 0) + 1;
    if (r.subAccess) counts.subAccess = (counts.subAccess || 0) + 1;
  }
  if (preview.forgetFetch) preview.forgetFetch(org.id);
  return { status: 200, body: { dataset: kind, mode: 'create', counts, results }, regeocode };
}

// ── LINK: a person picks the P86 record for an ambiguous row ─────────────────
//
// The matcher could not choose between candidates; the admin can. The chosen
// P86 record must be one the matcher listed for THIS Buildertrend row (a
// candidate, a possible duplicate, or a record it considered), must belong to
// this organization, and neither side may already be linked elsewhere. Only the
// Buildertrend id is written; the next read matches the pair by id and shows its
// corrections like any other linked row.
const LINK_TABLE = { jobs: ['jobs', 'bt_job_id'], leads: ['leads', 'bt_lead_id'], clients: ['clients', 'bt_contact_id'] };

async function linkRecord(org, kind, rows, input, deps) {
  const row = rows.find((r) => norm(r.bt.btId) === norm(input.btIds[0]));
  if (!row) return { status: 200, body: { dataset: kind, mode: 'link', counts: { linked: 0, skipped: 1 }, results: [{ btId: input.btIds[0], outcome: 'skipped', reason: 'No Buildertrend record with that id in this read.' }] } };
  const base = { btId: norm(row.bt.btId), label: row.bt.raw || row.bt.title || '', p86Id: input.p86Id };
  const listed = [].concat(row.candidates || [], row.p86Duplicates || [], row.considered || []).map((c) => String(c.id));
  const skip = (reason) => ({ status: 200, body: { dataset: kind, mode: 'link', counts: { linked: 0, skipped: 1 }, results: [Object.assign(base, { outcome: 'skipped', reason })] } });
  if (row.class === 'matched' || row.class === 'conflict') return skip('This Buildertrend record already has a confident P86 match.');
  if (listed.indexOf(String(input.p86Id)) === -1) return skip('That P86 record is not one of the candidates listed for this Buildertrend record.');
  if (kind === 'changeOrders' || kind === 'purchaseOrders') return linkDetail(kind, org, row, input, deps, base, skip);
  const [table, col] = LINK_TABLE[kind];
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT id, ' + col + ' AS bt FROM ' + table + ' WHERE id = $1 AND organization_id = $2 FOR UPDATE', [input.p86Id, org.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return skip('That P86 record is not in this organization.'); }
    if (norm(cur.rows[0].bt) && norm(cur.rows[0].bt) !== base.btId) { await client.query('ROLLBACK'); return skip('That P86 record is already linked to a different Buildertrend record.'); }
    const taken = await client.query('SELECT id FROM ' + table + ' WHERE organization_id = $1 AND ' + col + ' = $2 AND id <> $3', [org.id, base.btId, input.p86Id]);
    if (taken.rows.length) { await client.query('ROLLBACK'); return skip('Another P86 record is already linked to this Buildertrend record.'); }
    await client.query('UPDATE ' + table + ' SET ' + col + ' = $1 WHERE id = $2 AND organization_id = $3', [base.btId, input.p86Id, org.id]);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    return { status: 200, body: { dataset: kind, mode: 'link', counts: { linked: 0, failed: 1 }, results: [Object.assign(base, { outcome: 'failed', reason: 'The link failed inside this server; nothing was written.' })] } };
  } finally {
    client.release();
  }
  if (preview.forgetFetch) preview.forgetFetch(org.id);
  return { status: 200, body: { dataset: kind, mode: 'link', counts: { linked: 1 }, results: [Object.assign(base, { outcome: 'linked', linked: true })] } };
}

// A change order or purchase order is linked only on the P86 job its
// Buildertrend job is linked to.
async function linkDetail(kind, org, row, input, deps, base, skip) {
  const co = kind === 'changeOrders';
  const noun = co ? 'change order' : 'purchase order';
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const rec = co ? await lockedChangeOrder(client, org.id, input.p86Id, norm(row.bt.jobId))
      : await lockedPurchaseOrder(client, org.id, input.p86Id, norm(row.bt.jobId));
    if (!rec || !row.job || rec.job_id !== row.job.id) { await client.query('ROLLBACK'); return skip('That P86 ' + noun + ' is not on the job linked to this Buildertrend job.'); }
    const current = norm(co ? rec.bt_co_id : rec.bt_po_id);
    if (current && current !== base.btId) { await client.query('ROLLBACK'); return skip('That P86 ' + noun + ' is already linked to a different Buildertrend ' + noun + '.'); }
    if (co ? await coLinkedElsewhere(client, org.id, base.btId, rec.id) : await poLinkedElsewhere(client, org.id, base.btId, rec.id)) {
      await client.query('ROLLBACK'); return skip('Another P86 ' + noun + ' is already linked to this Buildertrend ' + noun + '.');
    }
    if (co) await client.query('UPDATE job_change_orders SET bt_co_id = $1 WHERE id = $2 AND job_id IN (SELECT id FROM jobs WHERE organization_id = $3)', [base.btId, rec.id, org.id]);
    else await client.query('UPDATE job_purchase_orders SET bt_po_id = $1 WHERE id = $2 AND job_id IN (SELECT id FROM jobs WHERE organization_id = $3)', [base.btId, rec.id, org.id]);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    return { status: 200, body: { dataset: kind, mode: 'link', counts: { linked: 0, failed: 1 }, results: [Object.assign(base, { outcome: 'failed', reason: 'The link failed inside this server; nothing was written.' })] } };
  } finally {
    client.release();
  }
  // Committed and released: a linked PO that is already active with a sub of
  // this organization gets that sub access, as its next save on the PO page would.
  const linked = Object.assign(base, { outcome: 'linked', linked: true });
  if (!co && await grantPoSubAccessAfterCommit(deps.pool, org.id, input.p86Id, deps.user)) linked.subAccess = true;
  if (preview.forgetFetch) preview.forgetFetch(org.id);
  return { status: 200, body: { dataset: kind, mode: 'link', counts: Object.assign({ linked: 1 }, linked.subAccess ? { subAccess: 1 } : {}), results: [linked] } };
}

// ── the operation ────────────────────────────────────────────────────────
async function apply(org, input, deps) {
  const kind = input.dataset;
  const mode = input.mode;
  const fr = await readDataset(org, kind, deps);
  if (fr.error) return { status: 502, body: { error: 'Clickr could not be read, so nothing was applied. ' + (fr.error.message || '') } };
  if (fr.complete !== true) {
    return { status: 409, body: { error: 'The Buildertrend read was incomplete (' + fr.fetched + ' records), so nothing was applied. Refresh the preview and try again.' } };
  }
  const p86 = await preview.readP86(deps.pool, org.id);
  const values = fr.records.map((r) => readRecord(kind, r));
  const rows = preview.matchRows(kind, values, p86);

  if (mode === 'create') return createRecords(org, kind, rows, input, deps);
  if (mode === 'link') return linkRecord(org, kind, rows, input, deps);

  let targets;
  if (mode === 'safe') {
    targets = rows.filter((r) => CONFIDENT.has(r.class));
  } else {
    const wanted = new Set(input.btIds.map(norm));
    targets = rows.filter((r) => wanted.has(norm(r.bt.btId)));
  }
  const results = [];
  const seen = new Set(targets.map((r) => norm(r.bt.btId)));
  if (mode === 'rows') {
    for (const id of input.btIds.map(norm)) {
      if (!seen.has(id)) results.push({ btId: id, outcome: 'skipped', reason: 'No Buildertrend record with that id in this read.' });
    }
  }

  const regeocode = [];
  for (const row of targets) {
    const base = { btId: norm(row.bt.btId), label: row.bt.raw || row.bt.title || '', p86Id: row.p86 ? row.p86.id : null };
    if (!CONFIDENT.has(row.class) || !row.p86) {
      results.push(Object.assign(base, { outcome: 'skipped', reason: 'Not a confident match (' + row.class.replace(/_/g, ' ') + '), so nothing was applied.' }));
      continue;
    }
    if (!norm(row.bt.btId)) {
      results.push(Object.assign(base, { outcome: 'skipped', reason: 'Buildertrend sent this record without an id, so it cannot be linked.' }));
      continue;
    }
    let grantFor = null;
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      const r = kind === 'jobs' ? await applyJob(client, org.id, row, mode, input.fields)
        : kind === 'changeOrders' ? await applyChangeOrder(client, org.id, row, mode, input.fields)
        : kind === 'purchaseOrders' ? await applyPurchaseOrder(client, org.id, row, mode, input.fields)
        : kind === 'clients' ? await applyClient(client, org.id, row, mode, input.fields)
        : await applyLead(client, org.id, row, mode, input.fields);
      await client.query('COMMIT');
      if (r.skipped) results.push(Object.assign(base, { outcome: 'skipped', reason: r.skipped }));
      else if (r.unchanged) {
        results.push(Object.assign(base, { outcome: 'unchanged', stale: r.stale }));
        if (kind === 'purchaseOrders') grantFor = base;
      } else {
        results.push(Object.assign(base, { outcome: 'applied', linked: !!r.linked, fields: r.applied, stale: r.stale, contactLinked: !!r.contactLinked }));
        if (r.regeocode) regeocode.push(r.regeocode);
        if (kind === 'purchaseOrders') grantFor = base;
      }
    } catch (e) {
      grantFor = null;
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      results.push(Object.assign(base, { outcome: 'failed', reason: 'The write failed inside this server; nothing on this record was changed.' }));
    } finally {
      client.release();
    }
    // Committed and released: an applied or already-up-to-date PO whose final
    // state is active with a sub of this organization gets that sub access.
    if (grantFor && await grantPoSubAccessAfterCommit(deps.pool, org.id, grantFor.p86Id, deps.user)) grantFor.subAccess = true;
  }

  const counts = { applied: 0, unchanged: 0, skipped: 0, failed: 0, linked: 0, fields: 0 };
  for (const r of results) {
    counts[r.outcome]++;
    if (r.linked) counts.linked++;
    if (r.subAccess) counts.subAccess = (counts.subAccess || 0) + 1;
    counts.fields += (r.fields || []).length;
  }
  if (preview.forgetFetch) preview.forgetFetch(org.id);
  return { status: 200, body: { dataset: kind, mode, counts, results }, regeocode };
}

function parseInput(body) {
  const b = body || {};
  const dataset = b.dataset;
  if (DATASET_KINDS.indexOf(dataset) === -1) return { error: 'dataset must be "jobs", "leads", "clients", "changeOrders" or "purchaseOrders".' };
  if (b.mode === 'link') {
    const btId = (typeof b.btId === 'string' || typeof b.btId === 'number') ? String(b.btId).trim() : '';
    const p86Id = (typeof b.p86Id === 'string' || typeof b.p86Id === 'number') ? String(b.p86Id).trim() : '';
    if (!btId || !p86Id) return { error: 'btId and p86Id are required to link.' };
    return { dataset, mode: 'link', btIds: [btId], p86Id, fields: null };
  }
  if (b.mode === 'create') {
    const ids = Array.isArray(b.btIds) ? b.btIds.filter((x) => (typeof x === 'string' || typeof x === 'number') && norm(x)) : [];
    if (ids.length > MAX_ROWS) return { error: 'At most ' + MAX_ROWS + ' records per create.' };
    return { dataset, mode: 'create', btIds: ids.map(String), fields: null };
  }
  const mode = b.mode === 'safe' ? 'safe' : 'rows';
  if (mode === 'rows') {
    const ids = Array.isArray(b.btIds) ? b.btIds.filter((x) => (typeof x === 'string' || typeof x === 'number') && norm(x)) : [];
    if (!ids.length) return { error: 'btIds must list at least one Buildertrend id.' };
    if (ids.length > MAX_ROWS) return { error: 'At most ' + MAX_ROWS + ' records per apply.' };
    let fields = null;
    if (b.fields !== undefined) {
      if (!Array.isArray(b.fields) || b.fields.length > 30 || b.fields.some((x) => typeof x !== 'string' || !/^[A-Za-z]{1,40}$/.test(x))) {
        return { error: 'fields must be a list of field names.' };
      }
      fields = b.fields;
    }
    return { dataset, mode, btIds: ids.map(String), fields };
  }
  return { dataset, mode, btIds: [], fields: null };
}

let inFlight = false;

// ── archive-bucket operations: no Clickr read, one transaction each ─────────
const BUCKET_MODES = new Set(['merge', 'archive', 'restore', 'delete']);

function parseBucketInput(b) {
  const id = (v) => ((typeof v === 'string' || typeof v === 'number') ? String(v).trim() : '');
  if (b.mode === 'merge') {
    if (!id(b.survivorId) || !id(b.loserId)) return { error: 'survivorId and loserId are required to merge.' };
    return { dataset: b.dataset, mode: 'merge', survivorId: id(b.survivorId), loserId: id(b.loserId), btIds: [] };
  }
  if (!id(b.p86Id)) return { error: 'p86Id is required.' };
  return { dataset: b.dataset, mode: b.mode, p86Id: id(b.p86Id), btIds: [] };
}

async function runBucket(org, input, deps) {
  const client = await deps.pool.connect();
  const userId = deps.user && deps.user.id != null ? deps.user.id : null;
  try {
    await client.query('BEGIN');
    let r;
    if (input.mode === 'merge') r = await reconcile.mergeRecords(client, org.id, input.dataset, input.loserId, input.survivorId, userId);
    else if (input.mode === 'archive') r = await reconcile.archiveRecord(client, org.id, input.dataset, input.p86Id, userId);
    else if (input.mode === 'restore') r = await reconcile.restoreRecord(client, org.id, input.dataset, input.p86Id);
    else r = await reconcile.deleteArchived(client, org.id, input.dataset, input.p86Id);
    if (r.refused) {
      await client.query('ROLLBACK');
      return { status: 200, body: { dataset: input.dataset, mode: input.mode, counts: { skipped: 1 }, results: [{ outcome: 'skipped', reason: r.refused, attached: r.attached }] } };
    }
    await client.query('COMMIT');
    const outcome = input.mode === 'merge' ? 'merged' : input.mode === 'archive' ? 'archived' : input.mode === 'restore' ? 'restored' : 'deleted';
    const counts = {}; counts[outcome] = 1;
    return { status: 200, body: { dataset: input.dataset, mode: input.mode, counts, results: [Object.assign({ outcome }, r)] } };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('[clickr-reconcile] ' + input.mode + ' failed');
    return { status: 200, body: { dataset: input.dataset, mode: input.mode, counts: { failed: 1 }, results: [{ outcome: 'failed', reason: 'The ' + input.mode + ' failed inside this server; nothing was changed.' }] } };
  } finally {
    client.release();
    if (preview.forgetFetch) preview.forgetFetch(org.id);
  }
}

function ownerGate(req, res, env) {
  const org = req.organization;
  if (!org || org.id == null) { res.status(403).json({ error: 'Buildertrend reconcile needs an organization.' }); return null; }
  if (String(org.slug || '') !== preview.ownerSlug(env)) {
    res.status(403).json({ error: 'Buildertrend reconcile is not available for this organization. The Buildertrend connection on this server belongs to a different company.', code: 'CLICKR_NOT_THIS_ORG' });
    return null;
  }
  return org;
}

// GET /api/admin/organizations/me?view=buildertrend-archive (after ROLES_MANAGE).
async function handleArchiveList(req, res, deps) {
  const env = (deps && deps.env) || process.env;
  const org = ownerGate(req, res, env);
  if (!org) return;
  try {
    const rows = await reconcile.listArchive(deps.pool, org.id);
    res.set('Cache-Control', 'no-store');
    res.json({ archive: rows });
  } catch (e) {
    console.error('[clickr-reconcile] archive list failed');
    res.status(500).json({ error: 'The reconcile archive could not be read.' });
  }
}

// Called from PUT /api/admin/organizations/me AFTER requireAuth, requireOrg and
// requireCapability('ROLES_MANAGE') have passed.
async function handle(req, res, deps) {
  const env = (deps && deps.env) || process.env;
  const org = req.organization;
  if (!org || org.id == null) return res.status(403).json({ error: 'Buildertrend apply needs an organization.' });
  if (String(org.slug || '') !== preview.ownerSlug(env)) {
    return res.status(403).json({ error: 'Buildertrend apply is not available for this organization. The Buildertrend connection on this server belongs to a different company.', code: 'CLICKR_NOT_THIS_ORG' });
  }
  const body = req.body || {};
  if (BUCKET_MODES.has(body.mode)) {
    if (body.dataset !== 'jobs' && body.dataset !== 'leads' && body.dataset !== 'clients') return res.status(400).json({ error: 'dataset must be "jobs", "leads" or "clients".' });
    const bi = parseBucketInput(body);
    if (bi.error) return res.status(400).json({ error: bi.error });
    if (inFlight) return res.status(429).json({ error: 'A Buildertrend apply is already running on this server. Try again in a moment.', code: 'CLICKR_APPLY_BUSY' });
    inFlight = true;
    try {
      const out = await runBucket(org, bi, { pool: deps.pool, user: req.user });
      res.set('Cache-Control', 'no-store');
      res.status(out.status).json(out.body);
      const r0 = out.body.results[0] || {};
      if (['merged', 'archived', 'restored', 'deleted'].indexOf(r0.outcome) !== -1) {
        auditLog(req, {
          action: 'buildertrend.' + bi.mode,
          targetType: bi.dataset === 'jobs' ? 'job' : bi.dataset === 'clients' ? 'client' : 'lead',
          targetId: bi.mode === 'merge' ? bi.loserId : bi.p86Id,
          organizationId: org.id,
          detail: bi.mode === 'merge' ? { survivorId: bi.survivorId, loserId: bi.loserId, moved: r0.moved, kept: r0.kept } : { id: bi.p86Id },
        });
      }
    } finally {
      inFlight = false;
    }
    return;
  }
  const input = parseInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  if (inFlight) return res.status(429).json({ error: 'A Buildertrend apply is already running on this server. Try again in a moment.', code: 'CLICKR_APPLY_BUSY' });
  inFlight = true;
  try {
    const out = await apply(org, input, Object.assign({ env, user: req.user }, deps));
    res.set('Cache-Control', 'no-store');
    res.status(out.status).json(out.body);
    if (out.status === 200) {
      auditLog(req, {
        action: input.mode === 'create' ? 'buildertrend.create' : input.mode === 'link' ? 'buildertrend.link' : 'buildertrend.apply',
        targetType: input.dataset === 'jobs' ? 'job' : input.dataset === 'clients' ? 'client' : input.dataset === 'changeOrders' ? 'change_order' : input.dataset === 'purchaseOrders' ? 'purchase_order' : 'lead',
        targetId: input.mode === 'safe' ? 'safe updates' : input.mode === 'create' && !input.btIds.length ? 'bulk create' : String(input.btIds.length) + ' records',
        organizationId: org.id,
        detail: { mode: input.mode, counts: out.body.counts,
          // A PO whose sub was given portal access is listed whatever its outcome
          // (an unchanged PO included), so every grant names the PO it came from.
          applied: out.body.results.filter((r) => r.outcome === 'applied' || r.outcome === 'created' || r.outcome === 'linked' || r.subAccess).map((r) => ({ btId: r.btId, p86Id: r.p86Id, linked: r.linked, fields: r.fields, created: r.outcome === 'created', subAccess: !!r.subAccess })) },
      });
      for (const id of out.regeocode || []) geocodeLeadLater(deps.pool, id);
    }
  } catch (e) {
    console.error('[clickr-apply] apply failed');
    if (!res.headersSent) res.status(500).json({ error: 'The Buildertrend apply failed inside this server.' });
  } finally {
    inFlight = false;
  }
}

module.exports = { handle, handleArchiveList, apply, parseInput, writable, pickedHeldBack, p86JobStatus, ACTION_PARAM, grantPoSubAccessAfterCommit };
