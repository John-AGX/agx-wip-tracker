// Buildertrend preview → APPLY. The write half: link confident matches by
// Buildertrend id and apply the non-money corrections an admin chose.
//
// Driven through the real express router (PUT /api/admin/organizations/me
// ?action=buildertrend-apply), real requireAuth / requireOrg / ROLES_MANAGE,
// a JWT, and the pg-sqlite engine with every table derived from server/db.js.
// Clickr is a stub serving real-shape records (see test/clickr-sync-preview.test.js).

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema, tableNames } = require('./helpers/db-schema');

const engine = createPgSqlite(
  sqliteSchema(tableNames(), { pk: { organizations: 'id', users: 'id', roles: 'name', jobs: 'id', leads: 'id', clients: 'id', job_change_orders: 'id' } }),
  { jsonColumns: ['data'] }
);
globalThis.__P86_CLICKR_APPLY_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_CLICKR_APPLY_ENGINE__.pool }));
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});
jest.mock('../server/geocoder', () => ({ geocodeAddress: async () => null, geocodeViaGoogle: async () => null, geocodeViaCensus: async () => null }));

const { DATASETS } = require('../server/services/clickr/field-map');
const match = require('../server/services/clickr/bt-match');
const { readRecord } = require('../server/services/clickr/field-map');
const preview = require('../server/services/clickr/sync-preview');
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const orgRoutes = require('../server/routes/admin-organizations-routes');

const KEY = 'ck_live_Zq9SECRETKEYxy7_0123456789ab';
const BASE = 'https://api.clickr.cloud';
const AGX = 1;
const OTHER = 2;

let seq = 0;
function jobRec(jobName, o) {
  o = o || {};
  seq++;
  return {
    _id: 'clickr' + seq, jobId: o.jobId != null ? o.jobId : 50000000 + seq, jobName,
    jobStatus: o.jobStatus === undefined ? 'Open' : o.jobStatus,
    street: o.street === undefined ? '' : o.street, city: o.city === undefined ? 'Tampa' : o.city,
    state: 'FL', zip: '33602', projectedStart: o.projectedStart === undefined ? null : o.projectedStart, projectedCompletion: null,
    contractPrice: o.contractPrice === undefined ? { value: 0, scale: 2 } : o.contractPrice,
    approvedCOPrice: { value: 0, scale: 2 }, projectManager: [], contacts: [], customFields: [],
    jobType: 'Handyman Services', groups: ['Service & Repair'], createdDate: '2025-01-02T15:00:00.000Z', isDeleted: false,
  };
}
function leadRec(title, o) {
  o = o || {};
  seq++;
  return {
    _id: 'clickr' + seq, leadId: o.leadId != null ? o.leadId : 60000000 + seq, opportunityTitle: title,
    opportunityStreet: o.street || '', opportunityCity: 'Tampa', opportunityState: 'FL', opportunityZip: '33602',
    contactId: o.contactId != null ? o.contactId : 8000 + seq, contactName: o.contactName || '',
    salesperson: o.salesperson === undefined ? '' : o.salesperson, projectType: 'Service & Repair',
    source: o.source || '', confidence: o.confidence || 0, estimatedRevenueMin: o.min || 0, estimatedRevenueMax: o.max || 0,
    notes: '', createdDate: '2026-04-03T12:00:00.000Z',
  };
}

const BT_JOBS = [
  jobRec('S1050 Harbor Club Railings', { jobId: 111, street: '1 Harbor Dr', projectedStart: '2026-02-25T00:00:00', contractPrice: { value: 15000, scale: 2 } }),
  jobRec('S2000 Waterside Siding', { jobId: 222, street: '5 Bay Rd', projectedStart: '2026-03-01T00:00:00' }),
  jobRec('WO16 Service Call A', { jobId: 333 }),
  jobRec('WO16 Service Call B', { jobId: 334 }),
  jobRec('S4000 Brand New Job', { jobId: 444, street: '9 New St' }),
];
const BT_LEADS = [
  leadRec('Gazebo at Oak Hollow', { leadId: 555, street: '12 Oak Hollow Dr', contactId: 9001, contactName: 'Oak Hollow HOA',
    salesperson: 'Ana Ruiz', source: 'Previous Client', confidence: 50, min: 17900, max: 17900 }),
];

function clickrFetch(url) {
  const u = new URL(url);
  if (u.origin !== BASE) throw new Error('test: fetch reached a non-Clickr host');
  const skip = Number(u.searchParams.get('skip') || 0);
  const limit = Number(u.searchParams.get('limit') || 200);
  const list = u.pathname.includes(DATASETS.jobs.datasetId) ? BT_JOBS : u.pathname.includes(DATASETS.leads.datasetId) ? BT_LEADS : null;
  if (!list) return Promise.resolve({ status: 404, text: async () => '{"error":"Route not found"}' });
  const body = { recordType: 'x', columns: [], records: list.slice(skip, skip + limit), count: list.length, sort: {} };
  return Promise.resolve({ status: 200, text: async () => JSON.stringify(body) });
}

