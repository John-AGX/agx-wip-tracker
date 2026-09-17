'use strict';
// ── BUILDERTREND: WHAT IS NEW OR CHANGED SINCE YOUR LAST REFRESH ─────────────
//
// The Buildertrend preview (sync-preview.js) marks, for the admin looking at
// it, which Buildertrend records are NEW or CHANGED since THAT admin's previous
// refresh. Two tables hold what that needs (server/db.js):
//
//   bt_record_snapshots  per organization, dataset and Buildertrend id: the
//                        last Buildertrend values read (`snapshot`), when the
//                        record was first and last seen, and — when its values
//                        last moved — when (`changed_at`) and from what
//                        (`prev_snapshot`). Shared by every admin of the org.
//   bt_preview_views     per organization and user: when that user last
//                        refreshed. Marks are relative to it, so one admin
//                        refreshing never hides another admin's marks.
//
// ── BUILDERTREND VALUES ONLY ──────────────────────────────────────────────
// A snapshot is built from readRecord() output — what Clickr sent — and never
// from Project 86. An Apply (sync-apply.js) changes P86, writes no snapshot and
// moves no marker, so a change made BY an apply can never read as "Changed in
// Buildertrend".
//
// ── ONLY A COMPLETE READ IS REMEMBERED ────────────────────────────────────
// A partial read would make every unread record look "gone" and every record
// read after it "new". The caller runs syncSnapshots() only for a dataset whose
// Clickr read was complete and classified; any other dataset is not touched.
//
// ── THE TENANT ────────────────────────────────────────────────────────────
// Every statement below carries organization_id = the caller's organization:
// the SELECT and the touch UPDATE as a predicate, the upserts as the first
// column of every row with the conflict target (organization_id, dataset,
// bt_id), and the marker upsert keyed on (organization_id, user_id).

const { parseMoney, fmtMoney, dateKey } = require('./bt-match');

const CHUNK = 200;

// [snapshot field, label, readRecord key, kind]. Only what a person would call
// "a change in Buildertrend": no bookkeeping dates, counts or ids.
const SNAPSHOT_FIELDS = {
  jobs: [
    ['name', 'Name', 'jobName', 'text'],
    ['status', 'Status', 'jobStatus', 'text'],
    ['street', 'Street', 'street', 'text'],
    ['city', 'City', 'city', 'text'],
    ['state', 'State', 'state', 'text'],
    ['zip', 'Zip', 'zip', 'text'],
    ['projectedStart', 'Projected start', 'projectedStart', 'day'],
    ['projectedCompletion', 'Projected completion', 'projectedCompletion', 'day'],
    ['contractPrice', 'Contract price', 'contractPrice', 'money'],
    ['approvedCOPrice', 'Approved change orders', 'approvedCOPrice', 'money'],
  ],
  leads: [
    ['title', 'Title', 'title', 'text'],
    ['street', 'Street', 'street', 'text'],
    ['city', 'City', 'city', 'text'],
    ['state', 'State', 'state', 'text'],
    ['zip', 'Zip', 'zip', 'text'],
    ['contactName', 'Contact', 'contactName', 'text'],
    ['salesperson', 'Salesperson', 'salesperson', 'text'],
    ['source', 'Source', 'source', 'text'],
    ['confidence', 'Confidence', 'confidence', 'text'],
    ['projectType', 'Project type', 'projectType', 'text'],
    ['estimatedRevenueMin', 'Estimated revenue (min)', 'estimatedRevenueMin', 'money'],
    ['estimatedRevenueMax', 'Estimated revenue (max)', 'estimatedRevenueMax', 'money'],
  ],
  clients: [
    ['name', 'Name', 'displayName', 'text'],
    ['email', 'Email', 'email', 'text'],
    ['phone', 'Phone', 'phone', 'text'],
    ['cell', 'Cell', 'cell', 'text'],
    ['street', 'Street', 'street', 'text'],
    ['city', 'City', 'city', 'text'],
    ['state', 'State', 'state', 'text'],
    ['zip', 'Zip', 'zip', 'text'],
  ],
  changeOrders: [
    ['coNumber', 'Number', 'coNumber', 'text'],
    ['title', 'Title', 'title', 'text'],
    ['job', 'Job', 'jobName', 'text'],
    ['status', 'Status', 'statusText', 'text'],
    ['cost', 'Cost', 'builderCost', 'money'],
    ['price', 'Price', 'totalPrice', 'money'],
  ],
  purchaseOrders: [
    ['poNumber', 'Number', 'poNumber', 'text'],
    ['title', 'Title', 'title', 'text'],
    ['job', 'Job', 'jobName', 'text'],
    ['status', 'Status', 'statusText', 'text'],
    ['workStatus', 'Work status', 'workStatusText', 'text'],
    ['paidStatus', 'Paid status', 'paidStatusText', 'text'],
    ['cost', 'Cost', 'cost', 'money'],
    ['amountPaid', 'Amount paid', 'amountPaid', 'money'],
    ['sub', 'Sub/vendor', 'subName', 'text'],
    ['estCompleteDate', 'Est. completion', 'estCompleteDate', 'day'],
  ],
};

