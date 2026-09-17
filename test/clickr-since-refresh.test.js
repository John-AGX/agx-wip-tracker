// BUILDERTREND PREVIEW — WHAT IS NEW OR CHANGED SINCE *YOUR* LAST REFRESH
// (server/services/clickr/since-refresh.js, sync-preview.js, js/bt-sync-preview.js).
//
// Driven through the real express router (GET /api/admin/organizations/me
// ?view=buildertrend-preview, PUT ?action=buildertrend-apply), real requireAuth /
// requireOrg / ROLES_MANAGE, a JWT per admin, and the pg-sqlite engine with every
// table derived from server/db.js. Clickr is a stub whose five datasets the tests
// edit between refreshes — a record added, a field changed, a record removed, a
// read cut short — exactly as Buildertrend would.
//
// Marks are relative to EACH admin's own previous refresh: one admin refreshing
// never hides another admin's marks, and the page's reload after an Apply
// (?since=keep) compares without moving the marker.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema, tableNames } = require('./helpers/db-schema');

const engine = createPgSqlite(
  sqliteSchema(tableNames(), { pk: { organizations: 'id', users: 'id', roles: 'name', jobs: 'id', leads: 'id', clients: 'id', job_change_orders: 'id', job_purchase_orders: 'id' } }),
  { jsonColumns: ['data', 'snapshot', 'prev_snapshot'] }
);
// server/db.js's primary keys on the two memory tables — the ON CONFLICT
// targets. The derived schema carries no constraints of its own.
engine.db.exec(`
  CREATE UNIQUE INDEX pk_bt_record_snapshots ON bt_record_snapshots(organization_id, dataset, bt_id);
  CREATE UNIQUE INDEX pk_bt_preview_views ON bt_preview_views(organization_id, user_id);
`);
globalThis.__P86_CLICKR_SINCE_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_CLICKR_SINCE_ENGINE__.pool }));
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});
jest.mock('../server/geocoder', () => ({ geocodeAddress: async () => null, geocodeViaGoogle: async () => null, geocodeViaCensus: async () => null }));

const { DATASETS } = require('../server/services/clickr/field-map');
const preview = require('../server/services/clickr/sync-preview');
const since = require('../server/services/clickr/since-refresh');
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const orgRoutes = require('../server/routes/admin-organizations-routes');

const KEY = 'ck_live_Zq9SECRETKEYxy7_0123456789ab';
const BASE = 'https://api.clickr.cloud';
const AGX = 1;
const OTHER = 2;
const KINDS = ['jobs', 'leads', 'clients', 'changeOrders', 'purchaseOrders'];

// ── real-shape Clickr records ────────────────────────────────────────────────
function jobRec(jobId, jobName, o) {
  o = o || {};
  return {
    jobId, jobName, jobStatus: o.jobStatus || 'Open', street: o.street || '', city: 'Tampa', state: 'FL', zip: '33602',
    projectedStart: o.projectedStart || null, projectedCompletion: null,
    contractPrice: o.contractPrice || { value: 0, scale: 2 }, approvedCOPrice: { value: 0, scale: 2 }, jobRunningTotal: { value: 0, scale: 2 },
    projectManager: [], contacts: [], customFields: [], latitude: null, longitude: null, jobType: 'Handyman Services', groups: [],
    createdDate: '2025-01-02T15:00:00.000Z', isDeleted: false,
  };
}
function leadRec(leadId, title, o) {
  o = o || {};
  return {
    leadId, opportunityTitle: title, opportunityStreet: o.street || '', opportunityCity: 'Tampa', opportunityState: 'FL', opportunityZip: '33602',
    contactId: 9001, contactName: o.contactName || 'Oak Hollow HOA', salesperson: 'Ana Ruiz', projectType: 'Service & Repair', source: o.source || 'Referral',
    confidence: o.confidence == null ? 50 : o.confidence, estimatedRevenueMin: o.min || 0, estimatedRevenueMax: o.max || 0, notes: '',
    createdDate: '2026-04-03T12:00:00.000Z', nextActivityDate: null, nextActivityTitle: null, nextActivityAssignee: null,
  };
}
function clientRec(contactId, displayName, o) {
  o = o || {};
  return {
    contactId, displayName, displayNameNormalized: displayName.toLowerCase(), firstName: null, lastName: null, email: o.email || '', primaryEmail: o.email || '',
    emails: o.email ? [o.email] : [], phone: o.phone || '', cell: '', street: '', city: 'Tampa', state: 'FL', zip: '33602',
    jobCount: 1, jobTotalCount: 1, leadCount: 0, leadTotalCount: 0, activationStatus: 0, activationConfirmed: false, customFields: [],
  };
}
function coRec(id, coNumber, title, status, price, cost) {
  return {
    changeOrderId: String(id), coNumber, title, jobId: '111', jobName: 'S1050 Harbor Club Railings', approvalStatus: 4, approvalStatusText: status,
    builderCost: cost, subtotal: price, totalMarkup: price - cost, totalPrice: price, statusChangedDate: '2026-03-04T15:20:11.12', statusChangedBy: 'RPM',
    dateAdded: '2026-03-01T10:00:00.00', createdBy: 'Lisa', createdById: '77', ownerName: 'Board', ownerLastViewed: null, deadline: null, isDeleted: false,
    isInvoiceable: false, purchaseOrderCost: 0, poBuilderVariance: 0, poCustomerVariance: 0, relatedPurchaseOrderIds: [], attachedFileCount: 0, commentCount: 0, rfiCount: 0,
  };
}
function poRec(id, poNumber, title, status, cost, o) {
  o = o || {};
  return {
    purchaseOrderId: String(id), poNumber, title, jobId: '111', jobName: 'S1050 Harbor Club Railings', approvalStatus: 2, approvalStatusText: status,
    approvalUser: 'Office', approvalNote: null, workStatus: 1, workStatusText: o.work || 'Not Complete', paidStatus: 1, paidStatusText: 'Not Paid',
    cost, amountPaid: 0, amountRemaining: cost, performingUserId: null, performingUserName: o.sub || null, costCodes: ['Subcontractors Costs'],
    estCompleteDate: o.est || null, externalId: 'x', dateAdded: '2026-03-01T10:00:00.00', createdBy: 'Lisa', createdById: '77', fromEstimate: false,
    hasAmendment: false, isBill: false, isDeleted: false, isOriginatedFromAccounting: false, isRecalled: false, paymentRequested: false,
    builderVarianceCodes: [], ownerVarianceCodes: [], attachedFileCount: 0, commentCount: 0, rfiCount: 0,
  };
}

