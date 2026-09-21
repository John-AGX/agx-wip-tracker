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
    -- The journal is part of the world a test starts in: leaving runs behind
    -- would make every count in the undo suite depend on the file's order.
    DELETE FROM bt_sync_changes; DELETE FROM bt_sync_runs;
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
  job.run('j-near', 10, AGX, JSON.stringify({ jobNumber: 'S1051', title: 'Harbor Club Railing', status: 'In Progress', street_address: '', city: 'Tampa', state: 'FL', zip: '33602' }));
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


// J2. data.btStatus used to be stamped at CREATE and never touched again, and
// nothing read it: a job Buildertrend later moved to Warranty or Closed kept the
// word it was born with. Every apply and every link refreshes it — and it is the
// ONLY thing a status writes without a ticked box.
describe('what Buildertrend calls the job NOW (data.btStatus)', () => {
  test('every apply and every link writes it; data.status stays put', async () => {
    expect(jobData('j-1').btStatus).toBeUndefined();
    await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'], fields: [] });
    expect(jobData('j-1').btStatus).toBe('Open');
    expect(jobData('j-1').status).toBe('In Progress');
    // "Link to this one" on an ambiguous row writes it too.
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'link', btId: '333', p86Id: 'j-3' });
    expect(r.json.results[0].outcome).toBe('linked');
    expect([jobBt('j-3'), jobData('j-3').btStatus, jobData('j-3').status]).toEqual(['333', 'Open', 'In Progress']);
  });

  test('REFRESHED, not the word it was born with: Warranty and Closed only move the P86 status when ticked', async () => {
    const rec = BT_JOBS.find((j) => String(j.jobId) === '111');
    const was = rec.jobStatus;
    try {
      // WARRANTY — the word is recorded on every apply; the P86 status moves
      // only when 'status' is ticked. Asserted on the DATABASE ROW, never on
      // results[].fields: a report of what was applied is not a write.
      rec.jobStatus = 'Warranty';
      preview.forgetFetch(AGX);
      await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'], fields: [] });
      expect([jobData('j-1').btStatus, jobData('j-1').status]).toEqual(['Warranty', 'In Progress']);
      preview.forgetFetch(AGX);
      const w = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'], fields: ['status'] });
      expect(w.json.results[0].fields).toEqual([{ field: 'status', from: 'In Progress', to: 'Warranty' }]);
      expect([jobData('j-1').btStatus, jobData('j-1').status]).toEqual(['Warranty', 'Warranty']);
      // Put it back for the Closed half below, through the same door.
      engine.db.prepare("UPDATE jobs SET data = json_set(data, '$.status', 'In Progress') WHERE id = 'j-1'").run();

      // CLOSED — there IS a correction now, and it still only lands when ticked.
      rec.jobStatus = 'Closed';
      preview.forgetFetch(AGX);
      await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'], fields: [] });
      expect([jobData('j-1').btStatus, jobData('j-1').status]).toEqual(['Closed', 'In Progress']);
      preview.forgetFetch(AGX);
      const r = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'], fields: ['status'] });
      expect(r.json.results[0].fields).toEqual([{ field: 'status', from: 'In Progress', to: 'Completed' }]);
      expect([jobData('j-1').btStatus, jobData('j-1').status]).toEqual(['Closed', 'Completed']);
    } finally {
      rec.jobStatus = was;
      preview.forgetFetch(AGX);
    }
  });

  test('safe mode writes the word and no other field; a second press is still unchanged', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect([jobData('j-1').btStatus, jobData('j-2').btStatus]).toEqual(['Open', 'Open']);
    expect(jobData('j-1').contractAmount).toBe(12000);
    expect(jobData('j-1').status).toBe('In Progress');
    expect(jobData('j-2').street_address).toBe('');
    preview.forgetFetch(AGX);
    const again = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect(again.json.counts).toMatchObject({ applied: 0, unchanged: 2 });
  });

  test('a Buildertrend BLANK clears the word rather than recording the dash', async () => {
    // Buildertrend writes '--' and friends for "nothing here". They are blanks, not
    // a status, so the word is cleared — recording the dash would show the P86 side
    // reading "Buildertrend: --".
    await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'], fields: [] });
    expect(jobData('j-1').btStatus).toBe('Open');
    const rec = BT_JOBS.find((j) => String(j.jobId) === '111');
    const was = rec.jobStatus;
    try {
      for (const blank of ['--', 'N/A', '   ']) {
        rec.jobStatus = blank;
        preview.forgetFetch(AGX);
        await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'], fields: [] });
        expect(jobData('j-1').btStatus).toBe('');
        expect(jobData('j-1').status).toBe('In Progress');
        // Put a real word back so the next blank has something to clear.
        rec.jobStatus = 'Open';
        preview.forgetFetch(AGX);
        await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'], fields: [] });
        expect(jobData('j-1').btStatus).toBe('Open');
      }
    } finally {
      rec.jobStatus = was;
      preview.forgetFetch(AGX);
    }
  });

  test('a created job carries it from the start', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'create', btIds: ['446'] });
    const made = engine.db.prepare('SELECT * FROM jobs WHERE bt_job_id = ?').get('446');
    expect(JSON.parse(made.data)).toMatchObject({ btStatus: 'Warranty', status: 'Warranty' });
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
    // A Buildertrend Warranty job is CREATED as Warranty now. data.notes must
    // stay EMPTY: it used to carry 'Buildertrend status: Warranty.' as a
    // stand-in for the missing status, overwriting the job's own notes field
    // (the one the Job Information card renders and its edit card writes).
    expect(w).toMatchObject({ jobNumber: 'WO9001', status: 'Warranty', btStatus: 'Warranty', jobType: 'Work Order', notes: '' });
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
    engine.db.prepare("DELETE FROM jobs WHERE id = 'j-near'").run();
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


