// THE UNDO SPINE for the Buildertrend sync.
//
// Every other writer in Project 86 is a person pressing a thing they are
// looking at. An apply is not: it writes Buildertrend's answer onto a record
// nobody has open, and once the owner turns on an unattended run it will do
// that while he is asleep. So the rule here is that a sync write and the
// record of what it overwrote COMMIT TOGETHER. A change that landed without
// its journal row would be a change with no way back, which is the single
// outcome this module exists to prevent — that is why capture() takes the same
// `client` the write ran on, and why nothing in here opens a connection.
//
// It journals GENERICALLY, by reading the target row before and after and
// diffing it, rather than by trusting each applyX() to report what it touched.
// Sixteen apply/create functions each report their own `applied` field list,
// and a column one of them forgets to mention is exactly the column an undo
// would then fail to restore. The row itself cannot forget.
//
// WHAT AN UNDO IS ALLOWED TO DO
//   update  restore before_value, but ONLY while the column still holds what
//           the sync put there. A person who has since typed something else
//           wins: their value stays and the change is marked refused. This is
//           the same rule sync-apply's own personEdited() takes on tasks.
//   create  delete the row — and refuse if anything now points at it. A job
//           created by a sync that has since grown a change order is not a
//           mistake you can take back by deleting it, and cascading would
//           destroy the change order too.
'use strict';

// dataset -> the table its records live in. Kept here rather than imported so
// a new dataset has to be added on purpose: an unlisted one journals nothing,
// and journalled(kind) below is what makes that loud instead of silent.
const TABLE = {
  jobs: 'jobs',
  leads: 'leads',
  clients: 'clients',
  changeOrders: 'job_change_orders',
  purchaseOrders: 'job_purchase_orders',
  bills: 'job_vendor_bills',
  estimates: 'estimates',
  tasks: 'tasks',
};

// Columns whose change is bookkeeping, not an answer. Restoring updated_at
// would be restoring a lie, and bt_synced_at is how sync-apply tells its own
// rows from a person's — putting the old one back would hand a task it had
// only just written back to the "a person wrote this" side of that test.
const NOISE = new Set(['updated_at', 'bt_synced_at']);

function journalled(kind) {
  return Object.prototype.hasOwnProperty.call(TABLE, kind);
}

function tableFor(kind) {
  if (!journalled(kind)) throw new Error('sync-journal: no table for dataset "' + kind + '"');
  return TABLE[kind];
}

// The row as JSON, or null when it is not there / not this organisation's.
// Org-scoped on the read as well as the write: a row of another organisation
// must not even be photographed.
async function snapshot(client, kind, orgId, id) {
  if (id == null || id === '') return null;
  const t = tableFor(kind);
  const r = await client.query(
    'SELECT * FROM ' + t + ' x WHERE x.id = $1 AND (x.organization_id = $2 OR x.organization_id IS NULL)',
    [String(id), orgId]);
  if (!r.rows.length) return null;
  // Built here rather than with to_jsonb(): the driver already hands back a
  // plain object, and to_jsonb does not translate on every engine this runs on.
  return Object.assign({}, r.rows[0]);
}

// A value that has been through the journal has been JSON.stringify'd, and a
// JSONB column comes back as an object on one driver and as a string on
// another. Both sides are reduced to one canonical text before comparing, or a
// column would read as changed purely because of how its driver hands it over.
// Stable: keys sorted at every depth. Two copies of the same blob can carry
// their keys in different orders — one came back through the driver, one went
// through JSON.stringify on the way into the journal — and comparing the raw
// text would read that as somebody having edited the record.
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

// What goes INTO a jsonb column. A column value arrives as an object on one
// driver and as JSON text on another; JSON.stringify would then encode the text
// one time too many, and the value would come back out wrapped in quotes on
// only one of them. This produces single-encoded JSON either way.
function jsonParam(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t && (t[0] === '{' || t[0] === '[')) {
      try { JSON.parse(t); return t; } catch (e) { /* not JSON after all */ }
    }
  }
  return JSON.stringify(v);
}

function canon(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t && (t[0] === '{' || t[0] === '[')) {
      try { return stable(JSON.parse(t)); } catch (e) { return v; }
    }
    return v;
  }
  return stable(v);
}

// The two sides are not the same kind of thing, so they are not reduced the
// same way. LIVE is a column value: text is text, unless it is a JSON object or
// array the driver handed over unparsed. STORED has been through a jsonb
// column, so it is JSON whatever it looks like — including the scalar '"111"',
// which is the text 111 and not the four characters around it.
function fromColumn(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t && (t[0] === '{' || t[0] === '[')) { try { return JSON.parse(t); } catch (e) { return v; } }
  return v;
}
function fromJsonb(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return v; }
}
function sameStored(live, stored) {
  const L = fromColumn(live);
  const S = fromJsonb(stored);
  if (L == null || S == null) return (L == null) === (S == null);
  return stable(L) === stable(S);
}

