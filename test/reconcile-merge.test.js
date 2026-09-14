// Buildertrend reconcile: MERGE a P86 duplicate into the Buildertrend-linked
// record, ARCHIVE a P86-only record, and review the archive (RESTORE / DELETE
// PERMANENTLY). server/services/clickr/reconcile-merge.js, reached through
// PUT /api/admin/organizations/me?action=buildertrend-apply with mode merge /
// archive / restore / delete, and GET /me?view=buildertrend-archive.
//
// Real express router, requireAuth / requireOrg / ROLES_MANAGE, a JWT, and the
// pg-sqlite engine with every table derived from server/db.js.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema, tableNames, tableColumns, hasTable } = require('./helpers/db-schema');

const engine = createPgSqlite(
  sqliteSchema(tableNames(), { pk: { organizations: 'id', users: 'id', roles: 'name', jobs: 'id', leads: 'id', clients: 'id', estimates: 'id' } }),
  { jsonColumns: ['data'] }
);
globalThis.__P86_RECONCILE_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_RECONCILE_ENGINE__.pool }));
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});
jest.mock('../server/geocoder', () => ({ geocodeAddress: async () => null, geocodeViaGoogle: async () => null, geocodeViaCensus: async () => null }));

const reconcile = require('../server/services/clickr/reconcile-merge');
const preview = require('../server/services/clickr/sync-preview');
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const orgRoutes = require('../server/routes/admin-organizations-routes');
const leadRoutes = require('../server/routes/lead-routes');
const clientRoutes = require('../server/routes/client-routes');

const AGX = 1;
const OTHER = 2;
const ADMIN = { id: 10, email: 'admin@agx.test', name: 'Ana Ruiz', role: 'admin', organization_id: AGX };
const PM = { id: 11, email: 'pm@agx.test', name: 'Pat PM', role: 'pm', organization_id: AGX };
const OTHER_ADMIN = { id: 20, email: 'admin@other.test', name: 'Oscar Other', role: 'admin', organization_id: OTHER };
const APPLY = '/api/admin/organizations/me?action=buildertrend-apply';

let server;
let baseUrl;

function req(method, pathname, user, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = Object.assign({}, payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      user ? { Authorization: 'Bearer ' + signToken(user) } : {});
    const r = http.request(baseUrl + pathname, { method, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject);
    r.end(payload || undefined);
  });
}
const put = (body, user) => req('PUT', APPLY, user || ADMIN, body);

const q = (sql, ...params) => engine.db.prepare(sql).all(...params);
const one = (sql, ...params) => engine.db.prepare(sql).get(...params);
const run = (sql, ...params) => engine.db.prepare(sql).run(...params);
const jobData = (id) => JSON.parse(one('SELECT data FROM jobs WHERE id = ?', id).data);

