// Buildertrend to-dos -> P86 ORG TASKS (services/clickr/task-match.js,
// field-map.js, sync-preview.js, sync-apply.js, since-refresh.js).
//
// The promises this file exists to hold:
//   * isCompleted IS COMPLETION AND status IS NOT. The live dataset disagrees
//     with itself — isCompleted says 88 of 578 are done, status says 544 are
//     "Completed" — so the headline fixture disagrees the same way in BOTH
//     directions, and status never moves a P86 task either way;
//   * a task is matched only inside the P86 job its Buildertrend job is linked
//     to, by a saved bt_task_id or by the job plus the title. 578 records share
//     153 titles, so a title NEVER matches across jobs and two P86 tasks on one
//     job carrying it are REFUSED rather than guessed between;
//   * AN UNRESOLVABLE ASSIGNEE IMPORTS UNASSIGNED. Nobody, several, no match
//     and two matches each set NOBODY and say why; a user of another
//     organisation is never one of the candidates;
//   * A TASK A PERSON TOUCHED IS NOT REWRITTEN. A fill is an ordinary
//     correction; a replacement is a ticked held-back item, and only on a task
//     the sync itself wrote that nobody has edited since. Done and archived
//     take the link and nothing else. The DATABASE ROW is asserted unchanged
//     after the safe press and after an "apply everything" press that names no
//     fields;
//   * a created task is scope 'org', takes its organisation from its parent
//     JOB, and reaches that job through the polymorphic entity_type/entity_id
//     pair;
//   * a private To-do and a work-order building are never read, matched or
//     written, and neither is another organisation's task;
//   * describeMapping names a declared key no record carries and a carried key
//     nothing declares.
//
// Driven through the real express router, requireAuth / requireOrg /
// ROLES_MANAGE, a JWT, and the pg-sqlite engine derived from server/db.js.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema, tableNames } = require('./helpers/db-schema');

const engine = createPgSqlite(
  sqliteSchema(tableNames(), { pk: { organizations: 'id', users: 'id', roles: 'name', jobs: 'id', leads: 'id', clients: 'id', tasks: 'id' } }),
  { jsonColumns: ['data'] }
);

globalThis.__P86_CLICKR_TASK_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_CLICKR_TASK_ENGINE__.pool }));
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});
jest.mock('../server/geocoder', () => ({ geocodeAddress: async () => null, geocodeViaGoogle: async () => null, geocodeViaCensus: async () => null }));

const { DATASETS, readTask, describeMapping } = require('../server/services/clickr/field-map');
const preview = require('../server/services/clickr/sync-preview');
const taskMatch = require('../server/services/clickr/task-match');
const since = require('../server/services/clickr/since-refresh');
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const orgRoutes = require('../server/routes/admin-organizations-routes');

const KEY = 'ck_live_Zq9SECRETKEYxy7_0123456789ab';
const BASE = 'https://api.clickr.cloud';
const AGX = 1;
const OTHER = 2;

// Clickr's REST records carry NO _id: identity is taskId, and 64 jobs share 578
// of them. Every declared key is present on every fixture record, so a mapping
// diagnostic that reports anything is reporting a real drift.
function taskRec(id, jobId, title, o) {
  o = o || {};
  return Object.assign({
    accountId: 'a', integrationId: 'i', builderId: 'b',
    taskId: String(id), title,
    jobId: String(jobId), jobName: 'Job ' + jobId,
    // THE TWO FIELDS THAT DISAGREE. Defaulted apart on purpose: the live
    // dataset's ordinary record is isCompleted false under status "Completed",
    // so that is what an ordinary fixture record here is too.
    isCompleted: o.done === undefined ? false : o.done,
    status: o.status === undefined ? 'Completed' : o.status,
    completedAt: o.completedAt === undefined ? null : o.completedAt,
    dueDate: o.dueDate === undefined ? null : o.dueDate,
    assignedUsers: o.assigned === undefined ? [] : o.assigned,
    notes: o.notes === undefined ? null : o.notes,
    raw: { secret: 'never read' },
  }, o.extra || {});
}

const BT_TASKS = [
  // rung 1 (job + title). P86 holds nothing, so all three are FILLS.
  taskRec(8001, 111, 'Final walkthrough', { notes: 'Check the gutters', dueDate: '2026-04-10T00:00:00', assigned: ['Ana Ruiz'] }),
  // THE HEADLINE, DIRECTION ONE: Buildertrend's status says "Pending" and
  // isCompleted says DONE. isCompleted wins.
  taskRec(8002, 111, 'Pull permit', { done: true, status: 'Pending', completedAt: '2026-03-15T00:00:00' }),
  // THE HEADLINE, DIRECTION TWO: status says "Completed" and isCompleted says
  // NOT done. The P86 task stays open and nothing is proposed about completion.
  taskRec(8003, 111, 'Install flashing', { done: false, status: 'Completed' }),
  // Buildertrend only: the create target, finished, with everything on it.
  taskRec(8004, 111, 'Punch list walk', { done: true, status: 'Completed', completedAt: '2026-03-01T00:00:00',
    dueDate: '2026-02-28T00:00:00', assigned: ['Pat PM'], notes: 'Bring the ladder' }),
  // THE SAME TITLE AS 8001, ON A DIFFERENT JOB. Must never reach that task.
  taskRec(8005, 222, 'Final walkthrough', { notes: 'A different job entirely' }),
  // two P86 tasks on this job carry this title.
  taskRec(8006, 111, 'Order materials'),
  // its Buildertrend job is not linked to a P86 job.
  taskRec(8007, 333, 'Waiting on its job'),
  // an assignee who is not a P86 user at all.
  taskRec(8008, 111, 'Unknown assignee', { assigned: ['Nobody Here'] }),
  // an assignee two P86 users answer to.
  taskRec(8009, 111, 'Ambiguous assignee', { assigned: ['Mike Smith'] }),
  // SEVERAL people — the key is plural and a P86 task has exactly one assignee.
  taskRec(8010, 111, 'Shared assignee', { assigned: ['Ana Ruiz', 'Pat PM'] }),
  // an assignee who is a user of ANOTHER organisation.
  taskRec(8011, 111, 'Foreign assignee', { assigned: ['Dana Cruz'] }),
  // a P86 task a person ARCHIVED.
  taskRec(8012, 111, 'Archived in P86', { done: true, completedAt: '2026-03-02T00:00:00', notes: 'BT wants this text', dueDate: '2026-05-01T00:00:00' }),
  // a P86 task a person COMPLETED, which Buildertrend still has open.
  taskRec(8013, 111, 'Done in P86', { done: false, status: 'Pending' }),
  // a sync-written P86 task a PERSON has edited since.
  taskRec(8014, 111, 'Edited by a person', { notes: 'Buildertrend says this now', dueDate: '2026-06-01T00:00:00' }),
  // a sync-written P86 task NOBODY has edited since.
  taskRec(8015, 111, 'Only the sync wrote it', { notes: 'Buildertrend says this now', dueDate: '2026-06-02T00:00:00' }),
  // TWO Buildertrend tasks landing on ONE P86 task.
  taskRec(8016, 111, 'Claimed twice'),
  taskRec(8017, 111, 'Claimed twice'),
  // no title at all: a P86 task must have one.
  taskRec(8018, 111, null),
  // a PRIVATE To-do and a WORK-ORDER BUILDING carry these titles in P86. Both
  // must read as Buildertrend-only.
  taskRec(8019, 111, 'Private thing'),
  taskRec(8020, 111, 'Building A'),
  // finished in Buildertrend with NO completion date: P86 stamps its own.
  taskRec(8021, 222, 'Finished, undated', { done: true, status: 'Completed' }),
  // a completion flag that is NOT a boolean.
  taskRec(8022, 111, 'Flag is not a boolean', { done: 'yes', status: 'Completed' }),
];