let BT;
let extraCount;
function resetBt() {
  BT = {
    jobs: [
      jobRec(111, 'S1050 Harbor Club Railings', { street: '1 Harbor Dr', contractPrice: { value: 15000, scale: 2 } }),
      jobRec(222, 'S2000 Waterside Siding', { street: '5 Bay Rd' }),
      jobRec(333, 'WO16 Service Call A'),
    ],
    leads: [leadRec(555, 'Gazebo at Oak Hollow', { street: '12 Oak Hollow Dr', min: 17900, max: 17900 }), leadRec(556, 'Pergola Repaint')],
    clients: [clientRec(9001, 'Oak Hollow HOA', { email: 'board@oakhollow.test' }), clientRec(9002, 'Harbor Club Board', { email: 'mgr@harbor.test' })],
    changeOrders: [coRec(7001, 'CO-0001', 'Extra railing', 'Approved', 1200, 900), coRec(7002, 'CO-0002', 'Paint touch up', 'Pending', 700, 500)],
    purchaseOrders: [
      poRec(8001, '0001', 'Exterior paint labor', 'Sub/Vendor Approved', 5500, { sub: 'Catica International Inc', est: '2026-10-01T00:00:00' }),
      poRec(8003, '0003', 'Roofing', 'Sent to Sub/Vendor - Pending', 2000),
    ],
  };
  extraCount = {};
}

function kindOf(pathname) {
  return KINDS.find((k) => pathname.includes(DATASETS[k].datasetId)) || null;
}
function clickrFetch(url) {
  const u = new URL(url);
  if (u.origin !== BASE) throw new Error('test: fetch reached a non-Clickr host');
  const k = kindOf(u.pathname);
  if (!k) return Promise.resolve({ status: 404, text: async () => '{"error":"Route not found"}' });
  const skip = Number(u.searchParams.get('skip') || 0);
  const limit = Number(u.searchParams.get('limit') || 200);
  const list = BT[k];
  // extraCount[k]: Clickr reports more records than it sends — a PARTIAL read.
  const body = { recordType: 'x', columns: [], records: list.slice(skip, skip + limit), count: list.length + (extraCount[k] || 0), sort: {} };
  return Promise.resolve({ status: 200, text: async () => JSON.stringify(body) });
}

// Org 2's own memory. Same dataset and Buildertrend ids as AGX's, and a marker
// for AGX's admin id under org 2 in the far future: a missing organization
// predicate anywhere would read or rewrite these.
const ORG2_SNAP = JSON.stringify({ name: 'ORG2 PROBE NAME', status: 'Closed', street: null, city: null, state: null, zip: null,
  projectedStart: null, projectedCompletion: null, contractPrice: 1, approvedCOPrice: null });