function seed() {
  for (const t of ['jobs', 'leads', 'clients', 'estimates', 'job_change_orders', 'job_purchase_orders', 'schedule_entries', 'attachments', 'file_folders',
    'tasks', 'job_access', 'qb_cost_lines', 'invoices', 'lead_graphs', 'node_graphs', 'users', 'roles', 'organizations', 'job_subs']) {
    run('DELETE FROM ' + t);
  }
  engine.db.exec(`
    INSERT INTO organizations (id, slug, name) VALUES (1, 'agx', 'AGX Central Florida'), (2, 'other', 'Other Builders');
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ROLES_MANAGE","USERS_MANAGE","JOBS_VIEW_ALL","LEADS_VIEW","LEADS_EDIT","ESTIMATES_VIEW","ESTIMATES_EDIT"]'),
      ('pm', 'PM', '["JOBS_VIEW_ALL","LEADS_VIEW","ESTIMATES_VIEW"]');
    INSERT INTO users (id, email, password_hash, name, role, organization_id, active) VALUES
      (10, 'admin@agx.test', 'x', 'Ana Ruiz', 'admin', 1, 1),
      (11, 'pm@agx.test', 'x', 'Pat PM', 'pm', 1, 1),
      (12, 'crew@agx.test', 'x', 'Cal Crew', 'pm', 1, 1),
      (20, 'admin@other.test', 'x', 'Oscar Other', 'admin', 2, 1);
  `);
  const job = (id, org, data, extra) => run('INSERT INTO jobs (id, owner_id, organization_id, data, bt_job_id, lead_id) VALUES (?,?,?,?,?,?)',
    id, 10, org, JSON.stringify(data), (extra && extra.bt) || null, (extra && extra.lead) || null);
  job('j-keep', AGX, { jobNumber: 'S1050', title: 'Harbor Club Railings', status: 'In Progress', clientId: 'c-dup', client: 'Harbor HOA dup' }, { bt: '111' });
  job('j-dup', AGX, { jobNumber: 'S1050B', title: 'Harbor Club Railings', status: 'In Progress' }, { lead: 'l-dup' });
  job('j-crew', AGX, { jobNumber: 'S2000', title: 'Crew Job', status: 'In Progress', buildings: [{ id: 'b1' }] });
  job('j-only', AGX, { jobNumber: 'S9999', title: 'Only in P86', status: 'On Hold' });
  job('j-other', OTHER, { jobNumber: 'S1050', title: 'Harbor Club Railings', status: 'In Progress' });

  // Everything attached to the duplicate job.
  run("INSERT INTO job_change_orders (id, job_id, status, co_number, organization_id, data) VALUES ('co1', 'j-dup', 'approved', 'CO-1', 1, '{}')");
  run("INSERT INTO job_purchase_orders (id, job_id, status, organization_id, data) VALUES ('po1', 'j-dup', 'draft', 1, '{}')");
  run("INSERT INTO schedule_entries (id, job_id, start_date, days) VALUES ('se1', 'j-dup', '2026-10-01', 2)");
  run("INSERT INTO qb_cost_lines (id, job_id, amount) VALUES ('qb1', 'j-dup', 125.5)");
  run("INSERT INTO invoices (id, job_id, status, organization_id) VALUES ('inv1', 'j-dup', 'draft', 1)");
  run("INSERT INTO tasks (id, entity_type, entity_id, organization_id, title) VALUES ('t1', 'job', 'j-dup', 1, 'Punch list')");
  run("INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, folder_id) VALUES ('a1', 'job', 'j-dup', 'dup.jpg', 'image/jpeg', 'f-dup-photos')");
  run("INSERT INTO file_folders (id, entity_type, entity_id, parent_id, name, path) VALUES ('f-keep-photos', 'job', 'j-keep', NULL, 'Photos', '/Photos')");
  run("INSERT INTO file_folders (id, entity_type, entity_id, parent_id, name, path) VALUES ('f-dup-photos', 'job', 'j-dup', NULL, 'photos', '/photos')");
  run("INSERT INTO file_folders (id, entity_type, entity_id, parent_id, name, path) VALUES ('f-dup-permits', 'job', 'j-dup', NULL, 'Permits', '/Permits')");
  run("INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j-keep', 11, 'edit'), ('j-dup', 11, 'view'), ('j-dup', 12, 'edit')");
  run("INSERT INTO node_graphs (job_id, data) VALUES ('j-dup', '{\"nodes\":[]}')");

  // Clients and leads.
  run("INSERT INTO clients (id, name, organization_id, bt_contact_id) VALUES ('c-keep', 'Greystar - Summerall', 1, '9001')");
  run("INSERT INTO clients (id, name, organization_id) VALUES ('c-dup', 'Summerall', 1), ('c-prop', 'Summerall Building 2', 1), ('c-only', 'Old Client', 1), ('c-other', 'Summerall', 2)");
  run("UPDATE clients SET parent_client_id = 'c-dup' WHERE id = 'c-prop'");
  run("UPDATE jobs SET client_id = 'c-dup' WHERE id = 'j-keep'");
  run("INSERT INTO leads (id, title, status, organization_id, client_id, bt_lead_id) VALUES ('l-keep', 'Gazebo Repair', 'new', 1, 'c-dup', '555')");
  run("INSERT INTO leads (id, title, status, organization_id, client_id) VALUES ('l-dup', 'Gazebo Repair', 'new', 1, 'c-dup'), ('l-only', 'Stale Lead', 'new', 1, NULL)");
  run("INSERT INTO lead_graphs (lead_id, data) VALUES ('l-dup', '{\"footprints\":[]}')");
  run("INSERT INTO estimates (id, organization_id, data) VALUES ('e1', 1, ?)", JSON.stringify({ lead_id: 'l-dup', clientId: 'c-dup', client: 'Summerall' }));
  run("INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type) VALUES ('a-client', 'client', 'c-dup', 'site.pdf', 'application/pdf')");
}