function clickrFetch(url) {
  const u = new URL(url);
  if (u.origin !== BASE) throw new Error('test: fetch reached a non-Clickr host');
  const skip = Number(u.searchParams.get('skip') || 0);
  const limit = Number(u.searchParams.get('limit') || 200);
  const list = u.pathname.includes(DATASETS.tasks.datasetId) ? BT_TASKS : null;
  if (!list) return Promise.resolve({ status: 404, text: async () => '{"error":"Route not found"}' });
  const body = { recordType: 'x', columns: [], records: list.slice(skip, skip + limit), count: list.length, sort: {} };
  return Promise.resolve({ status: 200, text: async () => JSON.stringify(body) });
}

// Two instants a whole day apart, used to say "the sync wrote this and nobody
// has touched it since" and "a person has".
const SYNCED = '2026-03-10T10:00:00.000Z';
const LATER = '2026-03-11T10:00:00.000Z';

function seed() {
  engine.db.exec(`
    DELETE FROM tasks; DELETE FROM jobs; DELETE FROM users; DELETE FROM roles; DELETE FROM organizations;
    INSERT INTO organizations (id, slug, name) VALUES (1, 'agx', 'AGX Central Florida'), (2, 'other', 'Other Builders');
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ROLES_MANAGE","USERS_MANAGE","JOBS_VIEW_ALL","ESTIMATES_EDIT"]'),
      ('pm', 'PM', '["JOBS_VIEW_ALL","LEADS_VIEW"]');
    INSERT INTO users (id, email, password_hash, name, role, organization_id, active) VALUES
      (10, 'admin@agx.test', 'x', 'Ana Ruiz', 'admin', 1, 1),
      (11, 'pm@agx.test', 'x', 'Pat PM', 'pm', 1, 1),
      (12, 'mike1@agx.test', 'x', 'Mike Smith', 'pm', 1, 1),
      (13, 'mike2@agx.test', 'x', 'Mike  Smith', 'pm', 1, 1),
      (20, 'admin@other.test', 'x', 'Oscar Other', 'admin', 2, 1),
      (21, 'dana@other.test', 'x', 'Dana Cruz', 'pm', 2, 1);
  `);
  const job = engine.db.prepare('INSERT INTO jobs (id, owner_id, organization_id, bt_job_id, data) VALUES (?,?,?,?,?)');
  job.run('j-1', 10, AGX, '111', JSON.stringify({ jobNumber: 'RV2004', title: 'Citi Lakes', status: 'In Progress' }));
  job.run('j-2', 10, AGX, '222', JSON.stringify({ jobNumber: 'RV2000', title: 'Waterside III', status: 'In Progress' }));
  job.run('j-3', 10, AGX, null, JSON.stringify({ jobNumber: 'RV2013', title: 'Saddlebrook', status: 'In Progress' }));
  // ANOTHER TENANT's job carrying the SAME Buildertrend job id.
  job.run('j-b', 20, OTHER, '111', JSON.stringify({ jobNumber: 'RV2004', title: 'Citi Lakes', status: 'In Progress' }));

  const t = engine.db.prepare(
    'INSERT INTO tasks (id, organization_id, title, notes, kind, status, priority, due_date, assignee_user_id, created_by, '
    + 'entity_type, entity_id, scope, owner_user_id, service_ticket_id, completed_at, archived_at, '
    + 'bt_task_id, bt_task_status, bt_synced_at, created_at, updated_at) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const row = (id, title, o) => {
    o = o || {};
    t.run(id, o.org === undefined ? AGX : o.org, title, o.notes || null, 'todo', o.status || 'open', 'normal',
      o.due || null, o.assignee == null ? null : o.assignee, 10,
      o.entityType === undefined ? 'job' : o.entityType, o.job || 'j-1', o.scope || 'org',
      o.owner == null ? null : o.owner, o.ticket || null, o.completedAt || null, o.archivedAt || null,
      o.btId || null, o.btStatus || null, o.syncedAt || null, SYNCED, o.updatedAt || SYNCED);
  };
  row('t-a', 'Final walkthrough');
  row('t-b', 'Pull permit', { btId: '8002' });
  row('t-c', 'Install flashing', { btId: '8003' });
  row('t-d', 'Order materials');
  row('t-e', 'Order materials');
  row('t-g', 'Archived in P86', { btId: '8012', archivedAt: LATER, notes: 'What a person wrote' });
  row('t-h', 'Done in P86', { btId: '8013', status: 'done', completedAt: SYNCED });
  // The sync wrote it AND a person has edited it since (updated_at > bt_synced_at).
  row('t-i', 'Edited by a person', { btId: '8014', notes: 'A person rewrote this', due: '2026-05-05', syncedAt: SYNCED, updatedAt: LATER });
  // The sync wrote it and NOBODY has touched it since.
  row('t-j', 'Only the sync wrote it', { btId: '8015', notes: 'What the sync wrote', due: '2026-05-06', syncedAt: SYNCED, updatedAt: SYNCED });
  row('t-k', 'Claimed twice');
  row('t-only', 'P86 has this one alone');
  // NOT READ BY THIS SYNC, EVER: a private To-do, a work-order building, a task
  // on no job, and another tenant's task on a job carrying the same BT id.
  row('t-p', 'Private thing', { scope: 'personal', owner: 10 });
  row('t-w', 'Building A', { ticket: 'tkt-1' });
  row('t-noent', 'Not on a job', { entityType: null, job: null });
  row('t-x', 'Final walkthrough', { org: OTHER, job: 'j-b' });
}

