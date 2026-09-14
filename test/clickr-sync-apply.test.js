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
    approvedCOPrice: o.approvedCOPrice === undefined ? { value: 0, scale: 2 } : o.approvedCOPrice, projectManager: [], contacts: o.contacts || [], customFields: [],
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
  jobRec('S1050 Harbor Club Railings', { jobId: 111, street: '1 Harbor Dr', projectedStart: '2026-02-25T00:00:00', contractPrice: { value: 15000, scale: 2 }, approvedCOPrice: { value: 2500, scale: 2 } }),
  jobRec('S2000 Waterside Siding', { jobId: 222, street: '5 Bay Rd', projectedStart: '2026-03-01T00:00:00' }),
  jobRec('WO16 Service Call A', { jobId: 333 }),
  jobRec('WO16 Service Call B', { jobId: 334 }),
  jobRec('S4000 Brand New Job', { jobId: 444, street: '9 New St', projectedStart: '2026-05-04T00:00:00', contractPrice: { value: 48250.5, scale: 2 }, contacts: [{ id: 9001, name: 'Oak Hollow HOA' }] }),
  jobRec('RV5001 Closed History Job', { jobId: 445, jobStatus: 'Closed', street: '1 Old Rd' }),
  jobRec('WO9001 Warranty Callback', { jobId: 446, jobStatus: 'Warranty', street: '2 Callback Ln' }),
];
const BT_LEADS = [
  leadRec('Gazebo at Oak Hollow', { leadId: 555, street: '12 Oak Hollow Dr', contactId: 9001, contactName: 'Oak Hollow HOA',
    salesperson: 'Ana Ruiz', source: 'Previous Client', confidence: 50, min: 17900, max: 17900 }),
  leadRec('Brand New Opportunity', { leadId: 556, street: '77 Fresh Way', contactId: 9001, contactName: 'Oak Hollow HOA', salesperson: 'Ana Ruiz', source: 'Referral', confidence: 40 }),
];

function clientRec(displayName, o) {
  o = o || {};
  seq++;
  return { _id: 'clickr' + seq, contactId: o.contactId != null ? o.contactId : 70000000 + seq, displayName,
    firstName: null, lastName: null, primaryEmail: o.email || '', email: o.email || '', emails: o.email ? [o.email] : [],
    phone: o.phone || '', cell: '', street: o.street || '', city: o.city || '', state: o.state || '', zip: o.zip || '',
    jobCount: 1, leadCount: 1, activationStatus: 0, customFields: [] };
}
const BT_CLIENTS = [
  clientRec('Oak Hollow HOA', { contactId: 9001, email: 'board@oakhollow.test', phone: '(813) 555-0100', street: '12 Oak Hollow Dr', city: 'Tampa', state: 'FL', zip: '33602' }),
  clientRec('Harbor Club Board', { contactId: 9002, email: 'mgr@harbor.test' }),
  clientRec('Jane Smith', { contactId: 9003 }),
  clientRec('Jane Smith', { contactId: 9004 }),
  clientRec('Bay Pointe Condos', { contactId: 9005, email: 'new@baypointe.test' }),
  clientRec('Totally Different LLC', { contactId: 9006, email: 'shared@ridgewood.test' }),
  clientRec('Seaside Towers Association', { contactId: 9007, email: 'office@seaside.test', phone: '727-555-0142', street: '400 Gulf Blvd', city: 'Clearwater', state: 'FL', zip: '33767' }),
];