beforeAll(async () => {
  setRolePool(engine.pool);
  seed();
  await refreshRoleCache();
  const app = express();
  app.use(express.json());
  app.use('/api/admin/organizations', orgRoutes);
  app.use('/api/leads', leadRoutes);
  app.use('/api/clients', clientRoutes);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  engine.close();
});
beforeEach(async () => { seed(); await refreshRoleCache(); });

describe('the reference registry is pinned to the schema', () => {
  test('every column in server/db.js that points at a job, lead or client is moved or deliberately not', () => {
    const { tables } = tableColumns();
    const moved = new Set();
    for (const kind of Object.keys(reconcile.PLAIN)) for (const r of reconcile.PLAIN[kind]) moved.add(r.table + '.' + r.col);
    const poly = new Set(reconcile.POLYMORPHIC);
    const missing = [];
    for (const [table, cols] of tables) {
      for (const col of cols.keys()) {
        const key = table + '.' + col;
        const isRef = ['job_id', 'lead_id', 'client_id', 'parent_client_id'].includes(col);
        const isPoly = col === 'entity_id' && cols.has('entity_type');
        if (!isRef && !isPoly) continue;
        if (moved.has(key) || reconcile.NOT_MOVED[key] || (isPoly && poly.has(table))) continue;
        missing.push(key);
      }
    }
    // Tables this reconcile deliberately leaves alone because they are not about
    // a job/lead/client record at all are listed here, each with its reason.
    const OUT_OF_SCOPE = {
      'job_reports.entity_id': 'moved as polymorphic (job_reports is in POLYMORPHIC)',
    };
    expect(missing.filter((k) => !OUT_OF_SCOPE[k])).toEqual([]);
    for (const k of moved) expect(hasTable(k.split('.')[0])).toBe(true);
    for (const t of poly) expect(hasTable(t)).toBe(true);
  });
});