const taskRow = (id) => engine.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const taskByBt = (btId) => engine.db.prepare('SELECT * FROM tasks WHERE bt_task_id = ?').all(btId);
const allTasks = () => engine.db.prepare('SELECT * FROM tasks ORDER BY id').all();
const count = (table) => engine.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;

let server;
let baseUrl;
const origFetch = global.fetch;

function call(method, pathname, user, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request(baseUrl + pathname, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        user ? { Authorization: 'Bearer ' + signToken(user) } : {}),
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const APPLY = '/api/admin/organizations/me?action=buildertrend-apply';
const PREVIEW = '/api/admin/organizations/me?view=buildertrend-preview';
const ADMIN = { id: 10, email: 'admin@agx.test', name: 'Ana Ruiz', role: 'admin', organization_id: AGX };
const put = (user, body) => call('PUT', APPLY, user, Object.assign({ dataset: 'tasks' }, body));

async function taskRows() {
  preview.forgetFetch(AGX);
  const r = await call('GET', PREVIEW, ADMIN);
  expect(r.status).toBe(200);
  return r.json.datasets.tasks;
}
const byBt = (ds, id) => ds.rows.find((r) => String(r.bt.btId) === String(id));
const fieldsOf = (list) => Object.fromEntries((list || []).map((c) => [c.field, c]));

beforeAll(async () => {
  seed();
  setRolePool(engine.pool);
  await refreshRoleCache();
  const app = express();
  app.use(express.json());
  app.use('/api/admin/organizations', orgRoutes);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  global.fetch = clickrFetch;
});
afterAll(async () => {
  global.fetch = origFetch;
  await new Promise((resolve) => server.close(resolve));
  engine.close();
});
beforeEach(async () => {
  process.env.CLICKR_API_KEY = KEY;
  delete process.env.CLICKR_ORG_SLUG;
  preview.forgetFetch(AGX);
  seed();
  await refreshRoleCache();
});

// ── THE READ AND THE MAPPING DIAGNOSTIC ───────────────────────────────────
describe('THE READ — REST-shaped records, read whole, deduped on the TASK id', () => {
  test('the dataset is read complete and classified; many tasks share a jobId and none is lost', async () => {
    const ds = await taskRows();
    expect([ds.fetch.complete, ds.fetch.reason]).toEqual([true, null]);
    expect(ds.fetch.fetched).toBe(BT_TASKS.length);
    expect(ds.rows.length).toBe(BT_TASKS.length);
    expect(ds.classified).toBe(true);
    expect(ds.error).toBeNull();
    // No fixture carries _id: identity is taskId alone.
    expect(BT_TASKS.every((r) => !Object.prototype.hasOwnProperty.call(r, '_id'))).toBe(true);
    // And 18 of the 22 share jobId 111 — a read keyed on the job would have
    // collapsed them.
    expect(BT_TASKS.filter((r) => r.jobId === '111').length).toBeGreaterThan(10);
  });

  test('DEDUPE IS ON THE TASK ID: one taskId arriving twice makes the read PARTIAL and blocks every apply', async () => {
    const dup = BT_TASKS.concat([taskRec(8001, 111, 'Final walkthrough again')]);
    const restore = global.fetch;
    global.fetch = (url) => {
      const u = new URL(url);
      const skip = Number(u.searchParams.get('skip') || 0);
      const limit = Number(u.searchParams.get('limit') || 200);
      if (!u.pathname.includes(DATASETS.tasks.datasetId)) return restore(url);
      return Promise.resolve({ status: 200, text: async () => JSON.stringify({ records: dup.slice(skip, skip + limit), count: dup.length }) });
    };
    try {
      const ds = await taskRows();
      expect(ds.fetch.complete).toBe(false);
      expect(String(ds.fetch.reason)).toMatch(/arrived more than once/i);
      const r = await put(ADMIN, { mode: 'safe' });
      expect(r.status).toBe(409);
    } finally { global.fetch = restore; preview.forgetFetch(AGX); }
  });

  test('every declared key is carried by the fixtures, and nothing undeclared is', async () => {
    const ds = await taskRows();
    expect(ds.mapping.missingKeys).toEqual([]);
    expect(ds.mapping.unexpectedKeys).toEqual([]);
    expect([ds.mapping.requiredKey, ds.mapping.requiredOk, ds.mapping.requiredUsable]).toEqual(['jobName', true, BT_TASKS.length]);
  });

  test('the registry declares exactly the ten measured keys, jobName and taskId', () => {
    expect(DATASETS.tasks.requiredKey).toBe('jobName');
    expect(DATASETS.tasks.idKey).toBe('taskId');
    expect(DATASETS.tasks.keys.slice().sort()).toEqual(
      ['assignedUsers', 'completedAt', 'dueDate', 'isCompleted', 'jobId', 'jobName', 'notes', 'status', 'taskId', 'title']);
  });

  test('THE DIAGNOSTIC: a declared key nothing carries is missing, and the key it really used is unexpected', () => {
    const renamed = BT_TASKS.map((r) => {
      const c = Object.assign({}, r);
      delete c.assignedUsers;
      c.assignees = ['Ana Ruiz'];
      return c;
    });
    const d = describeMapping('tasks', renamed);
    expect(d.missingKeys).toEqual(['assignedUsers']);
    expect(d.unexpectedKeys).toEqual([{ key: 'assignees', carriedBy: renamed.length }]);
    // The dataset still classifies: a wrong key costs the assignee, not the tab.
    expect([d.requiredOk, d.refusal]).toEqual([true, null]);
    // And NO VALUE is echoed by the diagnostic.
    expect(JSON.stringify(d)).not.toContain('Ana Ruiz');
    expect(JSON.stringify(d)).not.toContain('Final walkthrough');
  });

  test('losing jobName refuses the WHOLE dataset rather than classifying 22 jobless rows', () => {
    const nameless = BT_TASKS.map((r) => Object.assign({}, r, { jobName: '--' }));
    const d = describeMapping('tasks', nameless);
    expect(d.requiredOk).toBe(false);
    expect(d.refusal).toMatch(/carry a usable "jobName"/);
  });

  test('the required key could not have been isCompleted: a boolean reads as NO NAME through usableName', () => {
    // scalarText() answers null for a boolean, so a guard on isCompleted would
    // refuse a dataset that is present and correct on every record. Proved
    // rather than asserted in a comment.
    const d = describeMapping('tasks', BT_TASKS);
    const flag = d.fields.find((f) => f.key === 'isCompleted');
    expect(flag.carriedBy).toBe(BT_TASKS.length);
    expect(flag.nonEmpty).toBeGreaterThan(0);
    expect(flag.required).toBe(false);
  });

  test('a wrong key reads as ABSENT, never as a wrong value, and never throws', () => {
    const v = readTask({ taskId: '1', jobName: 'J', taskName: 'Nope', complete: true });
    expect([v.title, v.isCompleted, v.statusText, v.notes, v.dueDate, v.completedAt]).toEqual([null, null, null, null, null, null]);
    expect(v.assignedUsers).toEqual([]);
    expect(readTask(null).btId).toBeNull();
    expect(readTask('nope').isCompleted).toBeNull();
  });

  test('assignedUsers takes a list of strings or of {name}, and a bare string is ONE name that is never split', () => {
    const a = (v) => readTask({ taskId: '1', jobName: 'J', assignedUsers: v }).assignedUsers;
    expect(a(['Ana Ruiz', 'Pat PM'])).toEqual(['Ana Ruiz', 'Pat PM']);
    expect(a([{ name: 'Ana Ruiz' }, { name: '' }])).toEqual(['Ana Ruiz']);
    // "Ruiz, Ana" is ONE person. Splitting it would invent two who do not exist.
    expect(a('Ruiz, Ana')).toEqual(['Ruiz, Ana']);
    expect(a('')).toEqual([]);
    expect(a(null)).toEqual([]);
    expect(a({ name: 'Ana' })).toEqual([]);
  });

  test('isCompleted is THREE-STATE: true, false, and "Buildertrend did not say"', () => {
    const f = (v) => readTask({ taskId: '1', jobName: 'J', isCompleted: v }).isCompleted;
    expect(f(true)).toBe(true);
    expect(f(false)).toBe(false);
    // A STRING is not a completion answer. Read as `=== true` it would have
    // silently said "not done"; read as truthy it would have said "done".
    expect(f('true')).toBeNull();
    expect(f('false')).toBeNull();
    expect(f(1)).toBeNull();
    expect(f(undefined)).toBeNull();
    expect(taskMatch.btTaskStatus(f('yes'))).toBeNull();
  });
});

// ── THE HEADLINE ──────────────────────────────────────────────────────────
describe('isCompleted IS COMPLETION AND status IS NOT — both directions', () => {
  test('status "Pending" with isCompleted TRUE proposes DONE', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8002);
    expect([r.class, r.rung, r.p86.id]).toEqual(['matched', 'Buildertrend ID', 't-b']);
    const h = fieldsOf(r.heldBack);
    expect([h.status.applicable, h.status.value, h.status.p86Value]).toEqual([true, 'done', 'open']);
    expect(h.status.bt).toMatch(/Done on 2026-03-15/);
    // Nothing about it is a CORRECTION, so no sweep can complete a task.
    expect(r.corrections.map((c) => c.field)).not.toContain('status');
  });

  test('status "Completed" with isCompleted FALSE proposes NOTHING — the P86 task stays open', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8003);
    expect([r.class, r.rung, r.p86.id, r.p86.status]).toEqual(['matched', 'Buildertrend ID', 't-c', 'Open']);
    // No completion item AT ALL: "not done" and "open" agree.
    expect(fieldsOf(r.heldBack).status).toBeUndefined();
    expect(r.corrections).toEqual([]);
    // But Buildertrend's own word is still due to be recorded, under its own name.
    expect(r.btStatusDue).toBe(true);
    expect(r.bt.statusText).toBe('Completed');
    expect(r.bt.doneText).toBe('Not done');
  });

  test('applying the row records the WORD and leaves the STATUS alone', async () => {
    const r = await put(ADMIN, { mode: 'rows', btIds: ['8003'], fields: [] });
    expect(r.status).toBe(200);
    expect(r.json.counts.statusWord).toBe(1);
    const t = taskRow('t-c');
    expect([t.status, t.bt_task_status, t.completed_at]).toEqual(['open', 'Completed', null]);
  });

  test('a task created from a "Completed" record that isCompleted calls open is created OPEN', async () => {
    const r = await put(ADMIN, { mode: 'create', btIds: ['8005'] });
    expect(r.status).toBe(200);
    const made = taskByBt('8005');
    expect(made.length).toBe(1);
    expect([made[0].status, made[0].completed_at, made[0].bt_task_status]).toEqual(['open', null, 'Completed']);
  });

  test('a completion flag that is not a boolean proposes nothing and creates OPEN, saying so', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8022);
    expect(r.class).toBe('new');
    expect(r.notes.join(' ')).toMatch(/not true or false/);
    expect(r.notes.join(' ')).toMatch(/is not completion/);
    await put(ADMIN, { mode: 'create', btIds: ['8022'] });
    expect(taskByBt('8022')[0].status).toBe('open');
  });
});