function clickrFetch(url) {
  const u = new URL(url);
  if (u.origin !== BASE) throw new Error('test: fetch reached a non-Clickr host');
  const skip = Number(u.searchParams.get('skip') || 0);
  const limit = Number(u.searchParams.get('limit') || 200);
  const list = u.pathname.includes(DATASETS.jobs.datasetId) ? BT_JOBS : u.pathname.includes(DATASETS.leads.datasetId) ? BT_LEADS
    : u.pathname.includes(DATASETS.clients.datasetId) ? BT_CLIENTS : null;
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
    INSERT INTO clients (id, name, email, organization_id) VALUES
      ('c-h', 'Harbor Club Board of Directors', 'mgr@harbor.test', 1),
      ('c-j', 'Jane Smith', NULL, 1),
      ('c-bp', 'Bay Pointe Condos', 'old@baypointe.test', 1),
      ('c-r', 'Ridgewood Estates', 'shared@ridgewood.test', 1);
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


describe('choosing what applies — ticked fields, contract price, job number, lead revenue', () => {
  test('a fields list applies only what is ticked; an empty list links only', async () => {
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['222'], fields: [] });
    expect(r.status).toBe(200);
    expect(jobBt('j-2')).toBe('222');
    expect(jobData('j-2').street_address).toBe('');
  });

  test('Buildertrend contract price applies when ticked (BT is the source of truth); safe mode never touches it', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect(jobData('j-1').contractAmount).toBe(12000);
    preview.forgetFetch(AGX);
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'], fields: ['contractPrice'] });
    expect(r.status).toBe(200);
    expect(jobData('j-1').contractAmount).toBe(15000);
    expect(r.json.results[0].fields).toEqual([{ field: 'contractPrice', from: '$12,000.00', to: '$15,000.00' }]);
  });

  test('without a fields list, per-record apply includes the contract correction but never a held-back item', async () => {
    const d = jobData('j-1'); d.jobNumber = ''; engine.db.prepare("UPDATE jobs SET data = ? WHERE id = 'j-1'").run(JSON.stringify(d));
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'] });
    expect(r.status).toBe(200);
    expect(jobData('j-1').contractAmount).toBe(15000);
    expect(jobData('j-1').jobNumber).toBe('');
  });

  test('the job number applies only when ticked, and never onto a number another P86 job carries', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    const d = jobData('j-1'); d.jobNumber = 'X9999'; engine.db.prepare("UPDATE jobs SET data = ? WHERE id = 'j-1'").run(JSON.stringify(d));
    preview.forgetFetch(AGX);
    const untouched = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'], fields: ['contractPrice'] });
    expect(untouched.status).toBe(200);
    expect(jobData('j-1').jobNumber).toBe('X9999');
    preview.forgetFetch(AGX);
    const renum = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'], fields: ['jobNumber'] });
    expect(renum.status).toBe(200);
    expect(jobData('j-1').jobNumber).toBe('S1050');

    // A clash: another job already carries the number Buildertrend has.
    const d2 = jobData('j-1'); d2.jobNumber = 'X9999'; engine.db.prepare("UPDATE jobs SET data = ? WHERE id = 'j-1'").run(JSON.stringify(d2));
    const d3 = jobData('j-3'); d3.jobNumber = 'S1050'; engine.db.prepare("UPDATE jobs SET data = ? WHERE id = 'j-3'").run(JSON.stringify(d3));
    preview.forgetFetch(AGX);
    const clash = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'], fields: ['jobNumber'] });
    expect(clash.status).toBe(200);
    expect(jobData('j-1').jobNumber).toBe('X9999');
    expect(clash.json.results[0].stale.join(' ')).toMatch(/another P86 job already uses S1050/);
  });

  test('lead revenue applies only when ticked; approved change orders can never be applied', async () => {
    const r1 = await put(APPLY, ADMIN, { dataset: 'leads', btIds: ['555'], fields: ['source'] });
    expect(r1.status).toBe(200);
    expect(Number(leadRow('l-1').estimated_revenue_high)).toBe(12000);
    preview.forgetFetch(AGX);
    const r2 = await put(APPLY, ADMIN, { dataset: 'leads', btIds: ['555'], fields: ['estimatedRevenueMax', 'estimatedRevenueMin'] });
    expect(r2.status).toBe(200);
    expect(Number(leadRow('l-1').estimated_revenue_high)).toBe(17900);
    expect(Number(leadRow('l-1').estimated_revenue_low)).toBe(17900);
    const p86 = await preview.readP86(engine.pool, AGX);
    const rows = match.matchJobs(BT_JOBS.map((x) => readRecord('jobs', x)), p86.jobs, { coTotals: p86.coTotals });
    const s1050 = rows.find((x) => String(x.bt.btId) === '111');
    // Not vacuous: the row really carries an approved-change-order difference.
    expect(s1050.heldBack.map((h) => h.field)).toContain('approvedCOPrice');
    const sa = require('../server/services/clickr/sync-apply');
    expect(sa.pickedHeldBack('jobs', s1050, 'rows', ['approvedCOPrice'])).toEqual([]);
    preview.forgetFetch(AGX);
    const r3 = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'], fields: ['approvedCOPrice'] });
    expect(r3.status).toBe(200);
    expect(r3.json.results[0].fields || []).toEqual([]);
  });
});