describe('client duplicates are judged on the property part; an exact unique name wins', () => {
  test('a shared management-company prefix is not a duplicate, a near property name is', () => {
    const view = (id, name, email) => ({ id, name, email: email || null, organization_id: 1 });
    const p86 = [view('p1', 'Associa Gulf Coast - Westwinds'), view('p2', 'Greystar - Solara Apartments'), view('p3', 'Leland - Hidden Creek', 'mgr@leland.test')];
    const bt = (id, displayName, email) => readRecord('clients', { contactId: id, displayName, primaryEmail: email || '' });
    const rows = match.matchClients([bt(1, 'Associa Gulf Coast - Madeira Shores'), bt(2, 'Greystar - Solara Apartment'), bt(3, 'Leland - Hidden Creek', 'mgr@leland.test')], p86);
    expect(rows[0].class).toBe('new');
    expect(rows[1].class).toBe('possible_duplicate');
    expect(rows[1].candidates.map((c) => c.id)).toEqual(['p2']);
    expect(rows[2]).toMatchObject({ class: 'matched', rung: 'name + email' });
  });

  test('numbered and generic-word look-alikes are different properties, never flagged as duplicates', () => {
    const p86 = [{ id: 'p1', name: 'CMG Management - Caravel 1' }, { id: 'p2', name: 'Westwinds Condominiums' }, { id: 'p3', name: 'Bay Pointe Condominiums' }];
    const bt = (id, displayName) => readRecord('clients', { contactId: id, displayName });
    const rows = match.matchClients([bt(1, 'CMG Management - Caravel 2'), bt(2, 'Eastwinds Condominiums'), bt(3, 'Bay Point Condominium')], p86);
    expect(rows[0].class).toBe('new');
    expect(rows[1].class).toBe('new');
    expect(rows[2].class).toBe('possible_duplicate');
    expect(rows[2].candidates.map((c) => c.id)).toEqual(['p3']);
  });

  test('the exact name wins even when the email is on another client, and the note says so', () => {
    const p86 = [{ id: 'p1', name: 'CMG Management - Caravel 1', email: 'office@cmg.test' }, { id: 'p2', name: 'CMG Management - Twin Oaks', email: 'office@cmg.test' }];
    const rows = match.matchClients([readRecord('clients', { contactId: 5, displayName: 'CMG Management - Caravel 1', primaryEmail: 'office@cmg.test' })], p86);
    expect(rows[0]).toMatchObject({ class: 'matched', rung: 'name + email' });
    expect(rows[0].p86.id).toBe('p1');
    expect(rows[0].notes.join(' ')).toMatch(/also on "CMG Management - Twin Oaks"/);
  });
});

describe('link — a person picks the P86 record for an ambiguous row', () => {
  test('linking a listed candidate stamps the id; the pair then matches by id and the other row can no longer reach it', async () => {
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'link', btId: '333', p86Id: 'j-3' });
    expect(r.status).toBe(200);
    expect(r.json.results[0].outcome).toBe('linked');
    expect(jobBt('j-3')).toBe('333');
    const p86 = await preview.readP86(engine.pool, AGX);
    const rows = match.matchJobs(BT_JOBS.map((x) => readRecord('jobs', x)), p86.jobs, { coTotals: p86.coTotals });
    const a = rows.find((x) => String(x.bt.btId) === '333');
    const b = rows.find((x) => String(x.bt.btId) === '334');
    expect(a.rung).toBe('Buildertrend ID');
    expect(a.p86.id).toBe('j-3');
    expect([].concat(b.candidates || []).map((c) => c.id)).not.toContain('j-3');
  });

  test('a record that is not a listed candidate, another tenant\'s record, or a confident row is never linked', async () => {
    const notListed = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'link', btId: '333', p86Id: 'j-2' });
    expect(notListed.json.results[0].outcome).toBe('skipped');
    expect(jobBt('j-2')).toBeNull();
    preview.forgetFetch(AGX);
    const p86 = await preview.readP86(engine.pool, AGX);
    const row111 = match.matchJobs(BT_JOBS.map((x) => readRecord('jobs', x)), p86.jobs, { coTotals: p86.coTotals }).find((x) => String(x.bt.btId) === '111');
    // Not vacuous: the confident row really lists j-near as a possible duplicate.
    expect(['matched', 'conflict']).toContain(row111.class);
    expect(row111.p86Duplicates.map((d) => d.id)).toContain('j-near');
    const confident = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'link', btId: '111', p86Id: 'j-near' });
    expect(confident.json.results[0].outcome).toBe('skipped');
    expect(jobBt('j-near')).toBeNull();
    preview.forgetFetch(AGX);
    const foreign = await put(APPLY, OTHER_ADMIN, { dataset: 'jobs', mode: 'link', btId: '333', p86Id: 'j-3' });
    expect(foreign.status).toBe(403);
    expect(jobBt('j-3')).toBeNull();
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
    // 'estimates' used to stand here as the example of a dataset this endpoint
    // does not serve. It serves one now (services/clickr/estimate-match.js), so
    // the property — an unknown dataset name is refused before anything is read
    // — needs a name that is still unknown. 'invoices' is one: P86 has the
    // table, Clickr has no such dataset, and nothing in DATASET_KINDS names it.
    expect((await put(APPLY, ADMIN, { dataset: 'invoices', mode: 'safe' })).status).toBe(400);
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
    T.setTab('jobs');
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
    expect(html).toMatch(/Link confident matches \+ fill blank start dates and map locations \(2\)/);
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

  test('a linked row offers Merge on its possible duplicates; an unlinked one does not; P86-only jobs and clients offer Archive, leads do not', () => {
    T.resetPicks();
    T.setTab('jobs');
    const d = data([
      baseRow('matched', { rung: 'Buildertrend ID', p86Duplicates: [{ id: 'j-dup', title: 'Harbor Club Railing', rungs: ['similar name'] }] }),
      baseRow('matched', { bt: { btId: '222', raw: 'S2000', title: 'W', scope: 'open' }, rung: 'number', p86: { id: 'j-2', title: 'W' }, p86Duplicates: [{ id: 'j-dup2', title: 'W2', rungs: ['similar name'] }] }),
    ]);
    d.datasets.jobs.notInBuildertrend = { rows: [{ id: 'j-only', title: 'Only in P86', status: 'On Hold' }], count: 1, reliable: true, sentence: '' };
    T.setView('jobs', 'all', 'open');
    const html = T.render(d);
    expect(html).toMatch(/data-btp-merge="j-dup" data-btp-merge-into="j-1"/);
    expect(html).not.toContain('data-btp-merge="j-dup2"');
    T.setView('jobs', 'notinbt', 'open');
    expect(T.render(d)).toContain('data-btp-archive="j-only"');
    d.datasets.leads.notInBuildertrend = { rows: [{ id: 'l-only', title: 'Stale' }], count: 1, reliable: true, sentence: '' };
    T.setTab('leads');
    T.setView('leads', 'notinbt', 'all');
    const leadsHtml = T.render(d);
    expect(leadsHtml).not.toContain('data-btp-archive=');
    expect(leadsHtml).toContain('Buildertrend sends open leads only');
    T.setView('jobs', 'all', 'open'); T.setView('leads', 'all', 'all'); T.setTab('jobs');
  });

  test('the Archive tab lists records with Restore, and Delete permanently only when nothing is attached', () => {
    T.setTab('archive');
    T.setArchive([
      { kind: 'jobs', id: 'j-dup', label: 'S1050B Harbor', reason: 'merged', mergedInto: { id: 'j-keep', label: 'S1050 Harbor' }, attached: { job_access: 1 }, deletable: false },
      { kind: 'clients', id: 'c-only', label: 'Old Client', reason: 'not_in_buildertrend', mergedInto: null, attached: {}, deletable: true },
    ]);
    const html = T.render(data([]));
    expect(html).toContain('data-btp-restore="j-dup"');
    expect(html).toMatch(/data-btp-delete="j-dup" data-btp-kind="jobs" data-btp-delete-label="S1050B Harbor" disabled/);
    expect(html).toMatch(/data-btp-delete="c-only" data-btp-kind="clients" data-btp-delete-label="Old Client">/);
    expect(html).toContain('Merged into “S1050 Harbor”');
    expect(html).toContain('job_access 1');
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

// ══════════════════════════════════════════════════════════════════════════
// THE UNDO SPINE — a sync write and the record of what it overwrote commit
// together, and the record is enough to put it back.
// ══════════════════════════════════════════════════════════════════════════
const runs = () => engine.db.prepare('SELECT * FROM bt_sync_runs ORDER BY started_at').all();
const changes = () => engine.db.prepare('SELECT * FROM bt_sync_changes ORDER BY id').all();
const jval = (v) => { try { return JSON.parse(v); } catch (e) { return v; } };

describe('the undo spine', () => {
  test('a safe press opens ONE run and journals the column it changed, with the value that was there before', async () => {
    const wasData = jobData('j-1');
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect(r.status).toBe(200);

    const rs = runs();
    expect(rs.length).toBe(1);
    expect([rs[0].trigger, rs[0].dataset, rs[0].mode]).toEqual(['press', 'jobs', 'safe']);
    expect(rs[0].actor_user_id).toBe(ADMIN.id);
    expect(rs[0].finished_at).toBeTruthy();

    const cs = changes().filter((c) => c.target_id === 'j-1');
    expect(cs.length).toBeGreaterThan(0);
    for (const c of cs) {
      expect([c.kind, c.target_table, c.dataset]).toEqual(['update', 'jobs', 'jobs']);
      expect(c.run_id).toBe(rs[0].id);
      expect(c.organization_id).toBe(AGX);
      // NOT vacuous: the before value is the row as it stood, not the new one.
      expect(c.before_value).not.toEqual(c.after_value);
    }
    // The data column it rewrote carries the OLD blob, so an undo has the
    // whole record back and not just the field the matcher named.
    const dataChange = cs.find((c) => c.column_name === 'data');
    expect(dataChange).toBeTruthy();
    expect(jval(dataChange.before_value).startDate).toBe(wasData.startDate);
    expect(jval(dataChange.after_value).startDate).toBe('2026-02-25');
  });

  test('a press that changes nothing leaves NO run behind', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    const first = runs().length;
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });   // idempotent
    expect(runs().length).toBe(first);
  });

  test('a create is journalled as a create, carrying the whole row it made', async () => {
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'create' });
    expect(r.status).toBe(200);
    const made = changes().filter((c) => c.kind === 'create');
    expect(made.length).toBeGreaterThan(0);
    for (const c of made) {
      expect(c.column_name).toBeNull();
      expect(c.before_value).toBeNull();
      expect(jval(c.after_value).id).toBe(c.target_id);
    }
  });

  test('ANOTHER TENANT never appears in the journal', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'create' });
    for (const c of changes()) expect(c.organization_id).toBe(AGX);
    for (const c of changes()) expect(c.target_id).not.toBe('j-x');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// UNDO — putting it back, and refusing to when somebody else has moved on