function seed() {
  engine.db.exec(`
    DELETE FROM jobs; DELETE FROM leads; DELETE FROM clients; DELETE FROM users; DELETE FROM roles; DELETE FROM organizations;
    DELETE FROM job_change_orders; DELETE FROM job_purchase_orders; DELETE FROM bt_record_snapshots; DELETE FROM bt_preview_views;
    INSERT INTO organizations (id, slug, name) VALUES (1, 'agx', 'AGX Central Florida'), (2, 'other', 'Other Builders');
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ROLES_MANAGE","USERS_MANAGE","JOBS_VIEW_ALL"]'),
      ('pm', 'PM', '["JOBS_VIEW_ALL","LEADS_VIEW"]');
    INSERT INTO users (id, email, password_hash, name, role, organization_id, active) VALUES
      (10, 'ana@agx.test', 'x', 'Ana Ruiz', 'admin', 1, 1),
      (12, 'ben@agx.test', 'x', 'Ben Cole', 'admin', 1, 1),
      (11, 'pm@agx.test', 'x', 'Pat PM', 'pm', 1, 1),
      (20, 'oscar@other.test', 'x', 'Oscar Other', 'admin', 2, 1);
  `);
  const job = engine.db.prepare('INSERT INTO jobs (id, owner_id, organization_id, data) VALUES (?,?,?,?)');
  job.run('j-2', 10, AGX, JSON.stringify({ jobNumber: 'S2000', title: 'Waterside Siding', status: 'In Progress', street_address: '', city: 'Tampa', state: 'FL', zip: '33602' }));
  const snap = engine.db.prepare('INSERT INTO bt_record_snapshots (organization_id, dataset, bt_id, snapshot, first_seen_at, last_seen_at, changed_at, prev_snapshot) VALUES (?,?,?,?,?,?,?,?)');
  snap.run(OTHER, 'jobs', '111', ORG2_SNAP, '2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z', '2000-01-02T00:00:00.000Z', ORG2_SNAP);
  snap.run(OTHER, 'jobs', '999', ORG2_SNAP, '2000-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', null, null);
  snap.run(OTHER, 'purchaseOrders', '8001', ORG2_SNAP, '2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z', null, null);
  const view = engine.db.prepare('INSERT INTO bt_preview_views (organization_id, user_id, last_refresh_at) VALUES (?,?,?)');
  view.run(OTHER, 10, '2099-01-01T00:00:00.000Z');
  view.run(OTHER, 20, '2000-01-01T00:00:00.000Z');
}

const org2Hash = () => crypto.createHash('sha256').update(JSON.stringify([
  engine.db.prepare('SELECT * FROM bt_record_snapshots WHERE organization_id = 2 ORDER BY dataset, bt_id').all(),
  engine.db.prepare('SELECT * FROM bt_preview_views WHERE organization_id = 2 ORDER BY user_id').all(),
])).digest('hex');
const snapRows = (kind) => engine.all('SELECT * FROM bt_record_snapshots WHERE organization_id = 1 AND dataset = ? ORDER BY bt_id', kind);
const marker = (userId) => {
  const r = engine.db.prepare('SELECT last_refresh_at FROM bt_preview_views WHERE organization_id = 1 AND user_id = ?').get(userId);
  return r ? r.last_refresh_at : null;
};

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
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json, text: buf }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const PREVIEW = '/api/admin/organizations/me?view=buildertrend-preview';
const APPLY = '/api/admin/organizations/me?action=buildertrend-apply';
const ANA = { id: 10, email: 'ana@agx.test', name: 'Ana Ruiz', role: 'admin', organization_id: AGX };
const BEN = { id: 12, email: 'ben@agx.test', name: 'Ben Cole', role: 'admin', organization_id: AGX };
const PM = { id: 11, email: 'pm@agx.test', name: 'Pat PM', role: 'pm', organization_id: AGX };
const OSCAR = { id: 20, email: 'oscar@other.test', name: 'Oscar Other', role: 'admin', organization_id: OTHER };

// Refreshes are milliseconds apart in a test; a short pause keeps every
// refresh on its own instant, as they are for a person.
const pause = () => new Promise((r) => setTimeout(r, 4));
async function refresh(user, opts) {
  await pause();
  preview.forgetFetch(AGX);
  const r = await call('GET', PREVIEW + (opts && opts.keep ? '&since=keep' : ''), user);
  expect(r.status).toBe(200);
  return r.json;
}
const row = (body, kind, btId) => body.datasets[kind].rows.find((x) => String(x.bt.btId) === String(btId));
const marked = (body, kind) => body.datasets[kind].rows.filter((x) => x.since).map((x) => [String(x.bt.btId), x.since.state]);

beforeAll(async () => {
  resetBt();
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
  resetBt();
  seed();
  await refreshRoleCache();
});