// ── RUNGS AND THE REFUSAL TO GUESS ────────────────────────────────────────
describe('PREVIEW — rungs, classes, and the refusal to guess', () => {
  test('rung 1 (job + title): every proposal on a blank P86 task is a FILL', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8001);
    expect([r.class, r.rung, r.p86.id]).toEqual(['conflict', 'Title on this job', 't-a']);
    const c = fieldsOf(r.corrections);
    expect(Object.keys(c).sort()).toEqual(['assignee', 'dueDate', 'notes']);
    expect(c.notes.kind).toBe('fill');
    expect(c.dueDate.kind).toBe('fill');
    expect([c.assignee.kind, c.assignee.value, c.assignee.to]).toEqual(['fill', 10, 'Ana Ruiz']);
  });

  test('THE SAME TITLE ON A DIFFERENT JOB NEVER CROSS-MATCHES', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8005);
    // P86 holds 'Final walkthrough' on j-1 only. This row is on j-2.
    expect([r.class, r.p86, r.job.id]).toEqual(['new', null, 'j-2']);
    expect(r.candidates).toEqual([]);
    // And the P86 task with that title is untouched by it.
    expect(byBt(ds, 8001).p86.id).toBe('t-a');
  });

  test('two P86 tasks on the job carry the title: AMBIGUOUS, both candidates, nothing proposed', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8006);
    expect([r.class, r.rung, r.p86]).toEqual(['ambiguous', null, null]);
    expect(r.candidates.map((x) => x.id).sort()).toEqual(['t-d', 't-e']);
    expect([r.corrections, r.heldBack]).toEqual([[], []]);
    expect(r.notes.join(' ')).toMatch(/2 P86 tasks on this job carry this title/);
  });

  test('TWO Buildertrend tasks landing on ONE P86 task: neither is matched', async () => {
    const ds = await taskRows();
    for (const id of [8016, 8017]) {
      const r = byBt(ds, id);
      expect([r.class, r.p86, r.rung]).toEqual(['ambiguous', null, null]);
      expect(r.notes.join(' ')).toMatch(/2 Buildertrend tasks land on this same P86 task/);
    }
    expect(taskRow('t-k').bt_task_id).toBeNull();
  });

  test('a task whose Buildertrend job is not linked WAITS', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8007);
    expect([r.class, r.waitingOnJob, r.p86]).toEqual(['refused', true, null]);
    expect(r.notes.join(' ')).toMatch(/not linked to a P86 job yet/);
    // The create path refuses it at the class, before createTask is ever
    // called: a waiting row is 'refused', not 'new'. Its own note is what tells
    // a person WHY, and it is asserted above.
    const out = await put(ADMIN, { mode: 'create', btIds: ['8007'] });
    expect(out.json.results[0].outcome).toBe('skipped');
    expect(out.json.results[0].reason).toMatch(/this one is refused/);
    // And createTask's own guard is the second lock, reached only if the class
    // ever let one through.
    expect(taskByBt('8007').length).toBe(0);
  });

  test('a task with no title is refused, never created', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8018);
    expect(r.class).toBe('refused');
    expect(r.notes.join(' ')).toMatch(/without a title/);
    const before = count('tasks');
    const out = await put(ADMIN, { mode: 'create', btIds: ['8018'] });
    expect(out.json.results[0].outcome).toBe('skipped');
    expect(count('tasks')).toBe(before);
  });

  test('a Buildertrend task with no id is refused outright', () => {
    const rows = taskMatch.matchTasks([{ btId: null, title: 'x', jobId: '111', jobName: 'J', assignedUsers: [] }],
      { jobs: [{ id: 'j-1', bt_job_id: '111', data: {} }], taskRows: [], users: [] });
    expect(rows[0].class).toBe('refused');
    expect(rows[0].notes.join(' ')).toMatch(/without an id/);
  });
});