describe('merge a duplicate job into the Buildertrend-linked job', () => {
  test('everything attached moves; folders fold; one-per-job and duplicate access stay; the copy is archived as Archived', async () => {
    const r = await put({ dataset: 'jobs', mode: 'merge', survivorId: 'j-keep', loserId: 'j-dup' });
    expect(r.status).toBe(200);
    const res = r.json.results[0];
    expect(res.outcome).toBe('merged');
    for (const [sql, id] of [['SELECT job_id FROM job_change_orders WHERE id = ?', 'co1'], ['SELECT job_id FROM job_purchase_orders WHERE id = ?', 'po1'],
      ['SELECT job_id FROM schedule_entries WHERE id = ?', 'se1'], ['SELECT job_id FROM qb_cost_lines WHERE id = ?', 'qb1'], ['SELECT job_id FROM invoices WHERE id = ?', 'inv1']]) {
      expect(one(sql, id).job_id).toBe('j-keep');
    }
    expect(one("SELECT entity_id FROM tasks WHERE id = 't1'").entity_id).toBe('j-keep');
    expect(one("SELECT entity_id, folder_id FROM attachments WHERE id = 'a1'")).toEqual({ entity_id: 'j-keep', folder_id: 'f-keep-photos' });
    expect(one("SELECT COUNT(*) AS n FROM file_folders WHERE id = 'f-dup-photos'").n).toBe(0);
    expect(one("SELECT entity_id FROM file_folders WHERE id = 'f-dup-permits'").entity_id).toBe('j-keep');
    // job_access: user 11 already had access to the kept job — that row stays; user 12 moves.
    expect(q("SELECT user_id FROM job_access WHERE job_id = 'j-keep' ORDER BY user_id").map((x) => x.user_id)).toEqual([11, 12]);
    expect(res.kept).toEqual({ job_access: 1 });
    // The graph moved because the kept job had none; the lead link came across.
    expect(one("SELECT job_id FROM node_graphs").job_id).toBe('j-keep');
    expect(one("SELECT lead_id FROM jobs WHERE id = 'j-keep'").lead_id).toBe('l-dup');
    // Archived copy.
    const dup = one("SELECT bt_archived_at, bt_archive_reason, bt_merged_into, bt_archived_by FROM jobs WHERE id = 'j-dup'");
    expect(dup.bt_archived_at).toBeTruthy();
    expect(dup).toMatchObject({ bt_archive_reason: 'merged', bt_merged_into: 'j-keep', bt_archived_by: 10 });
    expect(jobData('j-dup')).toMatchObject({ status: 'Archived', btArchivedFromStatus: 'In Progress' });
    // Another organization's same-numbered job is untouched.
    expect(one("SELECT bt_archived_at FROM jobs WHERE id = 'j-other'").bt_archived_at).toBeNull();
  });

  test('the archive lists it; delete permanently is refused while access rows remain, allowed once empty; restore brings the status back', async () => {
    await put({ dataset: 'jobs', mode: 'merge', survivorId: 'j-keep', loserId: 'j-dup' });
    const list = await req('GET', '/api/admin/organizations/me?view=buildertrend-archive', ADMIN);
    const entry = list.json.archive.find((a) => a.id === 'j-dup');
    expect(entry).toMatchObject({ kind: 'jobs', reason: 'merged', deletable: false });
    expect(entry.mergedInto.label).toBe('S1050 Harbor Club Railings');
    expect(entry.attached).toEqual({ job_access: 1 });
    const refused = await put({ dataset: 'jobs', mode: 'delete', p86Id: 'j-dup' });
    expect(refused.json.results[0].outcome).toBe('skipped');
    expect(one("SELECT COUNT(*) AS n FROM jobs WHERE id = 'j-dup'").n).toBe(1);
    run("DELETE FROM job_access WHERE job_id = 'j-dup'");
    const deleted = await put({ dataset: 'jobs', mode: 'delete', p86Id: 'j-dup' });
    expect(deleted.json.results[0].outcome).toBe('deleted');
    expect(one("SELECT COUNT(*) AS n FROM jobs WHERE id = 'j-dup'").n).toBe(0);
  });

  test('restore puts a merged copy back with its previous status', async () => {
    await put({ dataset: 'jobs', mode: 'merge', survivorId: 'j-keep', loserId: 'j-dup' });
    const r = await put({ dataset: 'jobs', mode: 'restore', p86Id: 'j-dup' });
    expect(r.json.results[0].outcome).toBe('restored');
    expect(one("SELECT bt_archived_at FROM jobs WHERE id = 'j-dup'").bt_archived_at).toBeNull();
    expect(jobData('j-dup').status).toBe('In Progress');
  });

  test('refused: an unlinked survivor, a linked loser, crew data, another organization, itself', async () => {
    const ask = async (body) => (await put(body)).json.results[0];
    expect((await ask({ dataset: 'jobs', mode: 'merge', survivorId: 'j-only', loserId: 'j-dup' })).reason).toMatch(/link this one first/);
    expect((await ask({ dataset: 'jobs', mode: 'merge', survivorId: 'j-dup', loserId: 'j-keep' })).reason).toMatch(/link this one first/);
    run("UPDATE jobs SET bt_job_id = '222' WHERE id = 'j-only'");
    expect((await ask({ dataset: 'jobs', mode: 'merge', survivorId: 'j-keep', loserId: 'j-only' })).reason).toMatch(/linked to a Buildertrend record of its own/);
    expect((await ask({ dataset: 'jobs', mode: 'merge', survivorId: 'j-keep', loserId: 'j-crew' })).reason).toMatch(/buildings/);
    expect((await ask({ dataset: 'jobs', mode: 'merge', survivorId: 'j-keep', loserId: 'j-other' })).reason).toMatch(/of this organization/);
    expect((await ask({ dataset: 'jobs', mode: 'merge', survivorId: 'j-keep', loserId: 'j-keep' })).reason).toMatch(/into itself/);
    expect(one("SELECT COUNT(*) AS n FROM jobs WHERE bt_archived_at IS NOT NULL").n).toBe(0);
    expect(one("SELECT job_id FROM job_change_orders WHERE id = 'co1'").job_id).toBe('j-dup');
  });
});