describe('THE FIRST REFRESH — nothing is marked, and the page says why', () => {
  test('every dataset read completely is remembered; no row is marked; the first-time note is given; the marker is this refresh', async () => {
    const body = await refresh(ANA);
    // Org 2's marker for the same user id (2099) is not this admin's previous refresh.
    expect(body.since).toEqual({ previousRefreshAt: null });
    for (const k of KINDS) {
      const ds = body.datasets[k];
      expect([k, ds.classified, ds.fetch.complete]).toEqual([k, true, true]);
      expect(ds.since).toMatchObject({ compared: false, firstTime: true, note: since.FIRST_TIME_NOTE, newCount: 0, changedCount: 0, removed: [] });
      expect(marked(body, k)).toEqual([]);
      expect(snapRows(k).map((r) => r.bt_id)).toEqual(BT[k].map((x) => String(x[DATASETS[k].idKey])).sort());
    }
    expect(since.FIRST_TIME_NOTE).toBe('Buildertrend records are remembered from this refresh on — the next refresh marks what is new or changed.');
    expect(marker(10)).toBe(body.generatedAt);
    // Buildertrend values only, normalized.
    expect(snapRows('jobs').find((r) => r.bt_id === '111').snapshot).toEqual({ name: 'S1050 Harbor Club Railings', status: 'Open', street: '1 Harbor Dr', city: 'Tampa',
      state: 'FL', zip: '33602', projectedStart: null, projectedCompletion: null, contractPrice: 15000, approvedCOPrice: 0 });
    expect(snapRows('purchaseOrders').find((r) => r.bt_id === '8001').snapshot).toMatchObject({ poNumber: '0001', status: 'Sub/Vendor Approved', cost: 5500, sub: 'Catica International Inc', estCompleteDate: '2026-10-01' });
  });

  test('a second refresh with nothing changed: compared with the first, nothing new, changed or removed', async () => {
    const first = await refresh(ANA);
    const second = await refresh(ANA);
    expect(second.since).toEqual({ previousRefreshAt: first.generatedAt });
    for (const k of KINDS) {
      expect(second.datasets[k].since).toEqual({ compared: true, previousRefreshAt: first.generatedAt, newCount: 0, changedCount: 0, removed: [], removedTotal: 0, note: null });
      expect(marked(second, k)).toEqual([]);
    }
    expect(marker(10)).toBe(second.generatedAt);
  });
});

describe('NEW — a record added in Buildertrend', () => {
  test('is marked New on every tab on the next refresh, and only on that one', async () => {
    await refresh(ANA);
    BT.jobs.push(jobRec(444, 'S4000 Brand New Job', { street: '9 New St' }));
    BT.leads.push(leadRec(557, 'Fresh Lead'));
    BT.clients.push(clientRec(9003, 'Bay Pointe Condos'));
    BT.changeOrders.push(coRec(7003, 'CO-0003', 'Brand new work', 'Pending', 2500, 1500));
    BT.purchaseOrders.push(poRec(8004, '0004', 'Gutters', 'Draft', 400));
    const second = await refresh(ANA);
    expect(marked(second, 'jobs')).toEqual([['444', 'new']]);
    expect(marked(second, 'leads')).toEqual([['557', 'new']]);
    expect(marked(second, 'clients')).toEqual([['9003', 'new']]);
    expect(marked(second, 'changeOrders')).toEqual([['7003', 'new']]);
    expect(marked(second, 'purchaseOrders')).toEqual([['8004', 'new']]);
    for (const k of KINDS) expect(second.datasets[k].since).toMatchObject({ compared: true, newCount: 1, changedCount: 0 });
    const third = await refresh(ANA);
    for (const k of KINDS) expect(marked(third, k)).toEqual([]);
  });
});

describe('CHANGED — a Buildertrend field moved', () => {
  test('shows Changed with the exact difference; an unchanged record shows nothing; the mark is gone after the next refresh', async () => {
    await refresh(ANA);
    BT.jobs[0].jobStatus = 'Closed';
    BT.jobs[0].contractPrice = { value: 16250, scale: 2 };
    BT.purchaseOrders[0].approvalStatusText = 'Sent to Sub/Vendor - Pending';
    BT.purchaseOrders[0].cost = 5750.5;
    BT.changeOrders[1].title = '   ';
    BT.leads[0].estimatedRevenueMax = 21000;
    BT.clients[1].primaryEmail = 'office@harbor.test';
    const second = await refresh(ANA);

    expect(row(second, 'jobs', 111).since).toEqual({ state: 'changed', changedAt: second.generatedAt, changes: [
      { field: 'status', label: 'Status', from: 'Open', to: 'Closed' },
      { field: 'contractPrice', label: 'Contract price', from: '$15,000.00', to: '$16,250.00' },
    ] });
    expect(row(second, 'purchaseOrders', 8001).since.changes).toEqual([
      { field: 'status', label: 'Status', from: 'Sub/Vendor Approved', to: 'Sent to Sub/Vendor - Pending' },
      { field: 'cost', label: 'Cost', from: '$5,500.00', to: '$5,750.50' },
    ]);
    // A title blanked in Buildertrend: to is '' (the page shows "blank").
    expect(row(second, 'changeOrders', 7002).since.changes).toEqual([{ field: 'title', label: 'Title', from: 'Paint touch up', to: '' }]);
    expect(row(second, 'leads', 555).since.changes).toEqual([{ field: 'estimatedRevenueMax', label: 'Estimated revenue (max)', from: '$17,900.00', to: '$21,000.00' }]);
    expect(row(second, 'clients', 9002).since.changes).toEqual([{ field: 'email', label: 'Email', from: 'mgr@harbor.test', to: 'office@harbor.test' }]);

    expect(marked(second, 'jobs')).toEqual([['111', 'changed']]);
    expect(row(second, 'jobs', 222).since).toBeUndefined();
    expect(row(second, 'purchaseOrders', 8003).since).toBeUndefined();
    expect(second.datasets.jobs.since).toMatchObject({ compared: true, newCount: 0, changedCount: 1 });

    // Remembered: prev_snapshot is the value before, changed_at this refresh.
    const s111 = snapRows('jobs').find((r) => r.bt_id === '111');
    expect([s111.snapshot.status, s111.prev_snapshot.status, s111.changed_at]).toEqual(['Closed', 'Open', second.generatedAt]);

    const third = await refresh(ANA);
    for (const k of KINDS) expect(marked(third, k)).toEqual([]);
  });

  test('formatting Clickr does not change (money as {value} or a number, a date with or without a time) is not a change', async () => {
    await refresh(ANA);
    BT.jobs[0].contractPrice = 15000;
    BT.purchaseOrders[0].estCompleteDate = '2026-10-01';
    BT.jobs[1].street = '  5 Bay Rd  ';
    const second = await refresh(ANA);
    expect(marked(second, 'jobs')).toEqual([]);
    expect(marked(second, 'purchaseOrders')).toEqual([]);
  });
});