function sameValue(a, b) {
  if (a === b) return true;
  const ca = canon(a); const cb = canon(b);
  if (ca == null || cb == null) return ca === cb;
  return ca === cb;
}

// Every column that differs, ignoring the bookkeeping ones. Returns [] when
// the write changed nothing a person could see.
function diffColumns(before, after) {
  const out = [];
  const keys = new Set(Object.keys(before || {}).concat(Object.keys(after || {})));
  for (const k of keys) {
    if (NOISE.has(k)) continue;
    const b = before ? before[k] : null;
    const a = after ? after[k] : null;
    if (!sameValue(b, a)) out.push({ column: k, before: b === undefined ? null : b, after: a === undefined ? null : a });
  }
  return out.sort((x, y) => (x.column < y.column ? -1 : x.column > y.column ? 1 : 0));
}

let _seq = 0;
function changeId() {
  _seq = (_seq + 1) % 1000000;
  return 'btchg_' + Date.now().toString(36) + '_' + _seq.toString(36) + Math.random().toString(36).slice(2, 6);
}

async function startRun(client, orgId, opts) {
  const id = 'btrun_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  await client.query(
    'INSERT INTO bt_sync_runs (id, organization_id, trigger, dataset, mode, actor_user_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, orgId, (opts && opts.trigger) || 'press', (opts && opts.dataset) || null,
      (opts && opts.mode) || null, opts && opts.userId != null ? opts.userId : null]);
  return id;
}

async function finishRun(client, orgId, runId, counts) {
  await client.query(
    'UPDATE bt_sync_runs SET finished_at = NOW(), counts = $1 WHERE id = $2 AND organization_id = $3',
    [JSON.stringify(counts || {}), runId, orgId]);
}

// A run that journalled nothing is noise on the page. Dropped, not kept empty.
async function dropEmptyRun(client, orgId, runId) {
  const r = await client.query('SELECT 1 FROM bt_sync_changes WHERE run_id = $1 LIMIT 1', [runId]);
  if (r.rows.length) return false;
  await client.query('DELETE FROM bt_sync_runs WHERE id = $1 AND organization_id = $2', [runId, orgId]);
  return true;
}

// ── capture ───────────────────────────────────────────────────────────────
// Called INSIDE the write's own transaction, after the write and before the
// COMMIT. `before` is what snapshot() returned before the write ran.
async function capture(client, ctx) {
  const { orgId, runId, kind, id, btId, before } = ctx;
  if (!runId || !journalled(kind) || id == null || id === '') return 0;
  const after = await snapshot(client, kind, orgId, id);
  const table = tableFor(kind);

  if (!before && after) {
    await client.query(
      'INSERT INTO bt_sync_changes (id, run_id, organization_id, dataset, target_table, target_id, bt_id, kind, column_name, before_value, after_value) '
      + "VALUES ($1, $2, $3, $4, $5, $6, $7, 'create', NULL, NULL, $8)",
      [changeId(), runId, orgId, kind, table, String(id), btId == null ? null : String(btId), jsonParam(after)]);
    return 1;
  }
  if (!after) return 0;               // the row went away; nothing to offer back

  const cols = diffColumns(before, after);
  for (const c of cols) {
    await client.query(
      'INSERT INTO bt_sync_changes (id, run_id, organization_id, dataset, target_table, target_id, bt_id, kind, column_name, before_value, after_value) '
      + "VALUES ($1, $2, $3, $4, $5, $6, $7, 'update', $8, $9, $10)",
      [changeId(), runId, orgId, kind, table, String(id), btId == null ? null : String(btId),
        c.column, jsonParam(c.before), jsonParam(c.after)]);
  }
  return cols.length;
}

// ── undo ──────────────────────────────────────────────────────────────────
// Every table that can hold a reference to a record a sync created. An undo of
// a create checks all of them and refuses if any still points at the row —
// deleting would take the referring record with it or strand it.
const REFERRERS = {
  jobs: [
    ['job_change_orders', 'job_id'], ['job_purchase_orders', 'job_id'], ['job_vendor_bills', 'job_id'],
    ['tasks', 'entity_id'], ['projects', 'job_id'], ['leads', 'job_id'],
  ],
  clients: [['leads', 'client_id'], ['projects', 'client_id'], ['jobs', 'client_id'], ['clients', 'parent_client_id']],
  // An estimate's lead is in its data, not a column: estimates has no lead_id.
  leads: [['estimates', "data->>'lead_id'"]],
  job_purchase_orders: [['job_vendor_bills', 'po_id']],
  job_change_orders: [],
  job_vendor_bills: [],
  estimates: [['jobs', 'estimate_id']],
  tasks: [],
};

