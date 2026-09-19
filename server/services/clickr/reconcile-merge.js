'use strict';
// ── BUILDERTREND RECONCILE: MERGE, ARCHIVE, RESTORE, DELETE ────────────────
//
// Owner decisions (2026-09-13): P86 mirrors Buildertrend. A P86 DUPLICATE merges
// into the Buildertrend-linked record and the emptied copy goes to its own
// ARCHIVE bucket; a P86 record Buildertrend does not have can be archived too.
// The bucket is reviewed: RESTORE puts a record back, DELETE PERMANENTLY removes
// it — and only when nothing is attached to it any more.
//
// ARCHIVED means: jobs/leads/clients.bt_archived_at is set (with the reason, who,
// and for a merge the record it went into). Archived leads and clients are left
// out of their list routes and the map; an archived job also takes status
// "Archived", the status the job list already hides (its previous status is kept
// in data.btArchivedFromStatus for Restore). The Buildertrend preview never
// matches an archived record.
//
// MERGE moves every reference from the duplicate (loser) to the kept record
// (survivor) inside one transaction, per the registry below. A reference that
// cannot move because the survivor already has its one-per-record twin (a site
// plan graph, a sub assignment, a live room, a same-named folder handled by
// folding) stays on the archived copy and is reported — which is exactly what
// then blocks DELETE PERMANENTLY, so nothing is lost silently.
//
// Every statement is scoped to the caller's organization through the loser and
// survivor rows, which are both read `WHERE id = $1 AND organization_id = $2`.

const str = (v) => (v == null ? '' : String(v));
const norm = (v) => str(v).trim();

// Record types this module handles, and where polymorphic rows name them.
const KINDS = {
  jobs: { table: 'jobs', noun: 'job', entityType: 'job', btCol: 'bt_job_id' },
  leads: { table: 'leads', noun: 'lead', entityType: 'lead', btCol: 'bt_lead_id' },
  clients: { table: 'clients', noun: 'client', entityType: 'client', btCol: 'bt_contact_id' },
};

// Tables whose rows name a record by (entity_type, entity_id). Moved for every kind.
const POLYMORPHIC = ['attachments', 'tasks', 'reminders', 'calendar_events', 'compliance_items', 'receipts',
  'inbound_emails', 'plans', 'report_shares', 'job_reports', 'ai_sessions'];

// Plain id columns, per kind. { table, col }.
const PLAIN = {
  jobs: [
    { table: 'job_change_orders', col: 'job_id' }, { table: 'job_purchase_orders', col: 'job_id' },
    { table: 'job_vendor_bills', col: 'job_id' }, { table: 'job_workflow_items', col: 'job_id' },
    { table: 'pay_applications', col: 'job_id' }, { table: 'qb_cost_lines', col: 'job_id' },
    { table: 'schedule_entries', col: 'job_id' }, { table: 'job_reports', col: 'job_id' },
    { table: 'invoices', col: 'job_id' }, { table: 'projects', col: 'job_id' },
    { table: 'service_tickets', col: 'job_id' }, { table: 'leads', col: 'job_id' },
  ],
  leads: [
    { table: 'jobs', col: 'lead_id' }, { table: 'projects', col: 'lead_id' }, { table: 'service_tickets', col: 'lead_id' },
  ],
  clients: [
    { table: 'leads', col: 'client_id' }, { table: 'jobs', col: 'client_id' }, { table: 'clients', col: 'parent_client_id' },
    { table: 'invoices', col: 'client_id' }, { table: 'payments', col: 'client_id' }, { table: 'projects', col: 'client_id' },
  ],
};

// Columns that reference a record but deliberately are NOT moved, with why. The
// registry test fails when db.js grows a reference that is in neither list.
const NOT_MOVED = {
  'job_access.job_id': 'moved with conflict handling (moveUnique)',
  'job_subs.job_id': 'moved with conflict handling (moveUnique)',
  'node_graphs.job_id': 'one per job: moved only when the survivor has none',
  'lead_graphs.lead_id': 'one per lead: moved only when the survivor has none',
  'file_folders.entity_id': 'folded into same-named survivor folders (moveFolders)',
  'attachment_folder_grants.entity_id': 'moved with conflict handling (moveUnique)',
  'live_rooms.entity_id': 'one live room per record: moved only when the survivor has none',
  'ai_messages.entity_type': 'chat history rows carry no entity id to move',
  'org_folder_templates.entity_type': 'a template, not a reference to a record',
  'jobs.bt_job_id': 'the Buildertrend link itself',
  'leads.bt_lead_id': 'the Buildertrend link itself',
  'estimates.data': 'blob references moved in JS (lead_id, clientId)',
};