describe('REMOVED — a record no longer in Buildertrend', () => {
  test('is listed once, by name, on the refresh after it left', async () => {
    await refresh(ANA);
    BT.jobs = BT.jobs.filter((j) => j.jobId !== 333);
    BT.purchaseOrders = BT.purchaseOrders.filter((p) => p.purchaseOrderId !== '8003');
    const second = await refresh(ANA);
    expect(second.datasets.jobs.since).toMatchObject({ compared: true, removed: [{ btId: '333', label: 'WO16 Service Call A' }], removedTotal: 1 });
    expect(second.datasets.purchaseOrders.since.removed).toEqual([{ btId: '8003', label: '0003 Roofing (S1050 Harbor Club Railings)' }]);
    // Org 2's jobs '999' (last seen 2099) is never "removed" from AGX.
    expect(JSON.stringify(second)).not.toContain('ORG2 PROBE');
    const third = await refresh(ANA);
    expect(third.datasets.jobs.since.removed).toEqual([]);
    expect(third.datasets.purchaseOrders.since.removed).toEqual([]);
  });
});

describe('PER ADMIN — marks are relative to EACH admin\'s own previous refresh', () => {
  test('another admin refreshing in between hides nothing; each marker is its own row', async () => {
    const ana1 = await refresh(ANA);
    // Ben's first refresh: the org already remembers everything, but Ben has no
    // previous refresh — nothing is marked for him, and he is told why.
    const ben1 = await refresh(BEN);
    expect(ben1.since).toEqual({ previousRefreshAt: null });
    expect(ben1.datasets.jobs.since).toMatchObject({ compared: false, firstTime: true });

    BT.jobs.push(jobRec(444, 'S4000 Brand New Job'));
    const ana2 = await refresh(ANA);
    expect(ana2.since.previousRefreshAt).toBe(ana1.generatedAt);
    expect(marked(ana2, 'jobs')).toEqual([['444', 'new']]);
    // Ana saw it first; Ben still sees it as new since HIS last refresh.
    const ben2 = await refresh(BEN);
    expect(ben2.since.previousRefreshAt).toBe(ben1.generatedAt);
    expect(marked(ben2, 'jobs')).toEqual([['444', 'new']]);

    BT.jobs[0].jobStatus = 'Closed';
    const ana3 = await refresh(ANA);
    expect(marked(ana3, 'jobs')).toEqual([['111', 'changed']]);
    const ben3 = await refresh(BEN);
    expect(marked(ben3, 'jobs')).toEqual([['111', 'changed']]);
    expect(row(ben3, 'jobs', 111).since.changes).toEqual([{ field: 'status', label: 'Status', from: 'Open', to: 'Closed' }]);

    expect([marker(10), marker(12)]).toEqual([ana3.generatedAt, ben3.generatedAt]);
    const ana4 = await refresh(ANA);
    expect(marked(ana4, 'jobs')).toEqual([]);
  });

  test('the page\'s reload after an Apply (?since=keep) compares with the last refresh without becoming it', async () => {
    const first = await refresh(ANA);
    BT.jobs.push(jobRec(444, 'S4000 Brand New Job'));
    const kept = await refresh(ANA, { keep: true });
    expect(marked(kept, 'jobs')).toEqual([['444', 'new']]);
    expect(marker(10)).toBe(first.generatedAt);
    const kept2 = await refresh(ANA, { keep: true });
    expect(kept2.since.previousRefreshAt).toBe(first.generatedAt);
    expect(marked(kept2, 'jobs')).toEqual([['444', 'new']]);
    // A real refresh still shows it (still since the last refresh), then moves the marker.
    const real = await refresh(ANA);
    expect(marked(real, 'jobs')).toEqual([['444', 'new']]);
    expect(marker(10)).toBe(real.generatedAt);
    expect(marked(await refresh(ANA), 'jobs')).toEqual([]);
  });
});