describe('clients — matched by id, name or a unique email; P86 names kept; blanks filled; a different value only when ticked', () => {
  const clientRow = (id) => engine.db.prepare('SELECT * FROM clients WHERE id = ?').get(id);

  test('the matcher: exact name, email + agreeing name, shared BT name ambiguous, a different email held back', async () => {
    const p86 = await preview.readP86(engine.pool, AGX);
    const rows = match.matchClients(BT_CLIENTS.map((x) => readRecord('clients', x)), p86.clients);
    const by = (id) => rows.find((r) => String(r.bt.btId) === id);
    expect(by('9001')).toMatchObject({ class: 'conflict', rung: 'name' });
    expect(by('9001').p86.id).toBe('c-a');
    expect(by('9001').corrections.map((c) => c.field).sort()).toEqual(['city', 'email', 'phone', 'state', 'street', 'zip']);
    expect(by('9002')).toMatchObject({ class: 'matched', rung: 'email + similar name' });
    expect(by('9002').notes.join(' ')).toMatch(/P86 keeps its own client name/);
    expect(by('9003').class).toBe('ambiguous');
    expect(by('9004').class).toBe('ambiguous');
    // Only the email matches and the names share nothing: never confident.
    expect(by('9006').class).toBe('ambiguous');
    expect(by('9006').candidates.map((c) => c.id)).toContain('c-r');
    expect(by('9005').heldBack).toEqual([expect.objectContaining({ field: 'email', p86: 'old@baypointe.test', bt: 'new@baypointe.test', applicable: true })]);
    // The other tenant's same-named client is never a candidate.
    expect(JSON.stringify(rows)).not.toContain('c-b"');
  });

  test('apply fills blanks and links; the name is never written; the other tenant is untouched', async () => {
    const r = await put(APPLY, ADMIN, { dataset: 'clients', btIds: ['9001'] });
    expect(r.status).toBe(200);
    const c = clientRow('c-a');
    expect(c.email).toBe('board@oakhollow.test');
    expect(c.address).toBe('12 Oak Hollow Dr');
    expect(c.bt_contact_id).toBe('9001');
    expect(c.name).toBe('Oak Hollow HOA');
    expect(clientRow('c-b').email).toBeNull();
    expect(clientRow('c-b').bt_contact_id).toBeNull();
  });

  test('a different P86 email changes only when ticked', async () => {
    const r1 = await put(APPLY, ADMIN, { dataset: 'clients', btIds: ['9005'], fields: [] });
    expect(r1.status).toBe(200);
    expect(clientRow('c-bp').email).toBe('old@baypointe.test');
    expect(clientRow('c-bp').bt_contact_id).toBe('9005');
    preview.forgetFetch(AGX);
    const r2 = await put(APPLY, ADMIN, { dataset: 'clients', btIds: ['9005'], fields: ['email'] });
    expect(r2.status).toBe(200);
    expect(clientRow('c-bp').email).toBe('new@baypointe.test');
  });

  test('safe mode links confident clients only and writes no field', async () => {
    const r = await put(APPLY, ADMIN, { dataset: 'clients', mode: 'safe' });
    expect(r.status).toBe(200);
    expect(clientRow('c-a').bt_contact_id).toBe('9001');
    expect(clientRow('c-a').email).toBeNull();
    expect(clientRow('c-h').bt_contact_id).toBe('9002');
    expect(clientRow('c-j').bt_contact_id).toBeNull();
  });
});