// Every table named here exists in server/db.js (test/reconcile-merge.test.js pins
// the registry to the schema). No probing query: inside a Postgres transaction a
// failed statement aborts the whole merge.

async function readRecord(db, kind, id, orgId) {
  const k = KINDS[kind];
  const r = await db.query('SELECT * FROM ' + k.table + ' WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, orgId]);
  return r.rows[0] || null;
}

function label(kind, row) {
  if (!row) return '';
  if (kind === 'jobs') {
    const d = parseData(row.data);
    return [d.jobNumber, d.title || d.name].filter(Boolean).join(' ') || row.id;
  }
  if (kind === 'leads') return row.title || row.id;
  return row.name || row.id;
}

function parseData(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || '{}') || {}; } catch (e) { return {}; }
}

// Crew-side data a job merge must never guess at.
function jobCrewData(data) {
  const d = parseData(data);
  const has = (x) => Array.isArray(x) ? x.length > 0 : !!(x && typeof x === 'object' && Object.keys(x).length);
  const found = [];
  if (has(d.buildings)) found.push('buildings');
  if (has(d.phases)) found.push('scopes / phase allocation');
  if (has(d.workbook)) found.push('a workbook');
  return found;
}

async function count(db, sql, params) {
  const r = await db.query(sql, params);
  return Number((r.rows[0] && (r.rows[0].n != null ? r.rows[0].n : Object.values(r.rows[0])[0])) || 0);
}

// ── references still attached to a record (what blocks a permanent delete) ──
async function attachedCounts(db, kind, id, orgId) {
  const k = KINDS[kind];
  const out = {};
  for (const ref of PLAIN[kind]) {
    const n = await count(db, 'SELECT COUNT(*) AS n FROM ' + ref.table + ' WHERE ' + ref.col + ' = $1', [id]);
    if (n) out[ref.table + '.' + ref.col] = n;
  }
  for (const t of POLYMORPHIC.concat(['file_folders', 'attachment_folder_grants', 'live_rooms'])) {
    const n = await count(db, 'SELECT COUNT(*) AS n FROM ' + t + ' WHERE entity_type = $1 AND entity_id = $2', [k.entityType, id]);
    if (n) out[t] = n;
  }
  const one = kind === 'jobs' ? [['job_access', 'job_id'], ['job_subs', 'job_id'], ['node_graphs', 'job_id']]
    : kind === 'leads' ? [['lead_graphs', 'lead_id']] : [];
  for (const [t, c] of one) {
    const n = await count(db, 'SELECT COUNT(*) AS n FROM ' + t + ' WHERE ' + c + ' = $1', [id]);
    if (n) out[t] = n;
  }
  if (kind === 'leads' || kind === 'clients') {
    const key = kind === 'leads' ? 'lead_id' : 'clientId';
    const est = await db.query('SELECT id, data FROM estimates WHERE organization_id = $1', [orgId]);
    const n = est.rows.filter((e) => norm(parseData(e.data)[key]) === norm(id)).length;
    if (n) out['estimates.data.' + key] = n;
  }
  if (kind === 'clients') {
    const jobs = await db.query('SELECT id, data FROM jobs WHERE organization_id = $1', [orgId]);
    const n = jobs.rows.filter((j) => { const d = parseData(j.data); return norm(d.clientId) === norm(id) || norm(d.client_id) === norm(id); }).length;
    if (n) out['jobs.data.clientId'] = n;
  }
  if (kind === 'jobs') {
    const crew = jobCrewData((await db.query('SELECT data FROM jobs WHERE id = $1 AND organization_id = $2', [id, orgId])).rows[0]?.data);
    if (crew.length) out['job crew data (' + crew.join(', ') + ')'] = 1;
  }
  return out;
}