describe('A PARTIAL READ is never remembered and never marked', () => {
  test('count mismatch on purchase orders: its snapshots are untouched, nothing is marked, it says why; the next complete read catches up', async () => {
    await refresh(ANA);
    const before = JSON.stringify(snapRows('purchaseOrders'));
    BT.purchaseOrders[0].approvalStatusText = 'Sent to Sub/Vendor - Pending';
    BT.purchaseOrders.push(poRec(8099, '0099', 'Late addition', 'Draft', 10));
    BT.jobs.push(jobRec(444, 'S4000 Brand New Job'));
    BT.purchaseOrders.push(poRec(8098, '0098', 'Another', 'Draft', 10));
    extraCount.purchaseOrders = 5;
    const second = await refresh(ANA);
    const pos = second.datasets.purchaseOrders;
    expect([pos.classified, pos.fetch.complete]).toEqual([true, false]);
    expect(pos.since).toEqual({ compared: false, partial: true, previousRefreshAt: expect.any(String), newCount: 0, changedCount: 0, removed: [], removedTotal: 0, note: since.PARTIAL_NOTE });
    expect(marked(second, 'purchaseOrders')).toEqual([]);
    expect(JSON.stringify(snapRows('purchaseOrders'))).toBe(before);
    // The complete datasets beside it are compared as usual, and the marker moves.
    expect(marked(second, 'jobs')).toEqual([['444', 'new']]);
    expect(marker(10)).toBe(second.generatedAt);

    extraCount = {};
    const third = await refresh(ANA);
    expect(marked(third, 'purchaseOrders')).toEqual([['8001', 'changed'], ['8099', 'new'], ['8098', 'new']]);
  });

  test('a dataset first remembered AFTER this admin\'s previous refresh is not a page of "new"', async () => {
    extraCount.purchaseOrders = 5;
    const ana1 = await refresh(ANA);          // purchase orders partial: not remembered
    expect(snapRows('purchaseOrders')).toEqual([]);
    expect(ana1.datasets.purchaseOrders.since.partial).toBe(true);
    extraCount = {};
    await refresh(BEN);                       // Ben's complete read remembers them first
    const ana2 = await refresh(ANA);
    expect(ana2.datasets.purchaseOrders.since).toMatchObject({ compared: false, firstTime: true });
    expect(marked(ana2, 'purchaseOrders')).toEqual([]);
  });

  test('no key, a PM, another organization\'s admin: nothing remembered, no marker written', async () => {
    const h = org2Hash();
    delete process.env.CLICKR_API_KEY;
    const nokey = await refresh(ANA);
    expect(nokey.datasets.jobs.error.kind).toBe('missing_key');
    process.env.CLICKR_API_KEY = KEY;
    expect((await call('GET', PREVIEW, PM)).status).toBe(403);
    const other = await call('GET', PREVIEW, OSCAR);
    expect([other.status, other.json.code]).toEqual([403, 'CLICKR_NOT_THIS_ORG']);
    expect(engine.db.prepare('SELECT COUNT(*) AS n FROM bt_record_snapshots WHERE organization_id = 1').get().n).toBe(0);
    expect(engine.db.prepare('SELECT COUNT(*) AS n FROM bt_preview_views WHERE organization_id = 1').get().n).toBe(0);
    expect(org2Hash()).toBe(h);
  });
});

describe('TENANCY — another organization\'s memory is never read or written', () => {
  test('org 2 rows with the same datasets, ids and user id: untouched byte for byte, never compared, never in the body', async () => {
    const h = org2Hash();
    const first = await refresh(ANA);
    // Org 2 remembered jobs '111' in 2000 and has a marker for user 10: neither counts.
    expect(first.datasets.jobs.since).toMatchObject({ compared: false, firstTime: true });
    BT.jobs.push(jobRec(444, 'S4000 Brand New Job'));
    const second = await refresh(ANA);
    expect(marked(second, 'jobs')).toEqual([['444', 'new']]);
    expect(row(second, 'jobs', 111).since).toBeUndefined();
    expect(second.datasets.jobs.since.removed).toEqual([]);
    expect(second.datasets.purchaseOrders.since.removed).toEqual([]);
    expect(JSON.stringify([first, second])).not.toContain('ORG2 PROBE');
    expect(org2Hash()).toBe(h);
    // Every AGX memory row is stamped AGX.
    expect(engine.db.prepare('SELECT DISTINCT organization_id FROM bt_record_snapshots WHERE bt_id IN (\'111\', \'8001\') ORDER BY organization_id').all().map((r) => r.organization_id)).toEqual([1, 2]);
    // Every write the preview ran names AGX as its tenant.
    const start = engine.log.length;
    BT.jobs[0].jobStatus = 'Closed';
    await refresh(ANA);
    const writes = engine.log.slice(start).filter((s) => /^(INSERT INTO|UPDATE) bt_/.test(s.sql));
    expect(writes.length).toBeGreaterThan(2);
    for (const w of writes) {
      if (/^INSERT INTO/.test(w.sql)) expect(w.params[0]).toBe(AGX);
      else expect([w.sql.includes('WHERE organization_id = $2 AND dataset = $3'), w.params[1]]).toEqual([true, AGX]);
    }
  });
});