describe('merge a duplicate client and a duplicate lead', () => {
  test('client: leads, jobs (column and blob), estimates, child properties and files move to the kept client', async () => {
    const r = await put({ dataset: 'clients', mode: 'merge', survivorId: 'c-keep', loserId: 'c-dup' });
    expect(r.json.results[0].outcome).toBe('merged');
    expect(q("SELECT id FROM leads WHERE client_id = 'c-keep' ORDER BY id").map((x) => x.id)).toEqual(['l-dup', 'l-keep']);
    expect(one("SELECT client_id FROM jobs WHERE id = 'j-keep'").client_id).toBe('c-keep');
    expect(jobData('j-keep')).toMatchObject({ clientId: 'c-keep', client: 'Greystar - Summerall' });
    expect(JSON.parse(one("SELECT data FROM estimates WHERE id = 'e1'").data)).toMatchObject({ clientId: 'c-keep', client: 'Greystar - Summerall' });
    expect(one("SELECT parent_client_id FROM clients WHERE id = 'c-prop'").parent_client_id).toBe('c-keep');
    expect(one("SELECT entity_id FROM attachments WHERE id = 'a-client'").entity_id).toBe('c-keep');
    expect(one("SELECT bt_archive_reason, bt_merged_into FROM clients WHERE id = 'c-dup'")).toEqual({ bt_archive_reason: 'merged', bt_merged_into: 'c-keep' });
    expect(one("SELECT bt_archived_at FROM clients WHERE id = 'c-other'").bt_archived_at).toBeNull();
  });

  test('lead: jobs, estimates and the survey graph move; the archived lead leaves the leads list', async () => {
    const r = await put({ dataset: 'leads', mode: 'merge', survivorId: 'l-keep', loserId: 'l-dup' });
    expect(r.json.results[0].outcome).toBe('merged');
    expect(one("SELECT lead_id FROM jobs WHERE id = 'j-dup'").lead_id).toBe('l-keep');
    expect(JSON.parse(one("SELECT data FROM estimates WHERE id = 'e1'").data).lead_id).toBe('l-keep');
    expect(one('SELECT lead_id FROM lead_graphs').lead_id).toBe('l-keep');
    const list = await req('GET', '/api/leads', ADMIN);
    expect(list.status).toBe(200);
    const ids = (Array.isArray(list.json) ? list.json : list.json.leads || []).map((x) => x.id);
    expect(ids).toContain('l-keep');
    expect(ids).not.toContain('l-dup');
  });
});

describe('archive a P86-only record', () => {
  test('a job gets status Archived and restores to its previous status; a client leaves the client list', async () => {
    const r = await put({ dataset: 'jobs', mode: 'archive', p86Id: 'j-only' });
    expect(r.json.results[0].outcome).toBe('archived');
    expect(jobData('j-only')).toMatchObject({ status: 'Archived', btArchivedFromStatus: 'On Hold' });
    await put({ dataset: 'jobs', mode: 'restore', p86Id: 'j-only' });
    expect(jobData('j-only').status).toBe('On Hold');

    await put({ dataset: 'clients', mode: 'archive', p86Id: 'c-only' });
    const clients = await req('GET', '/api/clients', ADMIN);
    const ids = (Array.isArray(clients.json) ? clients.json : clients.json.clients || []).map((x) => x.id);
    expect(ids).not.toContain('c-only');
    expect(ids).toContain('c-keep');
    // Deletable: nothing is attached to it.
    expect((await put({ dataset: 'clients', mode: 'delete', p86Id: 'c-only' })).json.results[0].outcome).toBe('deleted');
  });

  test('leads and Buildertrend-linked records are not archived from here; the preview never matches an archived record', async () => {
    expect((await put({ dataset: 'leads', mode: 'archive', p86Id: 'l-only' })).json.results[0].reason).toMatch(/open leads only/);
    expect((await put({ dataset: 'jobs', mode: 'archive', p86Id: 'j-keep' })).json.results[0].reason).toMatch(/linked to Buildertrend/);
    await put({ dataset: 'jobs', mode: 'archive', p86Id: 'j-only' });
    const p86 = await preview.readP86(engine.pool, AGX);
    expect(p86.jobs.map((j) => j.id)).not.toContain('j-only');
  });
});

describe('gates', () => {
  test('a PM and another organization\'s admin can neither merge nor read the archive', async () => {
    expect((await put({ dataset: 'jobs', mode: 'merge', survivorId: 'j-keep', loserId: 'j-dup' }, PM)).status).toBe(403);
    expect((await put({ dataset: 'jobs', mode: 'merge', survivorId: 'j-keep', loserId: 'j-dup' }, OTHER_ADMIN)).status).toBe(403);
    expect((await req('GET', '/api/admin/organizations/me?view=buildertrend-archive', OTHER_ADMIN)).status).toBe(403);
    expect(one("SELECT job_id FROM job_change_orders WHERE id = 'co1'").job_id).toBe('j-dup');
  });
});