describe('create — a Buildertrend-only record comes into P86 linked by its id', () => {
  const clientRow = (id) => engine.db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  const jobByBt = (bt) => engine.db.prepare('SELECT * FROM jobs WHERE bt_job_id = ?').get(bt);

  test('bulk client create makes only the "new" contacts, with their details and ids; names are Buildertrend\'s', async () => {
    const r = await put(APPLY, ADMIN, { dataset: 'clients', mode: 'create' });
    expect(r.status).toBe(200);
    const created = engine.db.prepare("SELECT * FROM clients WHERE bt_contact_id = '9007'").get();
    expect(created).toMatchObject({ name: 'Seaside Towers Association', email: 'office@seaside.test', address: '400 Gulf Blvd', city: 'Clearwater', organization_id: 1 });
    // Matched, ambiguous and possible-duplicate contacts are never created.
    expect(engine.db.prepare("SELECT COUNT(*) AS n FROM clients WHERE bt_contact_id IN ('9001','9002','9003','9004','9005','9006')").get().n).toBe(0);
    expect(r.json.counts.created).toBe(1);
  });

  test('bulk job create makes Open + Warranty jobs only: Buildertrend number, title, status, start, contract, type, client link', async () => {
    engine.db.prepare("UPDATE clients SET bt_contact_id = '9001' WHERE id = 'c-a'").run();
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'create' });
    expect(r.status).toBe(200);
    const j = jobByBt('444');
    const d = JSON.parse(j.data);
    expect(d).toMatchObject({ jobNumber: 'S4000', title: 'Brand New Job', status: 'In Progress', startDate: '2026-05-04',
      contractAmount: 48250.5, jobType: 'Service', clientId: 'c-a', client: 'Oak Hollow HOA', street_address: '9 New St' });
    expect(j.organization_id).toBe(1);
    expect(j.client_id).toBe('c-a');
    const w = JSON.parse(jobByBt('446').data);
    expect(w).toMatchObject({ jobNumber: 'WO9001', status: 'In Progress', btStatus: 'Warranty', jobType: 'Work Order' });
    // Closed history is not created in bulk; ambiguous WO16 rows never are.
    expect(jobByBt('445')).toBeUndefined();
    expect(jobByBt('333')).toBeUndefined();
    expect(engine.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE organization_id = 2").get().n).toBe(1);
  });

  test('a closed job is created on request, as Completed; running create again creates nothing twice', async () => {
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'create', btIds: ['445'] });
    expect(r.status).toBe(200);
    expect(JSON.parse(jobByBt('445').data)).toMatchObject({ jobNumber: 'RV5001', status: 'Completed', jobType: 'Renovation' });
    preview.forgetFetch(AGX);
    const again = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'create', btIds: ['445'] });
    expect(again.json.results[0].outcome).toBe('skipped');
    expect(engine.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE bt_job_id = '445'").get().n).toBe(1);
  });

  test('an existing, ambiguous or duplicate record is never created on request', async () => {
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'create', btIds: ['111', '333'] });
    expect(r.status).toBe(200);
    expect(r.json.results.map((x) => x.outcome)).toEqual(['skipped', 'skipped']);
    expect(jobByBt('111')).toBeUndefined();
    preview.forgetFetch(AGX);
    const c = await put(APPLY, ADMIN, { dataset: 'clients', mode: 'create', btIds: ['9003', '9002'] });
    expect(c.json.results.map((x) => x.outcome)).toEqual(['skipped', 'skipped']);
    expect(engine.db.prepare("SELECT COUNT(*) AS n FROM clients WHERE name = 'Jane Smith'").get().n).toBe(1);
  });

  test('lead create links the client by Buildertrend id and the salesperson by exact name; status new; revenue untouched', async () => {
    engine.db.prepare("UPDATE clients SET bt_contact_id = '9001' WHERE id = 'c-a'").run();
    const r = await put(APPLY, ADMIN, { dataset: 'leads', mode: 'create' });
    expect(r.status).toBe(200);
    const l = engine.db.prepare("SELECT * FROM leads WHERE bt_lead_id = '556'").get();
    expect(l).toMatchObject({ title: 'Brand New Opportunity', status: 'new', client_id: 'c-a', salesperson_id: 10, source: 'Referral', organization_id: 1 });
    expect(Number(l.confidence)).toBe(40);
    expect(l.estimated_revenue_low).toBeNull();
    // The matched lead 555 is not created again.
    expect(engine.db.prepare("SELECT COUNT(*) AS n FROM leads WHERE title = 'Gazebo at Oak Hollow' AND organization_id = 1").get().n).toBe(1);
  });

  test('a number P86 already uses on a job linked elsewhere is never created again', async () => {
    engine.db.prepare("UPDATE jobs SET bt_job_id = '999' WHERE id = 'j-1'").run();
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'create', btIds: ['111'] });
    expect(r.status).toBe(200);
    expect(r.json.results[0]).toMatchObject({ outcome: 'skipped' });
    expect(r.json.results[0].reason).toMatch(/already has a job numbered S1050/);
    expect(engine.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE organization_id = 1 AND data LIKE '%S1050%'").get().n).toBe(1);
  });

  test('a new job never links another organization\'s client that carries the same Buildertrend id', async () => {
    engine.db.prepare("UPDATE clients SET bt_contact_id = '9001' WHERE id = 'c-b'").run();
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'create', btIds: ['444'] });
    expect(r.status).toBe(200);
    const j = jobByBt('444');
    expect(j.client_id).toBeNull();
    expect(JSON.parse(j.data).clientId).toBeNull();
  });

  test('another organization\'s admin cannot create', async () => {
    const r = await put(APPLY, OTHER_ADMIN, { dataset: 'clients', mode: 'create' });
    expect(r.status).toBe(403);
    expect(engine.db.prepare("SELECT COUNT(*) AS n FROM clients WHERE bt_contact_id = '9007'").get().n).toBe(0);
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

  test('a corrected row offers "Apply N selected + link"; a same row offers "Link only"; a linked row with nothing to do says Linked', () => {
    T.resetPicks();
    const html = T.render(data([
      baseRow('conflict', { corrections: [{ field: 'startDate', kind: 'fill', from: '', to: '2026-02-25' }] }),
      baseRow('matched', { bt: { btId: '222', raw: 'S2000', title: 'W', scope: 'open' } }),
      baseRow('matched', { bt: { btId: '333', raw: 'S3000', title: 'X', scope: 'open' }, rung: 'Buildertrend ID' }),
    ]));
    expect(html).toContain('data-btp-apply="111"');
    expect(html).toContain('Apply 1 selected + link');
    expect(html).toContain('>Link only<');
    expect(html).toContain('data-btp-apply="222"');
    expect(html).not.toContain('data-btp-apply="333"');
    expect(html).toContain('>Linked<');
    // Safe button counts the two unlinked confident rows.
    expect(html).toMatch(/Link confident matches \+ fill blank start dates \(2\)/);
  });


  test('corrections start ticked, an applicable held-back item starts unticked, approved COs get no box, and only the active tab renders', () => {
    T.resetPicks();
    T.setTab('jobs');
    const html = T.render(data([
      baseRow('conflict', {
        corrections: [{ field: 'contractPrice', label: 'Contract price', kind: 'value', money: true, from: '$12,000.00', to: '$15,000.00', value: 15000, p86Value: 12000 }],
        heldBack: [{ field: 'jobNumber', label: 'Job number', reason: 'identity', bt: 'S1050', p86: 'X9', value: 'S1050', applicable: true },
          { field: 'approvedCOPrice', label: 'Approved change orders', reason: 'money', bt: '$2,500.00', p86: '$1,000.00', applicable: false }],
      }),
    ]));
    expect(html).toMatch(/data-btp-pick="contractPrice" data-btp-row="111" checked/);
    expect(html).toMatch(/data-btp-pick="jobNumber" data-btp-row="111"(?! checked)/);
    expect(html).not.toContain('data-btp-pick="approvedCOPrice"');
    expect(html).toContain('data-btp-tab="leads"');
    expect(html).toContain('data-btp-ds="jobs"');
    expect(html).not.toContain('data-btp-ds="leads"');
    T.setTab('leads');
    const leadsHtml = T.render(data([]));
    expect(leadsHtml).toContain('data-btp-ds="leads"');
    expect(leadsHtml).not.toContain('data-btp-ds="jobs"');
    T.setTab('jobs');
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