describe('THE KEY — a Buildertrend value carrying the Clickr key is never remembered', () => {
  test('the response is withheld as before, and no snapshot and no marker is written', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await refresh(ANA);
      const before = JSON.stringify(engine.db.prepare('SELECT * FROM bt_record_snapshots ORDER BY organization_id, dataset, bt_id').all());
      const markerBefore = marker(10);
      BT.jobs[1].city = 'Tampa ' + KEY;
      await pause();
      const r = await call('GET', PREVIEW, ANA);
      expect(r.status).toBe(500);
      expect(r.json.error).toBe('The Buildertrend preview was withheld because the response contained the Clickr API key.');
      const after = JSON.stringify(engine.db.prepare('SELECT * FROM bt_record_snapshots ORDER BY organization_id, dataset, bt_id').all());
      expect(after.toLowerCase()).not.toContain(KEY.slice(-8).toLowerCase());
      expect(after).toBe(before);
      expect(marker(10)).toBe(markerBefore);
    } finally {
      quiet.mockRestore();
    }
  });
});

describe('APPLY — a change made by an Apply is not a Buildertrend change', () => {
  test('applying a correction between refreshes marks nothing Changed', async () => {
    const first = await refresh(ANA);
    expect(row(first, 'jobs', 222).class).toBe('conflict');
    const snapsBefore = JSON.stringify(engine.db.prepare('SELECT * FROM bt_record_snapshots ORDER BY organization_id, dataset, bt_id').all());
    const markerBefore = marker(10);
    await pause();
    const put = await call('PUT', APPLY, ANA, { dataset: 'jobs', btIds: ['222'] });
    expect(put.status).toBe(200);
    expect(put.json.results[0].outcome).toBe('applied');
    // Apply writes no memory and moves no marker.
    expect(JSON.stringify(engine.db.prepare('SELECT * FROM bt_record_snapshots ORDER BY organization_id, dataset, bt_id').all())).toBe(snapsBefore);
    expect(marker(10)).toBe(markerBefore);
    const second = await refresh(ANA);
    expect(row(second, 'jobs', 222).class).toBe('matched');
    for (const k of KINDS) expect(marked(second, k)).toEqual([]);
    expect(second.datasets.jobs.since.changedCount).toBe(0);
  });
});