async function blockedBy(client, orgId, table, id) {
  for (const [t, col] of REFERRERS[table] || []) {
    const r = await client.query(
      'SELECT 1 FROM ' + t + ' y WHERE y.' + col + ' = $1 LIMIT 1', [String(id)]);
    if (r.rows.length) return t;
  }
  return null;
}

// Undo ONE journalled change. Returns { ok } or { refused }.
async function undoChange(client, orgId, row, userId) {
  if (row.undone_at) return { refused: 'That change has already been taken back.' };

  if (row.kind === 'create') {
    const blocker = await blockedBy(client, orgId, row.target_table, row.target_id);
    if (blocker) {
      return { refused: 'This record was created by the sync and ' + blocker.replace(/_/g, ' ')
        + ' now points at it. Deleting it would take that with it, so it is left alone.' };
    }
    const d = await client.query(
      'DELETE FROM ' + row.target_table + ' WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [row.target_id, orgId]);
    if (!d.rowCount) return { refused: 'That record is no longer here to take back.' };
    return { ok: true, deleted: true };
  }

  // An update is put back only while the column still holds what the sync
  // wrote. Read under the row's own lock and compared here, because the
  // comparison has to treat a NULL the sync wrote as equal to the NULL that is
  // there now, and has to work on a JSON column as well as a scalar.
  const cur = await client.query(
    'SELECT ' + row.column_name + ' AS v FROM ' + row.target_table
    + ' WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) FOR UPDATE',
    [row.target_id, orgId]);
  if (!cur.rows.length) return { refused: 'That record is no longer here to take back.' };
  if (!sameStored(cur.rows[0].v == null ? null : cur.rows[0].v, row.after_value == null ? null : row.after_value)) {
    return { refused: 'Somebody has changed this since the sync wrote it, so their value is left alone.' };
  }
  // What goes back in is the value, not its JSON wrapper: a text column gets
  // 111, a blob column gets the blob.
  const back = row.before_value == null ? null : fromJsonb(row.before_value);
  const u = await client.query(
    'UPDATE ' + row.target_table + ' SET ' + row.column_name + ' = $1, updated_at = NOW() '
    + 'WHERE id = $2 AND (organization_id = $3 OR organization_id IS NULL)',
    [back !== null && typeof back === 'object' ? JSON.stringify(back) : back, row.target_id, orgId]);
  if (!u.rowCount) return { refused: 'That record is no longer here to take back.' };
  return { ok: true };
}

async function markUndone(client, id, userId, refused) {
  await client.query(
    'UPDATE bt_sync_changes SET undone_at = CASE WHEN $3::text IS NULL THEN NOW() ELSE undone_at END, '
    + 'undone_by = CASE WHEN $3::text IS NULL THEN $2 ELSE undone_by END, undo_refused = $3 WHERE id = $1',
    [id, userId == null ? null : userId, refused == null ? null : String(refused)]);
}

// ── the two doors ─────────────────────────────────────────────────────────
// GET  /me?view=buildertrend-history          the runs and what each changed
// PUT  /me?action=buildertrend-undo  { runId } or { changeId }
//
// Both are org-scoped on their own statements; neither trusts an id from the
// body to belong to the caller.

const MAX_RUNS = 25;

async function handleHistory(req, res, deps) {
  const orgId = req.user.organization_id;
  // ?summary=1: counts per run without every change — what the page polls while
  // a run is going. The changes list of a whole-sync run runs to thousands.
  const summary = !!(req.query && req.query.summary === '1');
  try {
    const runs = await deps.pool.query(
      'SELECT r.id, r.started_at, r.finished_at, r.trigger, r.dataset, r.mode, r.counts, r.undone_at, u.name AS actor '
      + 'FROM bt_sync_runs r LEFT JOIN users u ON u.id = r.actor_user_id AND u.organization_id = $1 '
      + 'WHERE r.organization_id = $1 ORDER BY r.started_at DESC LIMIT ' + MAX_RUNS, [orgId]);
    const ids = runs.rows.map((r) => r.id);
    let changes = { rows: [] };
    if (ids.length) {
      changes = await deps.pool.query(
        'SELECT id, run_id, dataset, target_table, target_id, bt_id, kind, column_name, undone_at, undo_refused '
        + 'FROM bt_sync_changes WHERE organization_id = $1 AND run_id = ANY($2) ORDER BY id', [orgId, ids]);
    }
    const byRun = new Map(ids.map((id) => [id, []]));
    for (const c of changes.rows) (byRun.get(c.run_id) || []).push(c);
    res.set('Cache-Control', 'no-store');
    // The run in flight on this server, if any, and the one before it. Only
    // for the organisation the Buildertrend connection belongs to: auto-sync
    // runs for no other, and another tenant has no business seeing it.
    let live = null;
    try {
      const preview = require('./sync-preview');
      if (req.organization && String(req.organization.slug || '') === preview.ownerSlug(process.env)) live = require('./auto-sync').status();
    } catch (e) { live = null; }
    res.json({
      readOnly: false,
      live,
      runs: runs.rows.map((r) => {
        const list = byRun.get(r.id) || [];
        return Object.assign({}, r, {
          changeCount: list.length,
          createdCount: list.filter((c) => c.kind === 'create').length,
          undoneCount: list.filter((c) => c.undone_at).length,
          refusedCount: list.filter((c) => c.undo_refused).length,
          records: [...new Set(list.map((c) => c.target_table + ':' + c.target_id))].length,
          changes: summary ? undefined : list,
        });
      }),
    });
  } catch (e) {
    console.error('GET buildertrend-history error:', e);
    res.status(500).json({ error: 'The sync history could not be read.' });
  }
}

// Undo a whole run, or one change of it. Newest change first, so a column
// written twice in one run lands back on the value it had before the run.
async function handleUndo(req, res, deps) {
  const orgId = req.user.organization_id;
  const body = req.body || {};
  const runId = body.runId == null ? null : String(body.runId);
  const oneChange = body.changeId == null ? null : String(body.changeId);
  if (!runId && !oneChange) return res.status(400).json({ error: 'Name the run or the change to take back.' });
  // Not while it is still writing: the undo would race the run it is undoing.
  try {
    const st = require('./auto-sync').status();
    if (runId && st.live && st.live.runId === runId) {
      return res.status(409).json({ error: 'That run is still going. Take it back once it has finished.' });
    }
  } catch (e) { /* no runner loaded: nothing is running */ }
  const userId = req.user && req.user.id != null ? req.user.id : null;

  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query(
      oneChange
        ? 'SELECT * FROM bt_sync_changes WHERE organization_id = $1 AND id = $2'
        : 'SELECT * FROM bt_sync_changes WHERE organization_id = $1 AND run_id = $2 ORDER BY id DESC',
      [orgId, oneChange || runId]);
    if (!rows.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nothing here to take back.' }); }

    const out = [];
    for (const row of rows.rows) {
      if (row.undone_at) { out.push({ id: row.id, skipped: 'already taken back' }); continue; }
      const r = await undoChange(client, orgId, row, userId);
      await markUndone(client, row.id, userId, r.refused || null);
      out.push(Object.assign({ id: row.id, target: row.target_table + ':' + row.target_id, column: row.column_name }, r));
    }
    if (runId && out.some((o) => o.ok)) {
      await client.query('UPDATE bt_sync_runs SET undone_at = NOW(), undone_by = $1 WHERE id = $2 AND organization_id = $3',
        [userId, runId, orgId]);
    }
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    res.json({ undone: out.filter((o) => o.ok).length, refused: out.filter((o) => o.refused).length, results: out });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('PUT buildertrend-undo error:', e);
    res.status(500).json({ error: 'The undo failed inside this server; nothing was changed.' });
  } finally {
    client.release();
  }
}

// The same three, taken on the pool. A scheduled run has no transaction of its
// own to hang them on, and must not borrow a record's: a record that rolls
// back would take the whole run's line with it.
async function onPool(pool, fn) {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}
function startRunOn(pool, orgId, meta) { return onPool(pool, (c) => startRun(c, orgId, meta)); }
function finishRunOn(pool, orgId, runId, counts) { return onPool(pool, (c) => finishRun(c, orgId, runId, counts)); }
function dropEmptyRunOn(pool, orgId, runId) { return onPool(pool, (c) => dropEmptyRun(c, orgId, runId)); }

module.exports = {
  TABLE, NOISE, journalled, tableFor, snapshot, diffColumns, canon, stable, sameValue, sameStored, fromColumn, fromJsonb, jsonParam,
  startRun, finishRun, dropEmptyRun, capture,
  startRunOn, finishRunOn, dropEmptyRunOn,
  REFERRERS, blockedBy, undoChange, markUndone,
  handleHistory, handleUndo, MAX_RUNS,
};