const FIRST_TIME_NOTE = 'Buildertrend records are remembered from this refresh on — the next refresh marks what is new or changed.';
const PARTIAL_NOTE = 'Not compared with your last refresh: this Buildertrend read was not complete, so nothing here is marked new or changed and nothing was remembered.';

function normText(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

// A figure in dollars, 0 kept as 0; blank, a range or unreadable text is null.
function normMoney(v) {
  const m = parseMoney(v);
  if (m.kind === 'value') return m.value;
  if (m.kind === 'blank' && m.zero) return 0;
  return null;
}

function normDay(v) {
  const k = dateKey(v);
  return k || null;
}

const NORM = { text: normText, money: normMoney, day: normDay };

// readRecord(dataset, rec) -> flat object of normalized Buildertrend values.
function snapshotOf(dataset, values) {
  const out = {};
  for (const [field, , key, kind] of SNAPSHOT_FIELDS[dataset] || []) {
    out[field] = NORM[kind](values ? values[key] : null);
  }
  return out;
}

function parseJsonish(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
  return typeof v === 'object' ? v : null;
}

// TIMESTAMPTZ as pg hands it back (a Date) or as text; null when unreadable.
function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) && !/[zZ]|[+-]\d{2}(:?\d{2})?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  return isNaN(d.getTime()) ? null : d;
}

function display(kind, v) {
  if (v == null) return '';
  if (kind === 'money') return fmtMoney(Number(v));
  return String(v);
}

// Only fields BOTH snapshots carry are compared, so a field added to
// SNAPSHOT_FIELDS later does not read as a change on every record.
function diffSnapshots(prev, next, dataset) {
  const a = parseJsonish(prev) || {};
  const b = parseJsonish(next) || {};
  const out = [];
  for (const [field, label, , kind] of SNAPSHOT_FIELDS[dataset] || []) {
    if (!Object.prototype.hasOwnProperty.call(a, field) || !Object.prototype.hasOwnProperty.call(b, field)) continue;
    const x = a[field] == null ? null : a[field];
    const y = b[field] == null ? null : b[field];
    if (x === y) continue;
    out.push({ field, label, from: display(kind, x), to: display(kind, y) });
  }
  return out;
}

function sameSnapshot(prev, next, dataset) {
  return diffSnapshots(prev, next, dataset).length === 0
    && Object.keys(parseJsonish(prev) || {}).length === Object.keys(parseJsonish(next) || {}).length;
}

// A person's name for a record, from a snapshot.
function snapshotLabel(dataset, snap, btId) {
  const s = parseJsonish(snap) || {};
  let label = '';
  if (dataset === 'changeOrders') label = [s.coNumber, s.title].filter(Boolean).join(' ') + (s.job ? ' (' + s.job + ')' : '');
  else if (dataset === 'purchaseOrders') label = [s.poNumber, s.title].filter(Boolean).join(' ') + (s.job ? ' (' + s.job + ')' : '');
  else if (dataset === 'leads') label = s.title || '';
  else label = s.name || '';
  label = String(label).trim();
  return label || 'Buildertrend record ' + btId;
}