// ── THE ASSIGNEE ──────────────────────────────────────────────────────────
describe('THE ASSIGNEE — resolved when unambiguous, UNASSIGNED otherwise, never guessed', () => {
  test('a name that matches nobody imports UNASSIGNED and says so', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8008);
    expect(r.notes.join(' ')).toMatch(/"Nobody Here" is not a P86 user, so the task is imported unassigned/);
    await put(ADMIN, { mode: 'create', btIds: ['8008'] });
    expect(taskByBt('8008')[0].assignee_user_id).toBeNull();
  });

  test('a name TWO P86 users answer to sets nobody', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8009);
    expect(r.notes.join(' ')).toMatch(/matches 2 P86 users, so none is set/);
    await put(ADMIN, { mode: 'create', btIds: ['8009'] });
    expect(taskByBt('8009')[0].assignee_user_id).toBeNull();
  });

  test('SEVERAL people sets nobody and prints all of them — the key is plural, the column is not', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8010);
    expect(r.notes.join(' ')).toMatch(/Buildertrend has 2 people on this task \(Ana Ruiz, Pat PM\)/);
    expect(r.notes.join(' ')).toMatch(/exactly one assignee/);
    await put(ADMIN, { mode: 'create', btIds: ['8010'] });
    expect(taskByBt('8010')[0].assignee_user_id).toBeNull();
  });

  test('A USER OF ANOTHER ORGANISATION IS NEVER A CANDIDATE', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8011);
    // 'Dana Cruz' is user 21 of org 2. She is not in this organisation's
    // directory at all, so the name resolves to nobody.
    expect(r.notes.join(' ')).toMatch(/"Dana Cruz" is not a P86 user/);
    await put(ADMIN, { mode: 'create', btIds: ['8011'] });
    const made = taskByBt('8011')[0];
    expect(made.assignee_user_id).toBeNull();
    expect(made.organization_id).toBe(AGX);
  });

  test('resolveAssignee, directly: nobody / one / several / no match / two matches', () => {
    const users = [{ id: 10, name: 'Ana Ruiz' }, { id: 12, name: 'Mike Smith' }, { id: 13, name: 'Mike  Smith' }];
    expect(taskMatch.resolveAssignee(users, []).user).toBeNull();
    expect(taskMatch.resolveAssignee(users, []).why).toBeNull();
    expect(taskMatch.resolveAssignee(users, ['Ana Ruiz']).user.id).toBe(10);
    expect(taskMatch.resolveAssignee(users, ['ANA  RUIZ']).user.id).toBe(10);
    expect(taskMatch.resolveAssignee(users, ['Ana Ruiz', 'Mike Smith']).user).toBeNull();
    expect(taskMatch.resolveAssignee(users, ['Nobody']).user).toBeNull();
    expect(taskMatch.resolveAssignee(users, ['Mike Smith']).user).toBeNull();
    expect(taskMatch.resolveAssignee(users, ['--']).user).toBeNull();
  });

  test('a P86 task that already names somebody is NEVER re-assigned', async () => {
    engine.db.prepare('UPDATE tasks SET assignee_user_id = 11 WHERE id = ?').run('t-a');
    const ds = await taskRows();
    const r = byBt(ds, 8001);
    expect(r.corrections.map((c) => c.field)).not.toContain('assignee');
    const h = fieldsOf(r.heldBack);
    expect([h.assignee.applicable, h.assignee.bt, h.assignee.p86]).toEqual([false, 'Ana Ruiz', 'Pat PM']);
    await put(ADMIN, { mode: 'rows', btIds: ['8001'], fields: ['assignee'] });
    expect(taskRow('t-a').assignee_user_id).toBe(11);
  });
});