function seed() {
  engine.db.exec(`
    DELETE FROM jobs; DELETE FROM leads; DELETE FROM clients; DELETE FROM users; DELETE FROM roles; DELETE FROM organizations;
    DELETE FROM job_change_orders;
    INSERT INTO organizations (id, slug, name) VALUES (1, 'agx', 'AGX Central Florida'), (2, 'other', 'Other Builders');
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ROLES_MANAGE","USERS_MANAGE","JOBS_VIEW_ALL"]'),
      ('pm', 'PM', '["JOBS_VIEW_ALL","LEADS_VIEW"]');
    INSERT INTO users (id, email, password_hash, name, role, organization_id, active) VALUES
      (10, 'admin@agx.test', 'x', 'Ana Ruiz', 'admin', 1, 1),
      (11, 'pm@agx.test', 'x', 'Pat PM', 'pm', 1, 1),
      (20, 'admin@other.test', 'x', 'Oscar Other', 'admin', 2, 1);
    INSERT INTO clients (id, name, organization_id) VALUES ('c-a', 'Oak Hollow HOA', 1), ('c-b', 'Oak Hollow HOA', 2);
  `);
  const job = engine.db.prepare('INSERT INTO jobs (id, owner_id, organization_id, data) VALUES (?,?,?,?)');
  job.run('j-1', 10, AGX, JSON.stringify({ jobNumber: 'S1050', title: 'Harbor Club Railings', status: 'In Progress', street_address: '1 Harbor Dr', city: 'Tampa', state: 'FL', zip: '33602', contractAmount: 12000 }));
  job.run('j-2', 10, AGX, JSON.stringify({ jobNumber: 'S2000', title: 'Waterside Siding', status: 'In Progress', street_address: '', city: 'Tampa', state: 'FL', zip: '33602', startDate: '2026-01-10' }));
  job.run('j-3', 10, AGX, JSON.stringify({ jobNumber: 'WO16', title: 'Service Call A', status: 'In Progress' }));
  job.run('j-b', 20, OTHER, JSON.stringify({ jobNumber: 'S1050', title: 'Harbor Club Railings', status: 'In Progress', street_address: '1 Harbor Dr', city: 'Tampa', state: 'FL', zip: '33602' }));
  const lead = engine.db.prepare('INSERT INTO leads (id, title, status, client_id, salesperson_id, organization_id, street_address, city, state, zip, estimated_revenue_low, estimated_revenue_high, source, confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  lead.run('l-1', 'Gazebo at Oak Hollow', 'sent', 'c-a', 10, AGX, '12 Oak Hollow Dr', 'Tampa', 'FL', '33602', 10000, 12000, null, null);
  lead.run('l-b', 'Gazebo at Oak Hollow', 'sent', 'c-b', 20, OTHER, '12 Oak Hollow Dr', 'Tampa', 'FL', '33602', 5, 5, null, null);
}

const jobData = (id) => JSON.parse(engine.db.prepare('SELECT data FROM jobs WHERE id = ?').get(id).data);
const jobBt = (id) => engine.db.prepare('SELECT bt_job_id FROM jobs WHERE id = ?').get(id).bt_job_id;
const leadRow = (id) => engine.db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

let server;
let baseUrl;
const origFetch = global.fetch;

function put(pathname, user, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(baseUrl + pathname, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        user ? { Authorization: 'Bearer ' + signToken(user) } : {}),
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json, text: buf }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const APPLY = '/api/admin/organizations/me?action=buildertrend-apply';
const ADMIN = { id: 10, email: 'admin@agx.test', name: 'Ana Ruiz', role: 'admin', organization_id: AGX };
const PM = { id: 11, email: 'pm@agx.test', name: 'Pat PM', role: 'pm', organization_id: AGX };
const OTHER_ADMIN = { id: 20, email: 'admin@other.test', name: 'Oscar Other', role: 'admin', organization_id: OTHER };

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

describe('safe updates — link every confident match, fill a BLANK start date, nothing else', () => {
  test('links S1050 and S2000, fills only the start date P86 lacked, leaves every other field and every other tenant alone', async () => {
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect(r.status).toBe(200);
    expect(jobBt('j-1')).toBe('111');
    expect(jobBt('j-2')).toBe('222');
    expect(jobData('j-1').startDate).toBe('2026-02-25');
    // P86 already had a start date: Buildertrend's never replaces it.
    expect(jobData('j-2').startDate).toBe('2026-01-10');
    // Safe mode applies no other correction (S2000's blank street stays blank).
    expect(jobData('j-2').street_address).toBe('');
    // Money is never written.
    expect(jobData('j-1').contractAmount).toBe(12000);
    // Ambiguous (shared WO16), new (S4000) and the other tenant's twin: untouched.
    expect(jobBt('j-3')).toBeNull();
    expect(jobBt('j-b')).toBeNull();
    expect(jobData('j-b').startDate).toBeUndefined();
    expect(r.json.counts.applied).toBe(2);
  });

  test('running it again changes nothing', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    preview.forgetFetch(AGX);
    const again = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect(again.status).toBe(200);
    expect(again.json.counts.applied).toBe(0);
    expect(again.json.counts.unchanged).toBe(2);
  });
});