describe('UNIT — normalizing and diffing', () => {
  test('snapshotOf and diffSnapshots', () => {
    const { readRecord } = require('../server/services/clickr/field-map');
    const a = since.snapshotOf('purchaseOrders', readRecord('purchaseOrders', poRec(1, '0001', ' Paint ', 'Draft', 0, { est: '10/01/2026' })));
    expect(a).toMatchObject({ title: 'Paint', cost: 0, amountPaid: 0, estCompleteDate: '2026-10-01', sub: null });
    const b = Object.assign({}, a, { cost: 12.5, sub: 'Catica' });
    expect(since.diffSnapshots(a, b, 'purchaseOrders')).toEqual([
      { field: 'cost', label: 'Cost', from: '$0.00', to: '$12.50' },
      { field: 'sub', label: 'Sub/vendor', from: '', to: 'Catica' },
    ]);
    // A field one snapshot does not carry is not compared.
    const old = Object.assign({}, a);
    delete old.sub;
    expect(since.diffSnapshots(old, b, 'purchaseOrders').map((c) => c.field)).toEqual(['cost']);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// THE PAGE — js/bt-sync-preview.js rendered from real and hostile responses
// ══════════════════════════════════════════════════════════════════════════
describe('PAGE — New / Changed marks, tiles, filters, tab badge, removed list', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'bt-sync-preview.js'), 'utf8');
  const XSS = '"><img src=x onerror=alert(1)>';
  const load = () => {
    const win = {};
    vm.runInNewContext(src, { window: win, document: {}, console });
    return win;
  };

  async function markedBody() {
    await refresh(ANA);
    BT.jobs.push(jobRec(444, 'S4000 Brand New Job'));
    BT.jobs.push(jobRec(445, 'RV5001 Closed History Job', { jobStatus: 'Closed' }));
    BT.jobs[0].jobStatus = 'Closed';
    BT.jobs = BT.jobs.filter((j) => j.jobId !== 333);
    BT.changeOrders[1].title = '';
    return refresh(ANA);
  }

  test('chips, the change list with "blank", the since tiles and options, the tab badge in scope, the compared sentence and the removed list', async () => {
    const body = await markedBody();
    const T = load().p86BtSyncPreview._test;
    T.setTab('jobs');
    T.setView('jobs', 'all', 'all');
    const all = T.render(body);
    expect(all).toContain('data-btp-since-chip="new"');
    expect(all).toContain('data-btp-since-chip="changed"');
    expect(all).toMatch(/<span class="btp-chip c-conflict">Corrected<\/span><span class="btp-rung">via number<\/span>/);
    expect(all).toMatch(/Changed in Buildertrend since your last refresh<\/div><ul class="btp-list"><li><b>Status<\/b>: Open → Closed<\/li><\/ul>/);
    expect(all).toMatch(/data-btp-f="since_new"><div class="btp-tile-n">2</);
    expect(all).toMatch(/data-btp-f="since_changed"><div class="btp-tile-n">1</);
    expect(all).toMatch(/data-btp-tab-new="jobs"[^>]*>3 new<\/span>/);

    T.setView('jobs', 'all', 'open');
    const html = T.render(body);
    expect(html).not.toContain('data-btp-since-chip="changed"');
    // Tiles, counted in the Open + Warranty scope: 444 is new and open; 445 is new but
    // Closed; 111 changed TO Closed, so it left the open scope.
    expect(html).toMatch(/data-btp-f="since_new"><div class="btp-tile-n">1<\/div><div class="btp-tile-l">New since your last refresh/);
    expect(html).toMatch(/data-btp-f="since_changed"><div class="btp-tile-n">0<\/div><div class="btp-tile-l">Changed since your last refresh/);
    expect(html).toContain('<option value="since_new">New since your last refresh</option>');
    expect(html).toContain('<option value="since_changed">Changed since your last refresh</option>');
    expect(html).toMatch(/data-btp-tab-new="jobs"[^>]*>1 new<\/span>/);
    expect(html).toMatch(/data-btp-tab-new="changeOrders"[^>]*>1 new<\/span>/);
    expect(html).not.toContain('data-btp-tab-new="leads"');
    expect(html).toContain('data-btp-since="compared">Compared with your last refresh, ');
    expect(html).toContain('<summary>No longer in Buildertrend since your last refresh (1)</summary><ul class="btp-list"><li>WO16 Service Call A</li></ul>');

    // The filter shows exactly the marked rows.
    T.setView('jobs', 'since_new', 'all');
    const onlyNew = T.render(body);
    expect(onlyNew).toContain('<span class="btp-sub">2 shown</span>');
    expect(onlyNew).not.toContain('data-btp-since-chip="changed"');
    T.setView('jobs', 'since_changed', 'all');
    expect(T.render(body)).toContain('<span class="btp-sub">1 shown</span>');

    T.setTab('changeOrders');
    T.setView('changeOrders', 'all');
    expect(T.render(body)).toContain('<li><b>Title</b>: Paint touch up → <span class="btp-none">blank</span></li>');
    T.setTab('jobs');
  });

  test('the first refresh: the note, and no since tiles, options or badge', async () => {
    const body = await refresh(ANA);
    const T = load().p86BtSyncPreview._test;
    T.setTab('jobs');
    T.setView('jobs', 'all', 'all');
    const html = T.render(body);
    expect(html).toContain('data-btp-since="first">' + since.FIRST_TIME_NOTE + '</div>');
    expect(html).not.toContain('data-btp-f="since_new"');
    expect(html).not.toContain('<option value="since_new"');
    expect(html).not.toContain('data-btp-tab-new=');
  });

  test('every since string is escaped: change labels and values, removed labels, notes', () => {
    const T = load().p86BtSyncPreview._test;
    const ds = (key, since0, rows) => ({ key, label: key, datasetId: 'x', fetch: { fetched: 1, reportedCount: 1, complete: true }, error: null, sentence: 'ok',
      classified: true, mapping: null, summary: {}, notInBuildertrend: { reliable: true, count: 0, sentence: '', rows: [] }, since: since0, rows });
    const r = { bt: { btId: XSS, raw: 'x', scope: 'open' }, class: 'matched', corrections: [], btBlank: [], heldBack: [], flags: [], candidates: [], notes: [],
      since: { state: 'changed', changedAt: XSS, changes: [{ field: XSS, label: XSS, from: XSS, to: XSS }] } };
    const data = { generatedAt: new Date().toISOString(), elapsedMs: 1, organization: { name: 'AGX' }, p86: { jobs: 1, leads: 0 },
      datasets: {
        jobs: ds('jobs', { compared: true, previousRefreshAt: new Date().toISOString(), newCount: 0, changedCount: 1, removed: [{ btId: XSS, label: XSS }], removedTotal: 1, note: null }, [r]),
        leads: ds('leads', { compared: false, partial: true, note: XSS }, []),
      } };
    T.setTab('jobs');
    T.setView('jobs', 'all', 'all');
    const jobs = T.render(data);
    expect(jobs).toContain('data-btp-since-changes="1"');
    expect(jobs).toContain('&lt;img src=x');
    expect(jobs).not.toMatch(/<img/i);
    T.setTab('leads');
    const leads = T.render(data);
    expect(leads).toContain('data-btp-since="partial">&quot;&gt;&lt;img');
    expect(leads).not.toMatch(/<img/i);
    T.setTab('jobs');
  });

  test('Refresh asks for a refresh; the reload after an Apply asks the server to keep the marker', async () => {
    const win = load();
    const urls = [];
    win.p86Api = {
      get: (url) => { urls.push(url); return Promise.resolve(null); },
      put: () => Promise.resolve({ mode: 'apply', counts: { applied: 1 }, results: [] }),
    };
    win.p86BtSyncPreview.reload();
    await new Promise((r) => setImmediate(r));
    win.p86BtSyncPreview._test.runApply('jobs', { btIds: ['222'], fields: [] });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(urls).toEqual([PREVIEW, PREVIEW + '&since=keep']);
  });
});