// ══════════════════════════════════════════════════════════════════════════
const UNDO = '/api/admin/organizations/me?action=buildertrend-undo';
const HISTORY = '/api/admin/organizations/me?view=buildertrend-history';

function get(pathname, user) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + pathname, { method: 'GET',
      headers: user ? { Authorization: 'Bearer ' + signToken(user) } : {} }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject); req.end();
  });
}

describe('UNDO', () => {
  test('undoing the run puts the start date back to what it was', async () => {
    const was = jobData('j-1').startDate;
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect(jobData('j-1').startDate).toBe('2026-02-25');
    expect(jobData('j-1').startDate).not.toBe(was);

    const run = runs()[0];
    const u = await put(UNDO, ADMIN, { runId: run.id });
    expect(u.status).toBe(200);
    expect(u.json.undone).toBeGreaterThan(0);
    expect(u.json.refused).toBe(0);
    // The record is back where it started, and the link the press made is gone
    // with it — an undo of a run is the whole run.
    expect(jobData('j-1').startDate).toBe(was);
    expect(jobBt('j-1')).toBeFalsy();
  });

  test('a column somebody has changed since is LEFT ALONE, and says so', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    const mine = Object.assign(jobData('j-1'), { startDate: '2099-12-31' });
    engine.db.prepare('UPDATE jobs SET data = ? WHERE id = ?').run(JSON.stringify(mine), 'j-1');

    const u = await put(UNDO, ADMIN, { runId: runs()[0].id });
    expect(u.status).toBe(200);
    // Their value stands.
    expect(jobData('j-1').startDate).toBe('2099-12-31');
    // The press moved two jobs; only j-1 was edited afterwards, so only j-1's
    // data is refused — j-2's goes back normally. Scoped, or this would pass on
    // whichever row the list happened to start with.
    const dataRow = u.json.results.find((r) => r.target === 'jobs:j-1' && r.column === 'data');
    expect(dataRow.refused).toMatch(/changed this since/i);
    const journalled = changes().find((c) => c.target_id === 'j-1' && c.column_name === 'data');
    expect(journalled.undo_refused).toMatch(/changed this since/i);
    expect(journalled.undone_at).toBeFalsy();
    // NOT vacuous: the other job on the same press did go back.
    const other = u.json.results.find((r) => r.target === 'jobs:j-2' && r.column === 'data');
    expect(other.ok).toBe(true);
  });

  test('undoing a CREATE deletes the record it made', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'create' });
    const made = changes().find((c) => c.kind === 'create');
    expect(made).toBeTruthy();
    expect(engine.db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(made.target_id)).toBeTruthy();

    const u = await put(UNDO, ADMIN, { changeId: String(made.id) });
    expect(u.status).toBe(200);
    expect(u.json.undone).toBe(1);
    expect(engine.db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(made.target_id)).toBeFalsy();
  });

  test('a created job something now points at is REFUSED, not deleted', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'create' });
    const made = changes().find((c) => c.kind === 'create');
    engine.db.prepare("INSERT INTO job_change_orders (id, job_id, organization_id, status, data) VALUES ('co-after', ?, 1, 'draft', '{}')").run(made.target_id);

    const u = await put(UNDO, ADMIN, { changeId: String(made.id) });
    expect(u.status).toBe(200);
    expect(u.json.undone).toBe(0);
    expect(u.json.results[0].refused).toMatch(/change orders now points at it/i);
    // Both survive: the job is not deleted and the change order is not orphaned.
    expect(engine.db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(made.target_id)).toBeTruthy();
    expect(engine.db.prepare("SELECT 1 FROM job_change_orders WHERE id = 'co-after'").get()).toBeTruthy();
  });

  test('ANOTHER TENANT cannot take back this one’s run, and cannot see it', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    const run = runs()[0];
    const after = jobData('j-1').startDate;

    const u = await put(UNDO, OTHER_ADMIN, { runId: run.id });
    expect(u.status).toBe(404);
    expect(jobData('j-1').startDate).toBe(after);

    const h = await get(HISTORY, OTHER_ADMIN);
    expect(h.status).toBe(200);
    expect(h.json.runs).toEqual([]);
  });

  test('the history names the run, its counts and what it touched', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    const h = await get(HISTORY, ADMIN);
    expect(h.status).toBe(200);
    expect(h.json.runs.length).toBe(1);
    const r = h.json.runs[0];
    expect([r.trigger, r.dataset, r.mode]).toEqual(['press', 'jobs', 'safe']);
    expect(r.actor).toBe('Ana Ruiz');
    expect(r.changeCount).toBeGreaterThan(0);
    expect(r.records).toBeGreaterThan(0);
    expect(r.undoneCount).toBe(0);
  });

  test('a PM cannot reach either door', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect((await get(HISTORY, PM)).status).toBe(403);
    expect((await put(UNDO, PM, { runId: runs()[0].id })).status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// MAP LOCATION — Buildertrend already knows where every job is. A FILL only:
// a job that has a geocode keeps it, because P86's may be one a person set.
// ══════════════════════════════════════════════════════════════════════════
describe('MAP LOCATION', () => {
  const geo = (id) => engine.db.prepare('SELECT geocode_lat, geocode_lng, geocode_status, geocode_address FROM jobs WHERE id = ?').get(id);
  const btOf = (jobId) => BT_JOBS.find((r) => r.jobId === jobId);
  let saved;
  beforeEach(() => {
    saved = BT_JOBS.map((r) => ({ latitude: r.latitude, longitude: r.longitude }));
    btOf(111).latitude = 27.95058; btOf(111).longitude = -82.45718;   // j-1
    btOf(222).latitude = 27.94000; btOf(222).longitude = -82.46000;   // j-2
    btOf(444).latitude = 28.53834; btOf(444).longitude = -81.37924;   // created
  });
  afterEach(() => {
    BT_JOBS.forEach((r, i) => { r.latitude = saved[i].latitude; r.longitude = saved[i].longitude; });
    preview.forgetFetch(AGX);
  });

  test('a job with NO geocode takes Buildertrend’s, written the way the map trusts', async () => {
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect(r.status).toBe(200);
    const g = geo('j-1');
    expect([Number(g.geocode_lat), Number(g.geocode_lng)]).toEqual([27.95058, -82.45718]);
    // 'ok' or the map ignores it; the address stamped or the map re-geocodes
    // and throws it away on the next render.
    expect(g.geocode_status).toBe('ok');
    expect(g.geocode_address).toMatch(/Harbor Dr/);
    expect(jobData('j-1').geocodeSource).toBe('buildertrend');
  });

  test('a job that ALREADY HAS a geocode is not offered Buildertrend’s', async () => {
    engine.db.prepare("UPDATE jobs SET geocode_lat = 26.1, geocode_lng = -80.1, geocode_status = 'ok' WHERE id = 'j-1'").run();
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    // Not offered at all — so not applied, and not refused as stale either.
    const one = r.json.results.find((x) => x.p86Id === 'j-1');
    expect((one.fields || []).map((f) => f.field)).not.toContain('coordinates');
    expect(one.stale || []).not.toContain('Map location');
    const g = geo('j-1');
    expect([Number(g.geocode_lat), Number(g.geocode_lng)]).toEqual([26.1, -80.1]);
    expect(jobData('j-1').geocodeSource).toBeUndefined();
  });

  test('a geocode that lands MID-PRESS wins, and the fill is reported stale', async () => {
    // The matcher saw no point, so it offered the fill. The geocode arrives
    // after that read and before the write: only the LOCKED re-read can see
    // it, and it can only see it if its SELECT names the geocode columns.
    const real = engine.pool.connect;
    engine.pool.connect = async () => {
      const c = await real();
      const q = c.query;
      c.query = async (sql, params) => {
        if (sql.indexOf('FROM jobs WHERE id =') >= 0 && sql.indexOf('FOR UPDATE') >= 0 && params[0] === 'j-1') {
          engine.db.prepare("UPDATE jobs SET geocode_lat = 26.1, geocode_lng = -80.1, geocode_status = 'ok' WHERE id = 'j-1'").run();
        }
        return q(sql, params);
      };
      return c;
    };
    let r;
    try { r = await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' }); } finally { engine.pool.connect = real; }
    const g = geo('j-1');
    expect([Number(g.geocode_lat), Number(g.geocode_lng)]).toEqual([26.1, -80.1]);
    const one = r.json.results.find((x) => x.p86Id === 'j-1');
    expect(one.stale).toContain('Map location');
  });
  test('0,0 is an empty geocode, not a place: it is FILLED', async () => {
    engine.db.prepare("UPDATE jobs SET geocode_lat = 0, geocode_lng = 0, geocode_status = 'ok' WHERE id = 'j-1'").run();
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect(Number(geo('j-1').geocode_lat)).toBe(27.95058);
  });

  test('a STICKY FAILURE is filled — the geocoder gave up and Buildertrend did not', async () => {
    engine.db.prepare("UPDATE jobs SET geocode_lat = NULL, geocode_lng = NULL, geocode_status = 'failed' WHERE id = 'j-1'").run();
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect(geo('j-1').geocode_status).toBe('ok');
  });

  test('Buildertrend’s own 0,0 is never written', async () => {
    btOf(111).latitude = 0; btOf(111).longitude = 0;
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect(geo('j-1').geocode_lat).toBeNull();
  });

  test('an out-of-range coordinate is refused at the reader', async () => {
    btOf(111).latitude = 91; btOf(111).longitude = -82.4;
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect(geo('j-1').geocode_lat).toBeNull();
  });

  test('a job created from Buildertrend is born on the map', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'create' });
    const id = engine.db.prepare('SELECT id FROM jobs WHERE bt_job_id = ?').get('444').id;
    const g = geo(id);
    expect([Number(g.geocode_lat), Number(g.geocode_lng), g.geocode_status]).toEqual([28.53834, -81.37924, 'ok']);
  });

  test('the SAFE button counts a linked job whose only safe update is its map location', () => {
    // js/bt-sync-preview.js disables the button at a count of 0, so a job
    // left out here never receives the fill at all.
    const { extractFunction } = require('./helpers/browser-fn');
    const src = extractFunction(require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'bt-sync-preview.js'), 'utf8'), 'safeCount');
    const safeCount = new Function('return ' + src)();
    const linked = (corrections) => ({ class: 'matched', rung: 'Buildertrend ID', bt: { btId: '111' }, btStatusDue: false, corrections });
    const ds = { key: 'jobs', rows: [
      linked([{ field: 'coordinates', kind: 'fill', from: '', to: '27.9, -82.4' }]),
      linked([{ field: 'startDate', kind: 'fill', from: '', to: '2026-02-25' }]),
      linked([]),
      linked([{ field: 'gateCode', kind: 'fill', from: '', to: '1234' }]),
    ] };
    expect(safeCount(ds)).toBe(2);
  });

  test('UNDO takes the location back, because the journal photographs columns too', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect(geo('j-1').geocode_lat).not.toBeNull();
    const run = engine.db.prepare('SELECT id FROM bt_sync_runs ORDER BY started_at DESC').get();
    const u = await put('/api/admin/organizations/me?action=buildertrend-undo', ADMIN, { runId: run.id });
    expect(u.status).toBe(200);
    expect(geo('j-1').geocode_lat).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// CLIENT CUSTOM FIELDS — Buildertrend's own contact fields (Company Name, Gate
// Code, CM Email ...) onto the client columns P86 already has. The contact
// rule throughout: a blank fills, a different value waits for a tick, and a
// Buildertrend blank never erases.
// ══════════════════════════════════════════════════════════════════════════
describe('CLIENT CUSTOM FIELDS', () => {
  const clientRow = (id) => engine.db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  const btc = (id) => BT_CLIENTS.find((r) => r.contactId === id);
  // The live shape (scout, 2026-09-21).
  const cf = (label, value) => ({ customFieldId: 1, label, tooltipText: '', type: 1, value });
  const row9001 = async () => {
    const p86 = await preview.readP86(engine.pool, AGX);
    return match.matchClients(BT_CLIENTS.map((x) => readRecord('clients', x)), p86.clients).find((r) => String(r.bt.btId) === '9001');
  };
  beforeEach(() => {
    btc(9001).customFields = [
      cf('Company Name', 'CMG Management'),
      cf("*Gate Code/Addt'l Notes", '  Gate #1234*   \n\n  Call   Ana first  '),
      cf('CM Email', 'cam@oakhollow.test'),
      cf('CM Direct Phone', '(813) 555-0199'),
      cf('Website', ''),
      // An option id, not a name: Market is a markets-table question, not read here.
      cf('Market', [123456]),
      cf('*Property Map', null),
    ];
    btc(9007).customFields = [cf('Community Name', 'Seaside Towers'), cf('Property Phone', '727-555-0100')];
  });
  afterEach(() => {
    btc(9001).customFields = [];
    btc(9007).customFields = [];
    preview.forgetFetch(AGX);
  });

  test('each one is offered as a fill; a note keeps its lines; a blank, a file slot and Market offer nothing', async () => {
    const row = await row9001();
    const fills = Object.fromEntries(row.corrections.map((c) => [c.field, c.to]));
    expect(fills.companyName).toBe('CMG Management');
    expect(fills.gateCode).toBe('Gate #1234*\nCall Ana first');
    expect(fills.cmEmail).toBe('cam@oakhollow.test');
    expect(fills.cmPhone).toBe('(813) 555-0199');
    expect(Object.keys(fills)).not.toContain('website');
    // Market is read (an option id) but means nothing until it is mapped.
    expect(row.bt.marketOption).toBe('123456');
    expect(row.bt.market).toBeNull();
    expect(row.corrections.concat(row.heldBack).map((c) => c.field)).not.toContain('market');
  });

  test('apply writes them to the columns P86 already has; the client name is never touched', async () => {
    const r = await put(APPLY, ADMIN, { dataset: 'clients', btIds: ['9001'] });
    expect(r.status).toBe(200);
    const c = clientRow('c-a');
    expect([c.company_name, c.gate_code, c.cm_email, c.cm_phone]).toEqual(['CMG Management', 'Gate #1234*\nCall Ana first', 'cam@oakhollow.test', '(813) 555-0199']);
    expect(c.name).toBe('Oak Hollow HOA');
  });

  test('a DIFFERENT P86 value waits for a tick; the same one after tidying is left alone', async () => {
    engine.db.prepare("UPDATE clients SET company_name = 'CMG Mgmt Group', cm_phone = '813.555.0199' WHERE id = 'c-a'").run();
    const row = await row9001();
    expect(row.heldBack.map((h) => h.field)).toEqual(['companyName']);
    expect(row.corrections.map((c) => c.field)).not.toContain('cmPhone');
    await put(APPLY, ADMIN, { dataset: 'clients', btIds: ['9001'], fields: [] });
    expect(clientRow('c-a').company_name).toBe('CMG Mgmt Group');
    preview.forgetFetch(AGX);
    await put(APPLY, ADMIN, { dataset: 'clients', btIds: ['9001'], fields: ['companyName'] });
    expect(clientRow('c-a').company_name).toBe('CMG Management');
    expect(clientRow('c-a').cm_phone).toBe('813.555.0199');
  });

  test('a Buildertrend blank never erases what P86 holds', async () => {
    engine.db.prepare("UPDATE clients SET website = 'oakhollow.test' WHERE id = 'c-a'").run();
    await put(APPLY, ADMIN, { dataset: 'clients', btIds: ['9001'] });
    expect(clientRow('c-a').website).toBe('oakhollow.test');
  });

  test('a label tidied in Buildertrend still reads; a label that answers twice reads as nothing', async () => {
    btc(9001).customFields = [cf('Gate Code / Addtl Notes', 'Gate 77'), cf('Company Name', 'A Co'), cf('company  name', 'B Co')];
    const row = await row9001();
    const fills = Object.fromEntries(row.corrections.map((c) => [c.field, c.to]));
    expect(fills.gateCode).toBe('Gate 77');
    expect(Object.keys(fills)).not.toContain('companyName');
  });

  test('a client created from Buildertrend carries its custom fields', async () => {
    const r = await put(APPLY, ADMIN, { dataset: 'clients', mode: 'create' });
    expect(r.status).toBe(200);
    const c = engine.db.prepare("SELECT * FROM clients WHERE bt_contact_id = '9007'").get();
    expect([c.community_name, c.property_phone]).toEqual(['Seaside Towers', '727-555-0100']);
    expect(c.company_name).toBeNull();
  });

  test('a value typed into P86 MID-PRESS wins, and the fill is reported stale', async () => {
    // The preview saw a blank; a person fills it before the write. Only the
    // locked re-read can see that, and only if it SELECTs the column.
    const real = engine.pool.connect;
    engine.pool.connect = async () => {
      const c = await real();
      const q = c.query;
      c.query = async (sql, params) => {
        if (sql.indexOf('FROM clients WHERE id =') >= 0 && sql.indexOf('FOR UPDATE') >= 0 && params[0] === 'c-a') {
          engine.db.prepare("UPDATE clients SET company_name = 'Typed Mid Press' WHERE id = 'c-a'").run();
        }
        return q(sql, params);
      };
      return c;
    };
    let r;
    try { r = await put(APPLY, ADMIN, { dataset: 'clients', btIds: ['9001'] }); } finally { engine.pool.connect = real; }
    expect(clientRow('c-a').company_name).toBe('Typed Mid Press');
    expect(r.json.results[0].stale).toContain('Company name');
    // The other fields on the row still went in.
    expect(clientRow('c-a').cm_email).toBe('cam@oakhollow.test');
  });

  test('UNDO puts the columns back', async () => {
    await put(APPLY, ADMIN, { dataset: 'clients', btIds: ['9001'] });
    expect(clientRow('c-a').gate_code).not.toBeNull();
    const run = engine.db.prepare('SELECT id FROM bt_sync_runs ORDER BY started_at DESC').get();
    const u = await put('/api/admin/organizations/me?action=buildertrend-undo', ADMIN, { runId: run.id });
    expect(u.status).toBe(200);
    const c = clientRow('c-a');
    expect([c.company_name, c.gate_code, c.cm_email]).toEqual([null, null, null]);
  });
});

// JOB CUSTOM FIELDS — gate code, and the CLIENT's own PO and WO numbers, kept
// in jobs.data on the same contact rule.
describe('JOB CUSTOM FIELDS', () => {
  const btj = (id) => BT_JOBS.find((r) => r.jobId === id);
  const cf = (label, value) => ({ customFieldId: 1, label, tooltipText: '', type: 1, value });
  const setData = (id, patch) => {
    const d = jobData(id);
    engine.db.prepare('UPDATE jobs SET data = ? WHERE id = ?').run(JSON.stringify(Object.assign(d, patch)), id);
  };
  beforeEach(() => {
    btj(111).customFields = [
      cf('Gate Code (if applicable)', ' #4455 \n back gate '),
      cf('PO# (if applicable)', 'PO-7788'),
      cf('WO# (if applicable)', ''),
      cf('Market', [123456]),
    ];
    btj(444).customFields = [cf('WO# (if applicable)', 'WO-12')];
  });
  afterEach(() => {
    btj(111).customFields = [];
    btj(444).customFields = [];
    preview.forgetFetch(AGX);
  });

  test('apply fills them into jobs.data; a note keeps its lines; a blank writes nothing', async () => {
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'] });
    expect(r.status).toBe(200);
    const d = jobData('j-1');
    expect([d.gateCode, d.clientPoNumber]).toEqual(['#4455\nback gate', 'PO-7788']);
    expect(d).not.toHaveProperty('clientWoNumber');
    expect(JSON.stringify(d)).not.toMatch(/123456/);
  });

  test('safe mode does not write them \u2014 safe stays the start date and the map point', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' });
    expect(jobData('j-1')).not.toHaveProperty('gateCode');
  });

  test('a DIFFERENT P86 value waits for a tick, and a tick replaces it', async () => {
    setData('j-1', { clientPoNumber: 'PO-0001' });
    await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'], fields: [] });
    expect(jobData('j-1').clientPoNumber).toBe('PO-0001');
    preview.forgetFetch(AGX);
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'], fields: ['clientPo'] });
    expect(r.json.results[0].fields).toEqual([{ field: 'clientPo', from: 'PO-0001', to: 'PO-7788' }]);
    expect(jobData('j-1').clientPoNumber).toBe('PO-7788');
  });

  test('a Buildertrend blank never erases what P86 holds', async () => {
    setData('j-1', { clientWoNumber: 'WO-P86' });
    await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'] });
    expect(jobData('j-1').clientWoNumber).toBe('WO-P86');
  });

  test('a job created from Buildertrend carries them', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'create' });
    const made = engine.db.prepare("SELECT data FROM jobs WHERE bt_job_id = '444'").get();
    expect(JSON.parse(made.data).clientWoNumber).toBe('WO-12');
  });

  test('what P86 stored reaches the matcher: a stored status word is not due again, a held value is not a blank', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'] });
    expect(jobData('j-1').btStatus).toBe('Open');
    preview.forgetFetch(AGX);
    const p86 = await preview.readP86(engine.pool, AGX);
    const row = match.matchJobs(BT_JOBS.map((x) => readRecord('jobs', x)), p86.jobs, { coTotals: p86.coTotals }).find((r) => String(r.bt.btId) === '111');
    expect(row.btStatusDue).toBe(false);
    // Filled last press, so nothing is offered for them now.
    expect(row.corrections.map((c) => c.field)).not.toContain('gateCode');
    expect(row.corrections.map((c) => c.field)).not.toContain('clientPo');
  });

  test('UNDO takes them back out', async () => {
    await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'] });
    expect(jobData('j-1').gateCode).toBeTruthy();
    const run = engine.db.prepare('SELECT id FROM bt_sync_runs ORDER BY started_at DESC').get();
    const u = await put('/api/admin/organizations/me?action=buildertrend-undo', ADMIN, { runId: run.id });
    expect(u.status).toBe(200);
    expect(jobData('j-1')).not.toHaveProperty('gateCode');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// MARKET MAPPING — Buildertrend sends a Market OPTION id, never a name. It
// means a P86 market only once a person maps it; then it is an ordinary field
// on the contact rule, written as market_id with its name beside it.
// ══════════════════════════════════════════════════════════════════════════
describe('MARKET MAPPING', () => {
  const MAP = '/api/admin/organizations/me?action=buildertrend-market-map';
  const PREVIEW = '/api/admin/organizations/me?view=buildertrend-preview&since=keep';
  const btMarket = require('../server/services/clickr/bt-market');
  const cf = (label, value) => ({ customFieldId: 1, label, tooltipText: '', type: 1, value });
  const btc = (id) => BT_CLIENTS.find((r) => r.contactId === id);
  const btj = (id) => BT_JOBS.find((r) => r.jobId === id);
  const clientRow = (id) => engine.db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  const jobMarket = (id) => engine.db.prepare('SELECT market_id FROM jobs WHERE id = ?').get(id).market_id;
  const settings = () => JSON.parse(engine.db.prepare('SELECT settings FROM organizations WHERE id = 1').get().settings || '{}');
  const clientRows = async () => {
    const p86 = await preview.readP86(engine.pool, AGX);
    return preview.matchRows('clients', BT_CLIENTS.map((x) => readRecord('clients', x)), p86);
  };
  const rowFor = (rows, id) => rows.find((r) => String(r.bt.btId) === id);
  beforeEach(() => {
    engine.db.exec("DELETE FROM markets; INSERT INTO markets (id, organization_id, name, code) VALUES (1, 1, 'Tampa', 'TPA'), (2, 1, 'Orlando', 'ORL'), (3, 2, 'Elsewhere', 'ELS');");
    // Another setting the mapping must never disturb.
    engine.db.prepare('UPDATE organizations SET settings = ? WHERE id = 1').run(JSON.stringify({ keepMe: 1 }));
    for (const id of [9001, 9002, 9005, 9007]) btc(id).customFields = [cf('Market', [5001])];
    btj(111).customFields = [cf('Market', [7001])];
  });
  afterEach(() => {
    for (const id of [9001, 9002, 9005, 9007]) btc(id).customFields = [];
    btj(111).customFields = [];
    engine.db.exec('DELETE FROM markets;');
    preview.forgetFetch(AGX);
  });

  test('the reader keeps the option id: a one-item list is its item, anything else is no option', () => {
    expect(btMarket.optionOf([5001])).toBe('5001');
    expect(btMarket.optionOf(5001)).toBe('5001');
    expect(btMarket.optionOf([])).toBeNull();
    expect(btMarket.optionOf([1, 2])).toBeNull();
    expect(btMarket.optionOf({ id: 1 })).toBeNull();
    expect(btMarket.optionOf(null)).toBeNull();
    // Buildertrend's "nothing chosen" is not an option to map.
    expect(btMarket.optionOf([-1])).toBeNull();
    expect(btMarket.optionOf('-1')).toBeNull();
  });

  test('UNMAPPED, an option proposes nothing \u2014 and the evidence suggests only when linked records agree', async () => {
    engine.db.exec("UPDATE clients SET market_id = 1 WHERE id IN ('c-h', 'c-bp')");
    let rows = await clientRows();
    expect(rowFor(rows, '9001').corrections.map((c) => c.field)).not.toContain('market');
    let p86 = await preview.readP86(engine.pool, AGX);
    let ev = btMarket.evidence(rows, p86.market.clients);
    // Two filed records is not enough to suggest from.
    expect(ev[0]).toMatchObject({ optionId: '5001', records: 4, suggestion: null, mappedTo: null });
    expect(ev[0].p86).toEqual([{ marketId: '1', name: 'Tampa', count: 2 }]);
    engine.db.exec("UPDATE clients SET market_id = 1 WHERE id = 'c-a'");
    rows = await clientRows();
    p86 = await preview.readP86(engine.pool, AGX);
    ev = btMarket.evidence(rows, p86.market.clients);
    expect(ev[0].suggestion).toBe('1');
    // A split vote suggests nothing.
    engine.db.exec("UPDATE clients SET market_id = 2 WHERE id = 'c-a'");
    rows = await clientRows();
    expect(btMarket.evidence(rows, (await preview.readP86(engine.pool, AGX)).market.clients)[0].suggestion).toBeNull();
  });

  test('the preview carries the evidence and the market list', async () => {
    const r = await get(PREVIEW, ADMIN);
    expect(r.status).toBe(200);
    expect(r.json.markets.map((m) => m.name).sort()).toEqual(['Orlando', 'Tampa']);
    expect(r.json.datasets.clients.marketOptions[0].optionId).toBe('5001');
    expect(r.json.datasets.jobs.marketOptions[0].optionId).toBe('7001');
  });

  test('saving a mapping: only this organisation\u2019s markets, only the owner organisation, other settings untouched', async () => {
    expect((await put(MAP, ADMIN, { kind: 'clients', optionId: '5001', marketId: '3' })).status).toBe(400);
    expect((await put(MAP, ADMIN, { kind: 'leads', optionId: '5001', marketId: '1' })).status).toBe(400);
    expect((await put(MAP, ADMIN, { kind: 'clients', optionId: '', marketId: '1' })).status).toBe(400);
    expect((await put(MAP, OTHER_ADMIN, { kind: 'clients', optionId: '5001', marketId: '3' })).status).toBe(403);
    const ok = await put(MAP, ADMIN, { kind: 'clients', optionId: '5001', marketId: '1' });
    expect(ok.status).toBe(200);
    expect(settings()).toEqual({ keepMe: 1, btMarketMap: { jobs: {}, clients: { 5001: '1' } } });
    const un = await put(MAP, ADMIN, { kind: 'clients', optionId: '5001', marketId: null });
    expect(un.status).toBe(200);
    expect(settings()).toEqual({ keepMe: 1, btMarketMap: { jobs: {}, clients: {} } });
  });

  test('MAPPED: a client with no market is filled with market_id and the name beside it', async () => {
    await put(MAP, ADMIN, { kind: 'clients', optionId: '5001', marketId: '1' });
    const row = rowFor(await clientRows(), '9001');
    expect(row.corrections.find((c) => c.field === 'market')).toMatchObject({ kind: 'fill', to: 'Tampa', value: '1' });
    const r = await put(APPLY, ADMIN, { dataset: 'clients', btIds: ['9001'] });
    expect(r.status).toBe(200);
    expect([String(clientRow('c-a').market_id), clientRow('c-a').market]).toEqual(['1', 'Tampa']);
  });

  test('MAPPED: a client filed under ANOTHER market waits for a tick, and a tick moves it', async () => {
    await put(MAP, ADMIN, { kind: 'clients', optionId: '5001', marketId: '1' });
    engine.db.exec("UPDATE clients SET market_id = 2, market = 'Orlando' WHERE id = 'c-a'");
    const row = rowFor(await clientRows(), '9001');
    expect(row.heldBack.find((h) => h.field === 'market')).toMatchObject({ bt: 'Tampa', p86: 'Orlando', p86Id: '2', value: '1', applicable: true });
    await put(APPLY, ADMIN, { dataset: 'clients', btIds: ['9001'], fields: [] });
    expect(String(clientRow('c-a').market_id)).toBe('2');
    preview.forgetFetch(AGX);
    await put(APPLY, ADMIN, { dataset: 'clients', btIds: ['9001'], fields: ['market'] });
    expect([String(clientRow('c-a').market_id), clientRow('c-a').market]).toEqual(['1', 'Tampa']);
  });

  test('a TICKED move is refused if P86 moved the client itself since the preview', async () => {
    await put(MAP, ADMIN, { kind: 'clients', optionId: '5001', marketId: '1' });
    engine.db.exec("UPDATE clients SET market_id = 2, market = 'Orlando' WHERE id = 'c-a'");
    const real = engine.pool.connect;
    engine.pool.connect = async () => {
      const c = await real();
      const q = c.query;
      c.query = async (sql, params) => {
        if (sql.indexOf('FROM clients WHERE id =') >= 0 && sql.indexOf('FOR UPDATE') >= 0 && params[0] === 'c-a') {
          engine.db.exec("UPDATE clients SET market_id = NULL, market = NULL WHERE id = 'c-a'");
        }
        return q(sql, params);
      };
      return c;
    };
    let r;
    try { r = await put(APPLY, ADMIN, { dataset: 'clients', btIds: ['9001'], fields: ['market'] }); } finally { engine.pool.connect = real; }
    expect(clientRow('c-a').market_id).toBeNull();
    expect(r.json.results[0].stale).toContain('Market');
  });

  test('a mapping to a market that has since gone is no mapping: nothing proposed, and the page is told', async () => {
    await put(MAP, ADMIN, { kind: 'clients', optionId: '5001', marketId: '1' });
    engine.db.exec('DELETE FROM markets WHERE id = 1');
    const rows = await clientRows();
    expect(rowFor(rows, '9001').corrections.map((c) => c.field)).not.toContain('market');
    const p86 = await preview.readP86(engine.pool, AGX);
    expect(btMarket.evidence(rows, p86.market.clients)[0]).toMatchObject({ mappedTo: null, mappedGone: true });
  });

  test('a map hand-edited to point at ANOTHER tenant\u2019s market proposes nothing and writes nothing', async () => {
    engine.db.prepare('UPDATE organizations SET settings = ? WHERE id = 1').run(JSON.stringify({ btMarketMap: { clients: { 5001: '3' } } }));
    const row = rowFor(await clientRows(), '9001');
    expect(row.corrections.map((c) => c.field)).not.toContain('market');
    await put(APPLY, ADMIN, { dataset: 'clients', btIds: ['9001'] });
    expect(clientRow('c-a').market_id).toBeNull();
  });

  test('a client created from Buildertrend is filed under its mapped market', async () => {
    await put(MAP, ADMIN, { kind: 'clients', optionId: '5001', marketId: '2' });
    await put(APPLY, ADMIN, { dataset: 'clients', mode: 'create' });
    const c = engine.db.prepare("SELECT * FROM clients WHERE bt_contact_id = '9007'").get();
    expect([String(c.market_id), c.market]).toEqual(['2', 'Orlando']);
  });

  test('JOBS: a mapped option fills market_id and data.market; undo takes both back', async () => {
    await put(MAP, ADMIN, { kind: 'jobs', optionId: '7001', marketId: '2' });
    const r = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'] });
    expect(r.status).toBe(200);
    expect(String(jobMarket('j-1'))).toBe('2');
    expect(jobData('j-1').market).toBe('Orlando');
    const run = engine.db.prepare('SELECT id FROM bt_sync_runs ORDER BY started_at DESC').get();
    await put('/api/admin/organizations/me?action=buildertrend-undo', ADMIN, { runId: run.id });
    expect(jobMarket('j-1')).toBeNull();
    expect(jobData('j-1').market).toBeUndefined();
  });

  test('JOBS: a market set MID-PRESS wins, and the fill is reported stale', async () => {
    await put(MAP, ADMIN, { kind: 'jobs', optionId: '7001', marketId: '2' });
    const real = engine.pool.connect;
    engine.pool.connect = async () => {
      const c = await real();
      const q = c.query;
      c.query = async (sql, params) => {
        if (sql.indexOf('FROM jobs WHERE id =') >= 0 && sql.indexOf('FOR UPDATE') >= 0 && params[0] === 'j-1') {
          engine.db.exec("UPDATE jobs SET market_id = 1 WHERE id = 'j-1'");
        }
        return q(sql, params);
      };
      return c;
    };
    let r;
    try { r = await put(APPLY, ADMIN, { dataset: 'jobs', btIds: ['111'] }); } finally { engine.pool.connect = real; }
    expect(String(jobMarket('j-1'))).toBe('1');
    expect(r.json.results[0].stale).toContain('Market');
  });
});

// RUN SYNC NOW — the whole sync once, pressed by a person: the unattended
// run's own path, journalled as one run, undoable as one run.
describe('RUN SYNC NOW', () => {
  const RUN = '/api/admin/organizations/me?action=buildertrend-run-now';
  const auto = require('../server/services/clickr/auto-sync');
  const syncApply = require('../server/services/clickr/sync-apply');
  afterEach(async () => { await auto.idle(); preview.forgetFetch(AGX); });

  test('runs even with BT_AUTO_SYNC off, as the person who pressed it, and answers at once with the run id', async () => {
    delete process.env.BT_AUTO_SYNC;
    const r = await put(RUN, ADMIN, {});
    expect(r.status).toBe(202);
    expect(r.json.runId).toMatch(/^btrun_/);
    await auto.idle();
    const run = engine.db.prepare('SELECT * FROM bt_sync_runs WHERE id = ?').get(r.json.runId);
    expect(run).toMatchObject({ trigger: 'manual', mode: 'auto', actor_user_id: 10 });
    expect(run.finished_at).not.toBeNull();
    // It did the unattended run's work: confident jobs linked, the blank start date filled.
    expect(jobBt('j-1')).toBe('111');
    expect(jobData('j-1').startDate).toBe('2026-02-25');
  });

  test('the history says what the last run did; another tenant is told nothing', async () => {
    const r = await put(RUN, ADMIN, {});
    await auto.idle();
    const h = await get(HISTORY, ADMIN);
    expect(h.json.live).toMatchObject({ running: false, live: null });
    expect(h.json.live.last).toMatchObject({ runId: r.json.runId, trigger: 'manual' });
    expect(h.json.live.last.totals.linked).toBeGreaterThan(0);
    expect(h.json.runs[0]).toMatchObject({ id: r.json.runId, trigger: 'manual' });
    const other = await get(HISTORY, OTHER_ADMIN);
    expect(other.json.live).toBeNull();
  });

  test('the whole run is taken back by one undo', async () => {
    const r = await put(RUN, ADMIN, {});
    await auto.idle();
    expect(jobBt('j-1')).toBe('111');
    const u = await put(UNDO, ADMIN, { runId: r.json.runId });
    expect(u.status).toBe(200);
    expect(jobBt('j-1')).toBeNull();
    expect(jobData('j-1').startDate || '').toBe('');
    // Every record the run created is gone again.
    expect(engine.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE bt_job_id IN ('444', '446')").get().n).toBe(0);
  });

  test('ONE writer at a time: no run while a press holds the lock, no press while a run does', async () => {
    expect(syncApply.claim()).toBe(true);
    try {
      expect((await put(RUN, ADMIN, {})).status).toBe(429);
    } finally { syncApply.release(); }
    // And the other way round: the run takes the SAME lock a press does.
    // Buildertrend is slowed so the run is certainly still going.
    const fastFetch = global.fetch;
    global.fetch = async (...a) => { await new Promise((res) => setTimeout(res, 150)); return fastFetch(...a); };
    try {
      const r = await put(RUN, ADMIN, {});
      expect(r.status).toBe(202);
      expect(auto.status().running).toBe(true);
      expect((await put(APPLY, ADMIN, { dataset: 'jobs', mode: 'safe' })).status).toBe(429);
      expect((await put(RUN, ADMIN, {})).status).toBe(429);
      await auto.idle();
    } finally { global.fetch = fastFetch; }
    expect(syncApply.busy()).toBe(false);
  });

  test('a run cannot be taken back while it is still writing', async () => {
    const fastFetch = global.fetch;
    global.fetch = async (...x) => { await new Promise((res) => setTimeout(res, 150)); return fastFetch(...x); };
    try {
      const r = await put(RUN, ADMIN, {});
      expect(auto.status().running).toBe(true);
      const u = await put(UNDO, ADMIN, { runId: r.json.runId });
      expect(u.status).toBe(409);
      await auto.idle();
      expect((await put(UNDO, ADMIN, { runId: r.json.runId })).status).toBe(200);
    } finally { global.fetch = fastFetch; }
  });

  test('only the organisation the Buildertrend connection belongs to; no key is a refusal, not a crash', async () => {
    expect((await put(RUN, OTHER_ADMIN, {})).status).toBe(403);
    delete process.env.CLICKR_API_KEY;
    expect((await put(RUN, ADMIN, {})).status).toBe(409);
  });
});