function chunks(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// records: [{ btId, snapshot }] from ONE complete read of `dataset`.
// Returns { marks: Map(btId -> { firstSeenAt, changedAt, prevSnapshot, snapshot,
// isFirstEverForDataset }), absent: [{ btId, snapshot, lastSeenAt }],
// earliestFirstSeenAt }. The writes run in one transaction when the pool can
// give a client: a half-written dataset would move changed_at on some rows
// while the page reported the comparison as unavailable.
async function syncSnapshots(pool, orgId, dataset, records, now) {
  const at = toDate(now) || new Date();
  const atIso = at.toISOString();
  const existing = await pool.query(
    'SELECT bt_id, snapshot, first_seen_at, last_seen_at, changed_at, prev_snapshot FROM bt_record_snapshots WHERE organization_id = $1 AND dataset = $2',
    [orgId, dataset]);
  const byId = new Map();
  let earliest = null;
  for (const r of existing.rows) {
    const id = String(r.bt_id);
    byId.set(id, r);
    const f = toDate(r.first_seen_at);
    if (f && (!earliest || f < earliest)) earliest = f;
  }
  const isFirstEverForDataset = byId.size === 0;

  const seen = new Set();
  const upserts = [];   // [btId, snapshotJson, changedAtIso|null, prevJson|null]
  const touches = [];
  const marks = new Map();
  for (const rec of records || []) {
    const btId = rec && rec.btId != null ? String(rec.btId).trim() : '';
    if (!btId || seen.has(btId)) continue;
    seen.add(btId);
    const snap = rec.snapshot || {};
    const old = byId.get(btId);
    if (!old) {
      upserts.push([btId, JSON.stringify(snap), null, null]);
      marks.set(btId, { firstSeenAt: at, changedAt: null, prevSnapshot: null, snapshot: snap, isFirstEverForDataset });
    } else {
      const oldSnap = parseJsonish(old.snapshot) || {};
      if (!sameSnapshot(oldSnap, snap, dataset)) {
        upserts.push([btId, JSON.stringify(snap), atIso, JSON.stringify(oldSnap)]);
        marks.set(btId, { firstSeenAt: toDate(old.first_seen_at), changedAt: at, prevSnapshot: oldSnap, snapshot: snap, isFirstEverForDataset });
      } else {
        touches.push(btId);
        marks.set(btId, { firstSeenAt: toDate(old.first_seen_at), changedAt: toDate(old.changed_at),
          prevSnapshot: parseJsonish(old.prev_snapshot), snapshot: snap, isFirstEverForDataset });
      }
    }
  }
  const absent = [];
  for (const [btId, r] of byId) {
    if (!seen.has(btId)) absent.push({ btId, snapshot: parseJsonish(r.snapshot) || {}, lastSeenAt: toDate(r.last_seen_at) });
  }

  const client = typeof pool.connect === 'function' ? await pool.connect() : null;
  const q = client || pool;
  try {
    if (client) await q.query('BEGIN');
    for (const part of chunks(upserts, CHUNK)) {
      const params = [orgId, dataset, atIso];
      const values = part.map((u) => {
        const b = params.length;
        params.push(u[0], u[1], u[2], u[3]);
        return '($1, $2, $' + (b + 1) + ', $' + (b + 2) + '::jsonb, $3::timestamptz, $3::timestamptz, $' + (b + 3) + '::timestamptz, $' + (b + 4) + '::jsonb)';
      });
      await q.query(
        'INSERT INTO bt_record_snapshots (organization_id, dataset, bt_id, snapshot, first_seen_at, last_seen_at, changed_at, prev_snapshot) VALUES '
        + values.join(', ')
        + ' ON CONFLICT (organization_id, dataset, bt_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, last_seen_at = EXCLUDED.last_seen_at, '
        + 'changed_at = EXCLUDED.changed_at, prev_snapshot = EXCLUDED.prev_snapshot', params);
    }
    for (const part of chunks(touches, CHUNK)) {
      const params = [atIso, orgId, dataset].concat(part);
      await q.query(
        'UPDATE bt_record_snapshots SET last_seen_at = $1::timestamptz WHERE organization_id = $2 AND dataset = $3 AND bt_id IN ('
        + part.map((_, i) => '$' + (i + 4)).join(', ') + ')', params);
    }
    if (client) await q.query('COMMIT');
  } catch (e) {
    if (client) { try { await q.query('ROLLBACK'); } catch (_) { /* already failed */ } }
    throw e;
  } finally {
    if (client && typeof client.release === 'function') client.release();
  }
  return { marks, absent, earliestFirstSeenAt: earliest, isFirstEverForDataset };
}

async function readLastRefresh(pool, orgId, userId) {
  const r = await pool.query('SELECT last_refresh_at FROM bt_preview_views WHERE organization_id = $1 AND user_id = $2', [orgId, userId]);
  return r.rows.length ? toDate(r.rows[0].last_refresh_at) : null;
}

async function writeLastRefresh(pool, orgId, userId, at) {
  const d = toDate(at) || new Date();
  await pool.query(
    'INSERT INTO bt_preview_views (organization_id, user_id, last_refresh_at) VALUES ($1, $2, $3::timestamptz) '
    + 'ON CONFLICT (organization_id, user_id) DO UPDATE SET last_refresh_at = EXCLUDED.last_refresh_at',
    [orgId, userId, d.toISOString()]);
}

// Attaches row.since and returns dataset.since for ONE complete dataset, from
// the result of syncSnapshots(). `previous` is this user's previous refresh
// (Date or null).
//   new     — first seen after the previous refresh;
//   changed — its Buildertrend values moved after the previous refresh;
//   removed — seen at or after the previous refresh, absent from this read.
// Nothing is marked when the user has no previous refresh, or when this
// dataset was not yet remembered at that refresh (every record would read as
// new).
const REMOVED_SHOWN = 50;
function markDataset(dataset, rows, synced, previous) {
  const previousRefreshAt = previous ? previous.toISOString() : null;
  const remembered = !!(previous && synced.earliestFirstSeenAt && synced.earliestFirstSeenAt <= previous);
  const since = { compared: remembered, previousRefreshAt, newCount: 0, changedCount: 0, removed: [], removedTotal: 0, note: null };
  if (!remembered) {
    since.firstTime = true;
    since.note = FIRST_TIME_NOTE;
    return since;
  }
  for (const row of rows || []) {
    const btId = row && row.bt && row.bt.btId != null ? String(row.bt.btId).trim() : '';
    const m = btId ? synced.marks.get(btId) : null;
    if (!m) continue;
    if (m.firstSeenAt && m.firstSeenAt > previous) {
      row.since = { state: 'new' };
      since.newCount++;
    } else if (m.changedAt && m.changedAt > previous && m.prevSnapshot) {
      const changes = diffSnapshots(m.prevSnapshot, m.snapshot, dataset);
      if (changes.length) {
        row.since = { state: 'changed', changedAt: m.changedAt.toISOString(), changes };
        since.changedCount++;
      }
    }
  }
  const gone = synced.absent
    .filter((a) => a.lastSeenAt && a.lastSeenAt >= previous)
    .map((a) => ({ btId: a.btId, label: snapshotLabel(dataset, a.snapshot, a.btId) }))
    .sort((x, y) => x.label.localeCompare(y.label));
  since.removedTotal = gone.length;
  since.removed = gone.slice(0, REMOVED_SHOWN);
  return since;
}

module.exports = {
  SNAPSHOT_FIELDS, FIRST_TIME_NOTE, PARTIAL_NOTE, CHUNK,
  snapshotOf, diffSnapshots, sameSnapshot, snapshotLabel, toDate,
  syncSnapshots, readLastRefresh, writeLastRefresh, markDataset,
};