// ── moving references ──────────────────────────────────────────────────────
async function movePlain(db, kind, loserId, survivorId, moved) {
  for (const ref of PLAIN[kind]) {
    if (ref.table === 'clients' && ref.col === 'parent_client_id') {
      // A property under the duplicate moves under the survivor — never under itself.
      const r = await db.query('UPDATE clients SET parent_client_id = $1 WHERE parent_client_id = $2 AND id <> $1', [survivorId, loserId]);
      if (r.rowCount) moved[ref.table + '.' + ref.col] = r.rowCount;
      continue;
    }
    const r = await db.query('UPDATE ' + ref.table + ' SET ' + ref.col + ' = $1 WHERE ' + ref.col + ' = $2', [survivorId, loserId]);
    if (r.rowCount) moved[ref.table + '.' + ref.col] = r.rowCount;
  }
}

async function movePolymorphic(db, entityType, loserId, survivorId, moved) {
  for (const t of POLYMORPHIC) {
    const r = await db.query('UPDATE ' + t + ' SET entity_id = $1 WHERE entity_type = $2 AND entity_id = $3', [survivorId, entityType, loserId]);
    if (r.rowCount) moved[t] = (moved[t] || 0) + r.rowCount;
  }
}

// Rows under a UNIQUE key that includes the record id: move the ones that do not
// clash; a clashing row is the same fact the survivor already has, and stays on
// the archived copy (reported). spec = { idCol, filter: {col: value}, keyCols: [] }.
async function moveUnique(db, table, spec, loserId, survivorId, moved, kept) {
  const fcols = Object.keys(spec.filter || {});
  const fvals = fcols.map((c) => spec.filter[c]);
  const cond = (cols, start) => cols.map((c, i) => ' AND ' + c + ' = $' + (start + i)).join('');
  const rows = await db.query('SELECT * FROM ' + table + ' WHERE ' + spec.idCol + ' = $1' + cond(fcols, 2), [loserId].concat(fvals));
  let n = 0;
  let k = 0;
  for (const row of rows.rows) {
    const kvals = spec.keyCols.map((c) => row[c]);
    const clash = await db.query('SELECT 1 FROM ' + table + ' WHERE ' + spec.idCol + ' = $1' + cond(fcols, 2) + cond(spec.keyCols, 2 + fcols.length),
      [survivorId].concat(fvals, kvals));
    if (clash.rows.length) { k++; continue; }
    await db.query('UPDATE ' + table + ' SET ' + spec.idCol + ' = $1 WHERE ' + spec.idCol + ' = $2' + cond(fcols, 3) + cond(spec.keyCols, 3 + fcols.length),
      [survivorId, loserId].concat(fvals, kvals));
    n++;
  }
  if (n) moved[table] = (moved[table] || 0) + n;
  if (k) kept[table] = (kept[table] || 0) + k;
}

// One-per-record rows: move only when the survivor has none.
async function moveOne(db, table, idCol, loserId, survivorId, moved, kept, extraWhere) {
  const where = extraWhere ? ' AND ' + extraWhere : '';
  const has = await db.query('SELECT 1 FROM ' + table + ' WHERE ' + idCol + ' = $1' + where, [survivorId]);
  const mine = await count(db, 'SELECT COUNT(*) AS n FROM ' + table + ' WHERE ' + idCol + ' = $1' + where, [loserId]);
  if (!mine) return;
  if (has.rows.length) { kept[table] = (kept[table] || 0) + mine; return; }
  const r = await db.query('UPDATE ' + table + ' SET ' + idCol + ' = $1 WHERE ' + idCol + ' = $2' + where, [survivorId, loserId]);
  if (r.rowCount) moved[table] = (moved[table] || 0) + r.rowCount;
}