// ── WHAT PROTECTS A TASK A PERSON HAS TOUCHED ─────────────────────────────
describe('A TASK A PERSON TOUCHED IS NOT REWRITTEN', () => {
  test('an ARCHIVED P86 task is still matched (so no duplicate is created) and takes the link only', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8012);
    expect([r.class, r.p86.id, r.p86.archived]).toEqual(['matched', 't-g', true]);
    expect(r.corrections).toEqual([]);
    expect(r.heldBack.every((h) => h.applicable !== true)).toBe(true);
    expect(JSON.stringify(r.heldBack)).toMatch(/never un-archives/);
    // Even a press naming every field writes nothing but the word beside it.
    const before = taskRow('t-g');
    await put(ADMIN, { mode: 'rows', btIds: ['8012'], fields: ['status', 'notes', 'dueDate', 'title'] });
    const after = taskRow('t-g');
    expect([after.status, after.notes, after.due_date, after.archived_at, after.completed_at])
      .toEqual([before.status, before.notes, before.due_date, before.archived_at, before.completed_at]);
  });

  test('a P86 task a person COMPLETED is never re-opened', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8013);
    const h = fieldsOf(r.heldBack);
    expect([h.status.applicable, h.status.bt, h.status.p86]).toEqual([false, 'Not done', 'Done']);
    expect(h.status.note).toMatch(/never re-opens a task a person finished/);
    await put(ADMIN, { mode: 'rows', btIds: ['8013'], fields: ['status'] });
    const t = taskRow('t-h');
    expect([t.status, t.completed_at]).toEqual(['done', SYNCED]);
  });

  test('a sync-written task A PERSON EDITED refuses the replacement; one nobody edited offers it', async () => {
    const ds = await taskRows();
    const edited = fieldsOf(byBt(ds, 8014).heldBack);
    expect([edited.notes.applicable, edited.dueDate.applicable]).toEqual([false, false]);
    expect(edited.notes.note).toMatch(/a person wrote it — a sync rewrites nothing somebody typed/);
    expect(byBt(ds, 8014).p86.edited).toBe(true);

    const clean = fieldsOf(byBt(ds, 8015).heldBack);
    expect([clean.notes.applicable, clean.dueDate.applicable]).toEqual([true, true]);
    expect(byBt(ds, 8015).p86.edited).toBe(false);
  });

  test('ticking them writes only the one nobody edited, and the other is refused at the LOCKED row too', async () => {
    const r = await put(ADMIN, { mode: 'rows', btIds: ['8014', '8015'], fields: ['notes', 'dueDate'] });
    expect(r.status).toBe(200);
    const edited = taskRow('t-i');
    expect([edited.notes, edited.due_date]).toEqual(['A person rewrote this', '2026-05-05']);
    const clean = taskRow('t-j');
    expect([clean.notes, clean.due_date]).toEqual(['Buildertrend says this now', '2026-06-02']);
  });

  test('personEdited fails CLOSED: a task the sync never wrote, and a stamp it cannot read, are a person\'s', () => {
    expect(taskMatch.personEdited({ btSyncedAt: null, updatedAt: SYNCED })).toBe(true);
    expect(taskMatch.personEdited({ btSyncedAt: 'not a date', updatedAt: SYNCED })).toBe(true);
    expect(taskMatch.personEdited({ btSyncedAt: SYNCED, updatedAt: LATER })).toBe(true);
    expect(taskMatch.personEdited({ btSyncedAt: SYNCED, updatedAt: SYNCED })).toBe(false);
    expect(taskMatch.personEdited({ btSyncedAt: SYNCED, updatedAt: null })).toBe(false);
  });

  test('LINKING a task a person wrote leaves bt_synced_at NULL, so its words stay theirs for good', async () => {
    // t-a is a person's task matched by title. The safe press links it.
    await put(ADMIN, { mode: 'safe' });
    const t = taskRow('t-a');
    expect(t.bt_task_id).toBe('8001');
    expect(t.bt_synced_at).toBeNull();
    // Give it text of its own; Buildertrend's differs from here on.
    engine.db.prepare('UPDATE tasks SET notes = ? WHERE id = ?').run('Something a person typed', 't-a');
    const ds = await taskRows();
    const h = fieldsOf(byBt(ds, 8001).heldBack);
    expect(h.notes.applicable).toBe(false);
  });

  test('a title is a MATCH KEY: never a correction, and offered only where P86 has none', async () => {
    engine.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('A person renamed this', 't-b');
    const ds = await taskRows();
    const r = byBt(ds, 8002);
    expect(r.corrections.map((c) => c.field)).not.toContain('title');
    const h = fieldsOf(r.heldBack);
    expect([h.title.applicable, h.title.bt]).toEqual([false, 'Pull permit']);
    expect(h.title.note).toMatch(/MATCH KEY, never something a sync corrects/);
    await put(ADMIN, { mode: 'rows', btIds: ['8002'], fields: ['title'] });
    expect(taskRow('t-b').title).toBe('A person renamed this');
  });
});