describe('per-record apply', () => {
  test('applies every non-money correction shown for that row, rebuilds the address line, links the id', async () => {
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['222'] });
    expect(r.status).toBe(200);
    const d = jobData('j-2');
    expect(d.street_address).toBe('5 Bay Rd');
    expect(d.address).toBe('5 Bay Rd, Tampa, FL, 33602');
    expect(d.startDate).toBe('2026-01-10');
    expect(jobBt('j-2')).toBe('222');
    expect(jobBt('j-1')).toBeNull();
    const res = r.json.results.find((x) => x.btId === '222');
    expect(res.outcome).toBe('applied');
    expect(res.fields.map((f) => f.field)).toEqual(['street']);
  });

  test('an ambiguous, a new and an unknown id are skipped with a reason and write nothing', async () => {
    const before = engine.db.prepare('SELECT id, data, bt_job_id FROM jobs ORDER BY id').all();
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['333', '444', '999'] });
    expect(r.status).toBe(200);
    expect(r.json.results.map((x) => x.outcome)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(engine.db.prepare('SELECT id, data, bt_job_id FROM jobs ORDER BY id').all()).toEqual(before);
  });

  test('a P86 job already linked to another Buildertrend job is never re-linked', async () => {
    engine.db.prepare("UPDATE jobs SET bt_job_id = '777' WHERE id = 'j-1'").run();
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'] });
    expect(r.status).toBe(200);
    expect(jobBt('j-1')).toBe('777');
    expect(jobData('j-1').startDate).toBeUndefined();
  });

  test('leads: source and confidence applied, lead and client ids stamped, revenue untouched, other tenant untouched', async () => {
    const r = await put(APPLY, ADMIN, { dataset: 'leads', btIds: ['555'] });
    expect(r.status).toBe(200);
    const l = leadRow('l-1');
    expect(l.source).toBe('Previous Client');
    expect(Number(l.confidence)).toBe(50);
    expect(l.bt_lead_id).toBe('555');
    expect(Number(l.estimated_revenue_low)).toBe(10000);
    expect(Number(l.estimated_revenue_high)).toBe(12000);
    expect(engine.db.prepare("SELECT bt_contact_id FROM clients WHERE id = 'c-a'").get().bt_contact_id).toBe('9001');
    expect(engine.db.prepare("SELECT bt_contact_id FROM clients WHERE id = 'c-b'").get().bt_contact_id).toBeNull();
    expect(leadRow('l-b').bt_lead_id).toBeNull();
    expect(leadRow('l-b').source).toBeNull();
  });
});

describe('once linked, the Buildertrend id is the match', () => {
  test('a renumbered, renamed P86 job is still found by id, and a linked job is never another row\'s candidate', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    const d = jobData('j-1');
    d.jobNumber = 'X9999';
    d.title = 'Something Else Entirely';
    engine.db.prepare("UPDATE jobs SET data = ? WHERE id = 'j-1'").run(JSON.stringify(d));
    const p86 = await preview.readP86(engine.pool, AGX);
    const rows = match.matchJobs(BT_JOBS.map((x) => readRecord('jobs', x)), p86.jobs, { coTotals: p86.coTotals });
    const row = rows.find((x) => String(x.bt.btId) === '111');
    expect(['matched', 'conflict']).toContain(row.class);
    expect(row.rung).toBe('Buildertrend ID');
    expect(row.p86.id).toBe('j-1');
    // A different Buildertrend row naming S1050 cannot reach the linked job.
    const probe = match.matchJobs([readRecord('jobs', jobRec('S1050 Harbor Club Railings', { jobId: 888, street: '1 Harbor Dr' }))], p86.jobs, { coTotals: p86.coTotals })[0];
    expect(probe.p86 && probe.p86.id).not.toBe('j-1');
    expect((probe.candidates || []).map((c) => c.id)).not.toContain('j-1');
  });
});