// File folders: a loser folder whose (parent, name) the survivor already has is
// FOLDED into it (its files and subfolders move into the survivor's folder, then
// the empty folder is removed); every other folder simply moves.
async function moveFolders(db, entityType, loserId, survivorId, moved) {
  let guard = 0;
  while (guard++ < 50) {
    const folders = (await db.query('SELECT * FROM file_folders WHERE entity_type = $1 AND entity_id = $2', [entityType, loserId])).rows;
    if (!folders.length) break;
    // Top-down: a folder whose parent is not itself a loser folder.
    const loserIds = new Set(folders.map((f) => f.id));
    const f = folders.find((x) => !x.parent_id || !loserIds.has(x.parent_id));
    if (!f) break;
    const twin = (await db.query(
      "SELECT id FROM file_folders WHERE entity_type = $1 AND entity_id = $2 AND COALESCE(parent_id, '') = COALESCE($3, '') AND LOWER(name) = LOWER($4)",
      [entityType, survivorId, f.parent_id || null, f.name])).rows[0];
    if (twin) {
      await db.query('UPDATE attachments SET folder_id = $1 WHERE folder_id = $2', [twin.id, f.id]);
      await db.query('UPDATE file_folders SET parent_id = $1 WHERE parent_id = $2', [twin.id, f.id]);
      // attachment_folder_grants.folder_id is ON DELETE CASCADE, not SET NULL like
      // attachments.folder_id above. Without this the DELETE takes the sub's whole
      // GRANT ROW with it and the sub silently loses the files that were just
      // moved into the twin. Repoint before the DELETE. (Same fix, same reason, as
      // services/client-merge.js.) The `folder` string is left alone on purpose:
      // it is part of UNIQUE (sub_id, entity_type, entity_id, folder) and the
      // portal matches folder OR folder_id, so the id alone restores access.
      await db.query('UPDATE attachment_folder_grants SET folder_id = $1 WHERE folder_id = $2', [twin.id, f.id]);
      await db.query('DELETE FROM file_folders WHERE id = $1', [f.id]);
      moved.file_folders_folded = (moved.file_folders_folded || 0) + 1;
    } else {
      await db.query('UPDATE file_folders SET entity_id = $1 WHERE id = $2', [survivorId, f.id]);
      moved.file_folders = (moved.file_folders || 0) + 1;
    }
  }
}

async function moveBlobs(db, kind, loserId, survivor, orgId, moved) {
  const survivorId = survivor.id;
  if (kind === 'leads' || kind === 'clients') {
    const key = kind === 'leads' ? 'lead_id' : 'clientId';
    const est = await db.query('SELECT id, data FROM estimates WHERE organization_id = $1', [orgId]);
    let n = 0;
    for (const e of est.rows) {
      const d = parseData(e.data);
      if (norm(d[key]) !== norm(loserId)) continue;
      d[key] = survivorId;
      if (kind === 'clients' && d.client !== undefined) d.client = survivor.name;
      await db.query('UPDATE estimates SET data = $1::jsonb, updated_at = NOW() WHERE id = $2 AND organization_id = $3', [JSON.stringify(d), e.id, orgId]);
      n++;
    }
    if (n) moved['estimates.data.' + key] = n;
  }
  if (kind === 'clients') {
    const jobs = await db.query('SELECT id, data FROM jobs WHERE organization_id = $1', [orgId]);
    let n = 0;
    for (const j of jobs.rows) {
      const d = parseData(j.data);
      if (norm(d.clientId) !== norm(loserId) && norm(d.client_id) !== norm(loserId)) continue;
      if (norm(d.clientId) === norm(loserId)) d.clientId = survivorId;
      if (norm(d.client_id) === norm(loserId)) d.client_id = survivorId;
      d.client = survivor.name;
      await db.query('UPDATE jobs SET data = $1::jsonb, updated_at = NOW() WHERE id = $2 AND organization_id = $3', [JSON.stringify(d), j.id, orgId]);
      n++;
    }
    if (n) moved['jobs.data.clientId'] = n;
  }
}

async function archiveRow(db, kind, row, orgId, reason, mergedInto, userId) {
  const k = KINDS[kind];
  if (kind === 'jobs') {
    const d = parseData(row.data);
    if (d.status !== 'Archived') d.btArchivedFromStatus = d.status || '';
    d.status = 'Archived';
    await db.query('UPDATE jobs SET data = $1::jsonb, bt_archived_at = NOW(), bt_archive_reason = $2, bt_merged_into = $3, bt_archived_by = $4, updated_at = NOW() WHERE id = $5 AND organization_id = $6',
      [JSON.stringify(d), reason, mergedInto, userId, row.id, orgId]);
    return;
  }
  await db.query('UPDATE ' + k.table + ' SET bt_archived_at = NOW(), bt_archive_reason = $1, bt_merged_into = $2, bt_archived_by = $3, updated_at = NOW() WHERE id = $4 AND organization_id = $5',
    [reason, mergedInto, userId, row.id, orgId]);
}