// ── THE SWEEPS WRITE NOTHING BUT THE LINK ─────────────────────────────────
describe('THE PRESSES — safe, and "apply everything" with no fields', () => {
  const contentOf = (t) => [t.title, t.notes, t.status, t.due_date, t.assignee_user_id, t.completed_at, t.archived_at, t.scope];

  test('THE SAFE PRESS links confident matches and changes NOTHING else on any row', async () => {
    const before = Object.fromEntries(allTasks().map((t) => [t.id, contentOf(t)]));
    const r = await put(ADMIN, { mode: 'safe' });
    expect(r.status).toBe(200);
    expect(r.json.counts.linked).toBeGreaterThan(0);
    const after = Object.fromEntries(allTasks().map((t) => [t.id, contentOf(t)]));
    expect(after).toEqual(before);
    // The link itself IS written.
    expect(taskRow('t-a').bt_task_id).toBe('8001');
    // And nothing was created or removed.
    expect(allTasks().length).toBe(Object.keys(before).length);
  });

  test('AN "APPLY EVERYTHING" PRESS THAT NAMES NO FIELDS completes nothing, retitles nothing and replaces nothing', async () => {
    const before = Object.fromEntries(allTasks().map((t) => [t.id, contentOf(t)]));
    const r = await put(ADMIN, { mode: 'rows', btIds: ['8002', '8012', '8013', '8014', '8015', '8003'] });
    expect(r.status).toBe(200);
    const after = Object.fromEntries(allTasks().map((t) => [t.id, contentOf(t)]));
    // 8002 would COMPLETE t-b, 8014/8015 would replace notes and due dates.
    // None of them is a correction, so none of them moves.
    expect(after).toEqual(before);
  });

  test('a no-fields press still applies FILLS, because a fill destroys nothing', async () => {
    await put(ADMIN, { mode: 'rows', btIds: ['8001'] });
    const t = taskRow('t-a');
    expect([t.notes, t.due_date, t.assignee_user_id]).toEqual(['Check the gutters', '2026-04-10', 10]);
    // ...and still nothing else.
    expect([t.status, t.completed_at, t.title]).toEqual(['open', null, 'Final walkthrough']);
  });

  test('ticking the completion item is what completes a task, and it stamps Buildertrend\'s own date', async () => {
    const r = await put(ADMIN, { mode: 'rows', btIds: ['8002'], fields: ['status'] });
    expect(r.status).toBe(200);
    const t = taskRow('t-b');
    expect(t.status).toBe('done');
    expect(String(t.completed_at)).toContain('2026-03-15');
  });
});

// ── CREATE ────────────────────────────────────────────────────────────────
describe('CREATE — an ORG task on the job, stamped from the JOB', () => {
  test('a created task is scope org, carries the JOB\'s organisation, and links through entity_type/entity_id', async () => {
    const r = await put(ADMIN, { mode: 'create', btIds: ['8004'] });
    expect(r.status).toBe(200);
    expect(r.json.counts.created).toBe(1);
    const t = taskByBt('8004')[0];
    expect([t.scope, t.organization_id, t.entity_type, t.entity_id]).toEqual(['org', AGX, 'job', 'j-1']);
    expect([t.kind, t.priority, t.owner_user_id, t.service_ticket_id]).toEqual(['todo', 'normal', null, null]);
    expect([t.title, t.notes, t.due_date, t.assignee_user_id]).toEqual(['Punch list walk', 'Bring the ladder', '2026-02-28', 11]);
    expect([t.status, t.bt_task_status]).toEqual(['done', 'Completed']);
    expect(String(t.completed_at)).toContain('2026-03-01');
    expect(t.bt_synced_at).not.toBeNull();
    expect(t.created_by).toBe(10);
  });

  test('done in Buildertrend with no completion date: P86 stamps its own and says so', async () => {
    const r = await put(ADMIN, { mode: 'create', btIds: ['8021'] });
    const t = taskByBt('8021')[0];
    expect(t.status).toBe('done');
    expect(t.completed_at).not.toBeNull();
    expect(t.entity_id).toBe('j-2');
    expect(r.json.results[0].notes.join(' ')).toMatch(/recorded no completion date/);
  });

  test('creating twice is refused by the link, not by luck', async () => {
    await put(ADMIN, { mode: 'create', btIds: ['8004'] });
    const again = await put(ADMIN, { mode: 'create', btIds: ['8004'] });
    expect(again.json.results[0].outcome).toBe('skipped');
    expect(taskByBt('8004').length).toBe(1);
  });

  test('the bulk create makes every Buildertrend-only task and no ambiguous or refused one', async () => {
    const ds = await taskRows();
    const newIds = ds.rows.filter((r) => r.class === 'new').map((r) => String(r.bt.btId)).sort();
    const r = await put(ADMIN, { mode: 'create', btIds: newIds });
    expect(r.json.counts.created).toBe(newIds.length);
    // Nothing ambiguous, refused or already-matched was created.
    for (const id of ['8006', '8007', '8016', '8017', '8018', '8001', '8002']) {
      expect(taskByBt(id).filter((t) => t.id.indexOf('task_') === 0).length).toBe(0);
    }
    // Every created task is an ORG task on a real P86 job of this organisation.
    for (const t of allTasks().filter((x) => x.id.indexOf('task_') === 0)) {
      expect([t.scope, t.organization_id, t.entity_type]).toEqual(['org', AGX, 'job']);
      expect(['j-1', 'j-2']).toContain(t.entity_id);
    }
  });
});