describe('gates', () => {
  test('a user without ROLES_MANAGE is refused and nothing is written', async () => {
    const r = await put(APPLY, PM, { dataset: 'jobs', mode: 'safe' });
    expect(r.status).toBe(403);
    expect(jobBt('j-1')).toBeNull();
  });

  test('an admin of another organization is refused and nothing is written in either tenant', async () => {
    const r = await put(APPLY, OTHER_ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('CLICKR_NOT_THIS_ORG');
    expect(jobBt('j-1')).toBeNull();
    expect(jobBt('j-b')).toBeNull();
  });

  test('only /me, only jobs or leads, and ids are required per record', async () => {
    expect((await put('/api/admin/organizations/1?action=buildertrend-apply', ADMIN, { dataset: 'jobs', mode: 'safe' })).status).toBe(400);
    expect((await put(APPLY, ADMIN, { dataset: 'estimates', mode: 'safe' })).status).toBe(400);
    expect((await put(APPLY, ADMIN, { dataset: 'jobs', btIds: [] })).status).toBe(400);
  });

  test('an incomplete Buildertrend read applies nothing', async () => {
    global.fetch = (url) => clickrFetch(url).then((res) => ({ status: 200, text: async () => {
      const b = JSON.parse(await res.text()); b.count = b.count + 5; return JSON.stringify(b);
    } }));
    try {
      const r = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
      expect(r.status).toBe(409);
      expect(jobBt('j-1')).toBeNull();
    } finally {
      global.fetch = clickrFetch;
    }
  });
});

describe('PAGE — Apply buttons appear only where an apply can do something', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'bt-sync-preview.js'), 'utf8');
  const win = {};
  vm.runInNewContext(src, { window: win, document: {}, console });
  const T = win.p86BtSyncPreview._test;
  const XSS = '"><img src=x onerror=alert(1)>';
  const baseRow = (cls, extra) => Object.assign({ bt: { btId: '111', raw: 'S1050 Harbor', title: 'Harbor', scope: 'open' }, class: cls, rung: 'number',
    p86: { id: 'j-1', jobNumber: 'S1050', title: 'Harbor' }, corrections: [], btBlank: [], heldBack: [], flags: [], candidates: [], notes: [] }, extra || {});
  const data = (rows, complete) => ({
    generatedAt: new Date().toISOString(), elapsedMs: 1, organization: { name: 'AGX' }, p86: { jobs: 1, leads: 0 },
    datasets: {
      jobs: { key: 'jobs', label: 'Jobs', classified: true, fetch: { fetched: rows.length, reportedCount: rows.length, complete: complete !== false }, rows,
        sentence: 'ok', notInBuildertrend: { rows: [], count: 0, reliable: true, sentence: '' }, summary: {} },
      leads: { key: 'leads', label: 'Leads', classified: true, fetch: { fetched: 0, reportedCount: 0, complete: true }, rows: [], sentence: 'ok',
        notInBuildertrend: { rows: [], count: 0, reliable: true, sentence: '' }, summary: {} },
    },
  });

  test('a corrected row offers "Apply N changes + link"; a same row offers "Link"; a linked row with nothing to do says Linked', () => {
    const html = T.render(data([
      baseRow('conflict', { corrections: [{ field: 'startDate', kind: 'fill', from: '', to: '2026-02-25' }] }),
      baseRow('matched', { bt: { btId: '222', raw: 'S2000', title: 'W', scope: 'open' } }),
      baseRow('matched', { bt: { btId: '333', raw: 'S3000', title: 'X', scope: 'open' }, rung: 'Buildertrend ID' }),
    ]));
    expect(html).toContain('data-btp-apply="111"');
    expect(html).toContain('Apply 1 change + link');
    expect(html).toContain('data-btp-apply="222"');
    expect(html).not.toContain('data-btp-apply="333"');
    expect(html).toContain('>Linked<');
    // Safe button counts the two unlinked confident rows.
    expect(html).toMatch(/Link confident matches \+ fill blank start dates \(2\)/);
  });

  test('ambiguous, new and possible-duplicate rows get no button; a partial read disables the safe button', () => {
    const html = T.render(data([baseRow('ambiguous', { p86: null }), baseRow('new', { p86: null }), baseRow('possible_duplicate', { p86: null })], false));
    expect(html).not.toContain('data-btp-apply="');
    expect(html).toMatch(/data-btp-apply-safe="1" disabled/);
  });

  test('a hostile Buildertrend id is escaped in the button attribute', () => {
    const html = T.render(data([baseRow('matched', { bt: { btId: XSS, raw: 'S1', title: 'x', scope: 'open' } })]));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('data-btp-apply="&quot;&gt;&lt;img');
  });
});