// ── operations (each runs inside the caller's transaction) ──────────────────
async function mergeRecords(db, orgId, kind, loserId, survivorId, userId) {
  const k = KINDS[kind];
  if (!k) return { refused: 'Unknown record type.' };
  if (norm(loserId) === norm(survivorId)) return { refused: 'A record cannot be merged into itself.' };
  const survivor = await readRecord(db, kind, survivorId, orgId);
  const loser = await readRecord(db, kind, loserId, orgId);
  if (!survivor || !loser) return { refused: 'Both records must be ' + k.noun + 's of this organization.' };
  if (survivor.bt_archived_at) return { refused: 'The record to keep is archived. Restore it first.' };
  if (loser.bt_archived_at) return { refused: 'That ' + k.noun + ' is already archived.' };
  if (!norm(survivor[k.btCol])) return { refused: 'Merge keeps the Buildertrend-linked record: link this one first.' };
  if (norm(loser[k.btCol])) return { refused: 'That ' + k.noun + ' is linked to a Buildertrend record of its own, so it is not a duplicate to merge away.' };
  if (kind === 'jobs') {
    const crew = jobCrewData(loser.data);
    const graph = await count(db, 'SELECT COUNT(*) AS n FROM node_graphs WHERE job_id = $1', [loserId]);
    const survivorGraph = graph && (await count(db, 'SELECT COUNT(*) AS n FROM node_graphs WHERE job_id = $1', [survivorId]));
    if (crew.length || survivorGraph) {
      return { refused: 'The duplicate job carries ' + (crew.length ? crew.join(', ') : 'a site plan') + ', which cannot be combined automatically with the kept job. Move it by hand, then merge.' };
    }
  }

  const moved = {};
  const kept = {};
  await movePlain(db, kind, loserId, survivorId, moved);
  await movePolymorphic(db, k.entityType, loserId, survivorId, moved);
  await moveFolders(db, k.entityType, loserId, survivorId, moved);
  await moveUnique(db, 'attachment_folder_grants', { idCol: 'entity_id', filter: { entity_type: k.entityType }, keyCols: ['sub_id', 'folder'] }, loserId, survivorId, moved, kept);
  await moveOne(db, 'live_rooms', 'entity_id', loserId, survivorId, moved, kept, "entity_type = '" + k.entityType + "'");
  if (kind === 'jobs') {
    await moveUnique(db, 'job_access', { idCol: 'job_id', keyCols: ['user_id'] }, loserId, survivorId, moved, kept);
    await moveUnique(db, 'job_subs', { idCol: 'job_id', keyCols: ['sub_id'] }, loserId, survivorId, moved, kept);
    await moveOne(db, 'node_graphs', 'job_id', loserId, survivorId, moved, kept);
    // Lead / estimate links the survivor lacks come across.
    const sets = [];
    const vals = [];
    if (!survivor.lead_id && loser.lead_id) { sets.push('lead_id = $' + (vals.length + 1)); vals.push(loser.lead_id); }
    if (!survivor.estimate_id && loser.estimate_id) { sets.push('estimate_id = $' + (vals.length + 1)); vals.push(loser.estimate_id); }
    if (sets.length) {
      await db.query('UPDATE jobs SET lead_id = NULL, estimate_id = NULL WHERE id = $1 AND organization_id = $2', [loserId, orgId]);
      vals.push(survivorId, orgId);
      await db.query('UPDATE jobs SET ' + sets.join(', ') + ' WHERE id = $' + (vals.length - 1) + ' AND organization_id = $' + vals.length, vals);
      moved['jobs.lead_id / estimate_id'] = sets.length;
    }
  }
  if (kind === 'leads') {
    await moveOne(db, 'lead_graphs', 'lead_id', loserId, survivorId, moved, kept);
    if (!survivor.job_id && loser.job_id) {
      await db.query('UPDATE leads SET job_id = NULL WHERE id = $1 AND organization_id = $2', [loserId, orgId]);
      await db.query('UPDATE leads SET job_id = $1 WHERE id = $2 AND organization_id = $3', [loser.job_id, survivorId, orgId]);
      moved['leads.job_id'] = 1;
    }
  }
  await moveBlobs(db, kind, loserId, survivor, orgId, moved);
  const fresh = await readRecord(db, kind, loserId, orgId);
  await archiveRow(db, kind, fresh, orgId, 'merged', survivorId, userId);
  return { merged: true, loser: { id: loserId, label: label(kind, loser) }, survivor: { id: survivorId, label: label(kind, survivor) }, moved, kept };
}