// ── WHAT IS NEVER READ ────────────────────────────────────────────────────
describe('A PRIVATE TO-DO, A WORK-ORDER BUILDING AND ANOTHER TENANT ARE NEVER READ', () => {
  test('a personal To-do with the same title reads as Buildertrend-only, and is never written', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8019);
    expect([r.class, r.p86, r.candidates]).toEqual(['new', null, []]);
    expect(JSON.stringify(ds)).not.toContain('t-p');
    await put(ADMIN, { mode: 'create', btIds: ['8019'] });
    const priv = taskRow('t-p');
    expect([priv.bt_task_id, priv.scope, priv.owner_user_id]).toEqual([null, 'personal', 10]);
  });

  test('a WORK-ORDER BUILDING with the same title is never a candidate and never completed by a sync', async () => {
    const ds = await taskRows();
    const r = byBt(ds, 8020);
    expect([r.class, r.p86]).toEqual(['new', null]);
    expect(JSON.stringify(ds)).not.toContain('t-w');
    const before = taskRow('t-w');
    await put(ADMIN, { mode: 'safe' });
    const after = taskRow('t-w');
    expect([after.status, after.bt_task_id, after.completed_at]).toEqual([before.status, null, before.completed_at]);
  });

  test('a task on no job at all is out of reach of a job-scoped sync', async () => {
    const ds = await taskRows();
    expect(JSON.stringify(ds)).not.toContain('t-noent');
    expect(taskRow('t-noent').bt_task_id).toBeNull();
  });

  test('ANOTHER ORGANISATION\'S TASK on a job carrying the same Buildertrend id is never read, matched or written', async () => {
    const ds = await taskRows();
    expect(JSON.stringify(ds)).not.toContain('t-x');
    expect(byBt(ds, 8001).p86.id).toBe('t-a');
    // Every press, and the row-level link, refuse it.
    await put(ADMIN, { mode: 'safe' });
    await put(ADMIN, { mode: 'rows', btIds: ['8001'], fields: ['notes', 'dueDate', 'assignee'] });
    const link = await put(ADMIN, { mode: 'link', btId: '8006', p86Id: 't-x' });
    expect(link.json.results[0].outcome).toBe('skipped');
    expect(link.json.results[0].reason).toMatch(/not one of the candidates/);
    const x = taskRow('t-x');
    expect([x.bt_task_id, x.notes, x.organization_id, x.title]).toEqual([null, null, OTHER, 'Final walkthrough']);
  });

  test('an admin of another organisation is refused the whole preview', async () => {
    const r = await call('GET', PREVIEW, { id: 20, email: 'admin@other.test', name: 'Oscar Other', role: 'admin', organization_id: OTHER });
    expect(r.status).toBe(403);
  });
});

// ── LINK ──────────────────────────────────────────────────────────────────
describe('LINK — a person picks between candidates the matcher refused to choose between', () => {
  test('linking an ambiguous row writes the id and NOTHING else, and leaves bt_synced_at NULL', async () => {
    const r = await put(ADMIN, { mode: 'link', btId: '8006', p86Id: 't-d' });
    expect(r.status).toBe(200);
    expect(r.json.results[0].outcome).toBe('linked');
    const t = taskRow('t-d');
    expect([t.bt_task_id, t.bt_synced_at, t.status, t.notes]).toEqual(['8006', null, 'open', null]);
    // Buildertrend's own word is recorded beside it, as it is for a change order.
    expect(t.bt_task_status).toBe('Completed');
    expect(taskRow('t-e').bt_task_id).toBeNull();
  });

  test('a P86 record the matcher never listed cannot be linked', async () => {
    const r = await put(ADMIN, { mode: 'link', btId: '8006', p86Id: 't-only' });
    expect(r.json.results[0].outcome).toBe('skipped');
    expect(taskRow('t-only').bt_task_id).toBeNull();
  });
});

// ── NOT IN BUILDERTREND, AND THE SINCE SNAPSHOT ───────────────────────────
describe('THE REST OF THE TAB', () => {
  test('a P86 task nothing in Buildertrend reached is listed for review and nothing is proposed for it', async () => {
    const ds = await taskRows();
    const nib = ds.notInBuildertrend;
    expect(nib.reliable).toBe(true);
    expect(nib.rows.map((r) => r.id)).toContain('t-only');
    expect(nib.sentence).toMatch(/Nothing is proposed for deletion, and a sync never archives one/);
    // Private To-dos and buildings are not even in the population.
    expect(nib.rows.map((r) => r.id)).not.toContain('t-p');
    expect(nib.rows.map((r) => r.id)).not.toContain('t-w');
    expect(nib.rows.map((r) => r.id)).not.toContain('t-x');
  });

  test('the since-snapshot remembers COMPLETION from isCompleted and the status word under its own name', () => {
    const done = since.snapshotOf('tasks', readTask(taskRec(1, 111, 'T', { done: true, status: 'Pending' })));
    const open = since.snapshotOf('tasks', readTask(taskRec(2, 111, 'T', { done: false, status: 'Completed' })));
    expect([done.completed, done.btStatus]).toEqual(['Yes', 'Pending']);
    expect([open.completed, open.btStatus]).toEqual(['No', 'Completed']);
    // A flag that is not a boolean stays NULL rather than collapsing to 'No'.
    expect(since.snapshotOf('tasks', readTask(taskRec(3, 111, 'T', { done: 'yes' }))).completed).toBeNull();
    // A list of assignees is one comparable string, in Buildertrend's order.
    expect(since.snapshotOf('tasks', readTask(taskRec(4, 111, 'T', { assigned: ['Ana Ruiz', 'Pat PM'] }))).assignee).toBe('Ana Ruiz, Pat PM');
    expect(since.snapshotOf('tasks', readTask(taskRec(5, 111, 'T'))).assignee).toBeNull();
  });

  test('the tab says plainly that no money is involved', async () => {
    const fs = require('fs');
    const ui = fs.readFileSync(require('path').join(__dirname, '..', 'js', 'bt-sync-preview.js'), 'utf8');
    expect(ui).toContain('NO MONEY IS INVOLVED');
    // ...and the cache-buster was bumped with it.
    const html = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
    expect(html).toMatch(/js\/bt-sync-preview\.js\?v=(2[0-9]|[3-9][0-9])/);
  });
});