async function archiveRecord(db, orgId, kind, id, userId) {
  const k = KINDS[kind];
  if (!k) return { refused: 'Unknown record type.' };
  if (kind === 'leads') {
    return { refused: 'Leads are not archived from here yet: Buildertrend\'s Leads dataset holds open leads only and carries no status, so a P86 lead missing from it may simply be sold or lost.' };
  }
  const row = await readRecord(db, kind, id, orgId);
  if (!row) return { refused: 'That ' + k.noun + ' is not in this organization.' };
  if (row.bt_archived_at) return { refused: 'That ' + k.noun + ' is already archived.' };
  if (norm(row[k.btCol])) return { refused: 'That ' + k.noun + ' is linked to Buildertrend, so it is not a P86-only record.' };
  await archiveRow(db, kind, row, orgId, 'not_in_buildertrend', null, userId);
  return { archived: true, record: { id, label: label(kind, row) } };
}

async function restoreRecord(db, orgId, kind, id) {
  const k = KINDS[kind];
  if (!k) return { refused: 'Unknown record type.' };
  const row = await readRecord(db, kind, id, orgId);
  if (!row) return { refused: 'That ' + k.noun + ' is not in this organization.' };
  if (!row.bt_archived_at) return { refused: 'That ' + k.noun + ' is not archived.' };
  if (kind === 'jobs') {
    const d = parseData(row.data);
    d.status = d.btArchivedFromStatus || 'In Progress';
    delete d.btArchivedFromStatus;
    await db.query('UPDATE jobs SET data = $1::jsonb, bt_archived_at = NULL, bt_archive_reason = NULL, bt_merged_into = NULL, bt_archived_by = NULL, updated_at = NOW() WHERE id = $2 AND organization_id = $3',
      [JSON.stringify(d), id, orgId]);
  } else {
    await db.query('UPDATE ' + k.table + ' SET bt_archived_at = NULL, bt_archive_reason = NULL, bt_merged_into = NULL, bt_archived_by = NULL, updated_at = NOW() WHERE id = $1 AND organization_id = $2', [id, orgId]);
  }
  return { restored: true, record: { id, label: label(kind, row) }, note: row.bt_merged_into ? 'What was merged into the other record stays there.' : '' };
}

async function deleteArchived(db, orgId, kind, id) {
  const k = KINDS[kind];
  if (!k) return { refused: 'Unknown record type.' };
  const row = await readRecord(db, kind, id, orgId);
  if (!row) return { refused: 'That ' + k.noun + ' is not in this organization.' };
  if (!row.bt_archived_at) return { refused: 'Only an archived ' + k.noun + ' can be deleted from the archive.' };
  const attached = await attachedCounts(db, kind, id, orgId);
  const keys = Object.keys(attached);
  if (keys.length) {
    return { refused: 'Still attached: ' + keys.map((x) => x + ' (' + attached[x] + ')').join(', ') + '. Merge or move those first; nothing was deleted.', attached };
  }
  await db.query('DELETE FROM ' + k.table + ' WHERE id = $1 AND organization_id = $2 AND bt_archived_at IS NOT NULL', [id, orgId]);
  return { deleted: true, record: { id, label: label(kind, row) } };
}

async function listArchive(db, orgId) {
  const out = [];
  for (const kind of Object.keys(KINDS)) {
    const k = KINDS[kind];
    const rows = await db.query('SELECT * FROM ' + k.table + ' WHERE organization_id = $1 AND bt_archived_at IS NOT NULL ORDER BY bt_archived_at DESC', [orgId]);
    for (const row of rows.rows) {
      let into = null;
      if (row.bt_merged_into) {
        const s = await db.query('SELECT * FROM ' + k.table + ' WHERE id = $1 AND organization_id = $2', [row.bt_merged_into, orgId]);
        into = { id: row.bt_merged_into, label: label(kind, s.rows[0]) || row.bt_merged_into };
      }
      const attached = await attachedCounts(db, kind, row.id, orgId);
      out.push({ kind, id: row.id, label: label(kind, row), reason: row.bt_archive_reason, mergedInto: into,
        archivedAt: row.bt_archived_at, archivedBy: row.bt_archived_by, attached, deletable: Object.keys(attached).length === 0 });
    }
  }
  return out;
}

module.exports = {
  KINDS, POLYMORPHIC, PLAIN, NOT_MOVED,
  mergeRecords, archiveRecord, restoreRecord, deleteArchived, listArchive, attachedCounts, jobCrewData,
};
