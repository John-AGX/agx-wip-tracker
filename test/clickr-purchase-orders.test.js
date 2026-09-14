// Buildertrend purchase orders → P86 purchase orders (services/clickr/po-match.js,
// sync-apply.js). Status moves forward only; cost lands on an unlocked PO's line
// or, ticked on purpose, as an approved addendum on a locked one — never below
// what is billed; a sub is filled only from exactly one sub of THIS organization.
// No bill is ever created and no sub portal access is ever granted.
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
  sqliteSchema(tableNames(), { pk: { organizations: 'id', users: 'id', roles: 'name', jobs: 'id', leads: 'id', clients: 'id', job_purchase_orders: 'id', subs: 'id', job_vendor_bills: 'id' } }),
  { jsonColumns: ['data'] }
);
globalThis.__P86_CLICKR_PO_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_CLICKR_PO_ENGINE__.pool }));
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});
jest.mock('../server/geocoder', () => ({ geocodeAddress: async () => null, geocodeViaGoogle: async () => null, geocodeViaCensus: async () => null }));

const { DATASETS } = require('../server/services/clickr/field-map');
const preview = require('../server/services/clickr/sync-preview');
const poMatch = require('../server/services/clickr/po-match');
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const orgRoutes = require('../server/routes/admin-organizations-routes');

const KEY = 'ck_live_Zq9SECRETKEYxy7_0123456789ab';
const BASE = 'https://api.clickr.cloud';
const AGX = 1;
const OTHER = 2;

let seq = 0;
function poRec(id, jobId, poNumber, title, status, cost, o) {
  seq++;
  o = o || {};
  return Object.assign({
    _id: 'clickr' + seq, accountId: 'a', integrationId: 'i', builderId: 'b', purchaseOrderId: String(id), __v: 0,
    amountPaid: 0, amountRemaining: cost, approvalStatus: 2, approvalStatusText: status, approvalUser: 'Catica Office', approvalNote: null,
    attachedFileCount: 0, builderVarianceCodes: [], commentCount: 0, cost, costCodes: o.codes || ['Subcontractors Costs'],
    createdAt: '2026-03-01T10:00:00.000Z', createdBy: 'Lisa Dryden', createdById: '77', dateAdded: '2026-03-01T10:00:00.00',
    estCompleteDate: o.est || null, externalId: '00000000-0000-0000-0000-00000000000' + (seq % 10), fromEstimate: false, hasAmendment: false,
    isBill: false, isDeleted: !!o.deleted, isOriginatedFromAccounting: false, isRecalled: !!o.recalled, jobId: String(jobId), jobName: 'Job ' + jobId,
    ownerVarianceCodes: [], paidStatus: 1, paidStatusText: 'Not Paid', paymentRequested: false, performingUserId: o.sub ? '9' + seq : null,
    performingUserName: o.sub || null, poNumber, rfiCount: 0, title, updatedAt: '2026-03-05T10:00:00.000Z', workStatus: 1,
    workStatusText: o.work || 'Not Complete', raw: { secret: 'never read' },
  }, o.extra || {});
}

const BT_POS = [
  poRec(8001, 111, '0001', 'Exterior paint labor', 'Sub/Vendor Approved', 5500, { sub: 'Catica International Inc', est: '2026-10-01T00:00:00' }),
  poRec(8002, 111, '0002', 'Stucco repair', 'Sub/Vendor Approved', 3600, { sub: 'Five Star Remodeling & Cleaning LLC', work: 'Complete' }),
  poRec(8003, 111, '0003', 'Roofing', 'Sent to Sub/Vendor - Pending', 2000, { sub: 'Five Star Remodeling & Cleaning LLC' }),
  poRec(8004, 111, '0004', 'Different title entirely', 'Draft', 400),
  poRec(8005, 111, '0005', 'Low cost', 'Internally Approved', 800),
  poRec(8006, 111, '0006', 'Closed PO', 'Sub/Vendor Approved', 999),
  poRec(8007, 111, '0007', 'Null org PO', 'Draft', 100),
  poRec(8010, 111, '0010', 'New sub PO', 'Sub/Vendor Approved', 4200, { sub: 'CATICA INTERNATIONAL, INC.' }),
  poRec(8011, 111, '0011', 'Materials run', 'Draft', 750, { sub: 'Home Depot', codes: ['Materials & Supplies Costs'] }),
  poRec(8012, 222, '0001', 'Legacy job PO', 'Sub/Vendor Approved', 300),
  poRec(8013, 333, '0001', 'Waiting PO', 'Sub/Vendor Approved', 300),
  poRec(8014, 111, '0014', 'Deleted PO', 'Sub/Vendor Approved', 300, { deleted: true }),
  poRec(8015, 111, '0015', 'Recalled PO', 'Sub/Vendor Approved', 300, { recalled: true }),
  poRec(8016, 111, '0016', 'Foreign sub only', 'Approved - Assigned Internally', 1200, { sub: 'Other Tenant Sub' }),
];

function clickrFetch(url) {
  const u = new URL(url);
  if (u.origin !== BASE) throw new Error('test: fetch reached a non-Clickr host');
  const skip = Number(u.searchParams.get('skip') || 0);
  const limit = Number(u.searchParams.get('limit') || 200);
  const list = u.pathname.includes(DATASETS.purchaseOrders.datasetId) ? BT_POS : null;
  if (!list) return Promise.resolve({ status: 404, text: async () => '{"error":"Route not found"}' });
  const body = { recordType: 'x', columns: [], records: list.slice(skip, skip + limit), count: list.length, sort: {} };
  return Promise.resolve({ status: 200, text: async () => JSON.stringify(body) });
}

const line = (cost) => ({ description: 'x', qty: 1, unitCost: cost });

function seed() {
  engine.db.exec(`
    DELETE FROM jobs; DELETE FROM users; DELETE FROM roles; DELETE FROM organizations; DELETE FROM subs;
    DELETE FROM job_purchase_orders; DELETE FROM job_vendor_bills; DELETE FROM job_subs; DELETE FROM attachment_folder_grants;
    INSERT INTO organizations (id, slug, name) VALUES (1, 'agx', 'AGX Central Florida'), (2, 'other', 'Other Builders');
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ROLES_MANAGE","USERS_MANAGE","JOBS_VIEW_ALL"]'),
      ('pm', 'PM', '["JOBS_VIEW_ALL","LEADS_VIEW"]');
    INSERT INTO users (id, email, password_hash, name, role, organization_id, active) VALUES
      (10, 'admin@agx.test', 'x', 'Ana Ruiz', 'admin', 1, 1),
      (11, 'pm@agx.test', 'x', 'Pat PM', 'pm', 1, 1),
      (20, 'admin@other.test', 'x', 'Oscar Other', 'admin', 2, 1);
    INSERT INTO subs (id, name, organization_id, status) VALUES
      ('s-1', 'Catica International Inc', 1, 'active'),
      ('s-2', 'Five Star Remodeling & Cleaning LLC', 1, 'active'),
      ('s-x', 'Other Tenant Sub', 2, 'active');
  `);
  const job = engine.db.prepare('INSERT INTO jobs (id, owner_id, organization_id, bt_job_id, data) VALUES (?,?,?,?,?)');
  job.run('j-1', 10, AGX, '111', JSON.stringify({ jobNumber: 'RV2004', title: 'Citi Lakes', status: 'In Progress' }));
  job.run('j-2', 10, AGX, '222', JSON.stringify({ jobNumber: 'RV2000', title: 'Waterside III', status: 'In Progress', purchaseOrders: [{ id: 'old', amount: 100 }] }));
  job.run('j-3', 10, AGX, null, JSON.stringify({ jobNumber: 'RV2013', title: 'Saddlebrook', status: 'In Progress' }));
  job.run('j-b', 20, OTHER, '111', JSON.stringify({ jobNumber: 'RV2004', title: 'Citi Lakes', status: 'In Progress' }));
  const po = engine.db.prepare('INSERT INTO job_purchase_orders (id, job_id, organization_id, owner_id, sub_id, status, po_number, data, is_locked) VALUES (?,?,?,?,?,?,?,?,?)');
  po.run('po-a', 'j-1', AGX, 10, null, 'draft', '0001', JSON.stringify({ title: 'Exterior paint labor', lines: [line(5000)] }), 0);
  po.run('po-b', 'j-1', AGX, 10, 's-2', 'approved', 'PO-0002', JSON.stringify({ title: 'Stucco Repair', lines: [line(3000)], baselineTotal: 3000 }), 1);
  po.run('po-c', 'j-1', AGX, 10, 's-1', 'work_complete', '0003', JSON.stringify({ title: 'Roofing', lines: [line(2000)], baselineTotal: 2000 }), 1);
  po.run('po-d', 'j-1', AGX, 10, null, 'draft', '0004', JSON.stringify({ title: 'Something else', lines: [line(400)] }), 0);
  po.run('po-e', 'j-1', AGX, 10, null, 'draft', '0009', JSON.stringify({ title: 'P86 only', lines: [line(10)] }), 0);
  po.run('po-f', 'j-1', AGX, 10, null, 'approved', '0005', JSON.stringify({ title: 'Low cost', lines: [line(1000)], baselineTotal: 1000 }), 1);
  po.run('po-g', 'j-1', AGX, 10, null, 'closed', '0006', JSON.stringify({ title: 'Closed PO', lines: [line(500)], baselineTotal: 500 }), 1);
  po.run('po-h', 'j-1', null, 10, 's-x', 'draft', '0007', JSON.stringify({ title: 'Null org PO', lines: [line(100)] }), 0);
  po.run('po-x', 'j-b', OTHER, 20, null, 'draft', '0001', JSON.stringify({ title: 'Exterior paint labor', lines: [line(5000)] }), 0);
  const bill = engine.db.prepare('INSERT INTO job_vendor_bills (id, job_id, po_id, status, amount, organization_id) VALUES (?,?,?,?,?,?)');
  bill.run('b-1', 'j-1', 'po-b', 'open', 1000, AGX);
  bill.run('b-2', 'j-1', 'po-f', 'approved', 900, AGX);
}

const poRow = (id) => engine.db.prepare('SELECT * FROM job_purchase_orders WHERE id = ?').get(id);
const poData = (id) => JSON.parse(poRow(id).data);
const poByBt = (btId) => engine.db.prepare('SELECT * FROM job_purchase_orders WHERE bt_po_id = ?').all(btId);
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
const PM = { id: 11, email: 'pm@agx.test', name: 'Pat PM', role: 'pm', organization_id: AGX };
const put = (user, body) => call('PUT', APPLY, user, Object.assign({ dataset: 'purchaseOrders' }, body));

async function poRows() {
  preview.forgetFetch(AGX);
  const r = await call('GET', PREVIEW, ADMIN);
  expect(r.status).toBe(200);
  return r.json.datasets.purchaseOrders;
}
const byBt = (ds, id) => ds.rows.find((r) => String(r.bt.btId) === String(id));

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

describe('PREVIEW — purchase orders matched inside their own linked job', () => {
  test('classes, rungs and proposals', async () => {
    const ds = await poRows();
    expect(ds.classified).toBe(true);
    expect(ds.mapping.missingKeys).toEqual([]);
    expect(ds.mapping.unexpectedKeys).toEqual([]);

    const r1 = byBt(ds, 8001);
    expect([r1.class, r1.rung, r1.p86.id]).toEqual(['conflict', 'PO number', 'po-a']);
    const f1 = Object.fromEntries(r1.corrections.map((c) => [c.field, c]));
    expect(Object.keys(f1).sort()).toEqual(['cost', 'costCode', 'scheduledCompletion', 'status', 'sub']);
    expect([f1.status.value, f1.sub.value, f1.cost.value, f1.scheduledCompletion.to]).toEqual(['approved', 's-1', 5500, '2026-10-01']);

    // Locked: the status moves forward; the cost is an addendum a person must tick.
    const r2 = byBt(ds, 8002);
    expect(r2.corrections.map((c) => [c.field, c.value])).toEqual([['status', 'work_complete']]);
    expect(r2.heldBack.map((h) => [h.field, h.applicable])).toEqual([['title', false], ['cost', true]]);

    // Backwards status and a DIFFERENT sub: shown, never applicable.
    expect(byBt(ds, 8003).heldBack.map((h) => [h.field, h.applicable])).toEqual([['status', false], ['sub', false]]);
    expect(byBt(ds, 8004).class).toBe('ambiguous');
    expect(byBt(ds, 8005).heldBack.map((h) => [h.field, h.applicable])).toEqual([['cost', false]]);
    expect(byBt(ds, 8006).heldBack.map((h) => [h.field, h.applicable])).toEqual([['status', false], ['cost', false]]);
    expect(byBt(ds, 8007).p86.id).toBe('po-h');
    // Its sub belongs to another organization: the name never reaches the page.
    expect(byBt(ds, 8007).p86.subName).toBe('');

    expect(byBt(ds, 8010).class).toBe('new');
    expect(byBt(ds, 8012).createBlocked).toMatch(/old per-job list/);
    expect([byBt(ds, 8013).class, byBt(ds, 8013).waitingOnJob]).toEqual(['refused', true]);
    expect(byBt(ds, 8014).class).toBe('refused');
    expect(byBt(ds, 8015).class).toBe('refused');
    // Another organization's sub of that exact name is not a P86 sub here.
    expect(byBt(ds, 8016).notes.join(' ')).toMatch(/not a P86 sub yet/);

    expect(ds.notInBuildertrend.rows.map((p) => p.id)).toEqual(['po-e']);
    expect(JSON.stringify(ds)).not.toContain('po-x');
  });
});

describe('APPLY — forward status, cost on the line or as an approved addendum', () => {
  test('every correction on 0001: approved and locked at Buildertrend\'s cost, sub, cost code and completion filled, linked', async () => {
    const r = await put(ADMIN, { btIds: ['8001'] });
    expect(r.status).toBe(200);
    const row = poRow('po-a');
    expect([row.status, Boolean(row.is_locked), row.sub_id, row.bt_po_id, row.approved_by]).toEqual(['approved', true, 's-1', '8001', null]);
    expect(row.approved_at).not.toBeNull();
    const d = poData('po-a');
    expect([poMatch.poTotal(d), d.baselineTotal, d.costCode, d.scheduledCompletion]).toEqual([5500, 5500, 'Subcontractors Costs', '2026-10-01']);
    const again = byBt(await poRows(), 8001);
    expect([again.class, again.rung]).toEqual(['matched', 'Buildertrend ID']);
  });

  test('status alone leaves the locked price; the ticked cost records one approved addendum', async () => {
    await put(ADMIN, { btIds: ['8002'], fields: ['status'] });
    expect(poRow('po-b').status).toBe('work_complete');
    expect(poMatch.poTotal(poData('po-b'))).toBe(3000);
    await put(ADMIN, { btIds: ['8002'], fields: ['cost'] });
    const d = poData('po-b');
    expect(poMatch.poTotal(d)).toBe(3600);
    expect(d.addendums.map((a) => [a.delta, a.status, a.source])).toEqual([[600, 'approved', 'buildertrend']]);
    expect(Boolean(poRow('po-b').is_locked)).toBe(true);
  });

  test('never backwards, never below billed, never on a closed PO — even when asked by name', async () => {
    await put(ADMIN, { btIds: ['8003'], fields: ['status'] });
    expect(poRow('po-c').status).toBe('work_complete');
    await put(ADMIN, { btIds: ['8005'], fields: ['cost'] });
    expect(poMatch.poTotal(poData('po-f'))).toBe(1000);
    await put(ADMIN, { btIds: ['8006'], fields: ['cost'] });
    expect(poMatch.poTotal(poData('po-g'))).toBe(500);
  });

  test('no bill, no sub assignment and no folder grant is ever written', async () => {
    const bills = count('job_vendor_bills');
    await put(ADMIN, { mode: 'safe' });
    await put(ADMIN, { btIds: ['8001', '8002'] });
    await put(ADMIN, { mode: 'create' });
    expect(count('job_vendor_bills')).toBe(bills);
    expect(count('job_subs')).toBe(0);
    expect(count('attachment_folder_grants')).toBe(0);
  });
});

describe('CREATE — the purchase orders P86 lacks', () => {
  test('one: committed and locked at Buildertrend\'s cost, the sub resolved by name, no P86 approver', async () => {
    const r = await put(ADMIN, { mode: 'create', btIds: ['8010'] });
    expect(r.json.counts.created).toBe(1);
    const [row] = poByBt('8010');
    expect([row.job_id, row.status, row.po_number, Boolean(row.is_locked), row.sub_id, row.approved_by]).toEqual(['j-1', 'approved', '0010', true, 's-1', null]);
    expect(String(row.organization_id)).toBe(String(AGX));
    const d = JSON.parse(row.data);
    expect([poMatch.poTotal(d), d.baselineTotal, d.costCode]).toEqual([4200, 4200, 'Subcontractors Costs']);
    expect(typeof d.scope).toBe('string');
  });

  test('bulk: the creatable ones only; an unknown or foreign sub is left blank with the vendor name kept', async () => {
    const r = await put(ADMIN, { mode: 'create' });
    expect(r.json.counts.created).toBe(3);
    const [draft] = poByBt('8011');
    expect([draft.status, Boolean(draft.is_locked), draft.sub_id, JSON.parse(draft.data).vendorName]).toEqual(['draft', false, null, 'Home Depot']);
    const [foreign] = poByBt('8016');
    expect([foreign.status, foreign.sub_id, JSON.parse(foreign.data).vendorName]).toEqual(['approved', null, 'Other Tenant Sub']);
    for (const id of ['8012', '8013', '8014', '8015']) expect(poByBt(id)).toHaveLength(0);
    expect(engine.db.prepare("SELECT COUNT(*) AS n FROM job_purchase_orders WHERE job_id = 'j-2'").get().n).toBe(0);
  });
});

describe('LINK and GATES', () => {
  test('only the listed candidate links; another tenant\'s PO never does', async () => {
    expect((await put(ADMIN, { mode: 'link', btId: '8004', p86Id: 'po-e' })).json.counts.linked).toBe(0);
    expect((await put(ADMIN, { mode: 'link', btId: '8004', p86Id: 'po-x' })).json.counts.linked).toBe(0);
    expect((await put(ADMIN, { mode: 'link', btId: '8004', p86Id: 'po-d' })).json.counts.linked).toBe(1);
    expect(poRow('po-d').bt_po_id).toBe('8004');
    expect(poRow('po-x').bt_po_id).toBeNull();
  });

  test('a PM is refused and nothing is written', async () => {
    expect((await put(PM, { mode: 'create' })).status).toBe(403);
    expect(poByBt('8010')).toHaveLength(0);
  });
});

describe('UNIT', () => {
  test('Buildertrend statuses map forward-only onto P86\'s', () => {
    expect(poMatch.btPoState('Draft', 'Not Complete')).toBe('draft');
    expect(poMatch.btPoState('Sent to Sub/Vendor - Pending', 'Complete')).toBe('issued');
    expect(poMatch.btPoState('Approved - Assigned Internally', 'Not Complete')).toBe('approved');
    expect(poMatch.btPoState('Internally Approved', 'Complete')).toBe('work_complete');
    expect(poMatch.btPoState('Something new', '')).toBeNull();
  });
  test('an addendum is refused when there is nothing to record; several lines refuse a line cost', () => {
    expect(poMatch.withAddendum({ lines: [line(100)], baselineTotal: 100 }, 100)).toBeNull();
    expect(poMatch.withLineCost({ lines: [line(100), line(50)] }, 300)).toBeNull();
  });
});

describe('PAGE — the Purchase orders tab', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'bt-sync-preview.js'), 'utf8');
  const win = {};
  vm.runInNewContext(src, { window: win, document: {}, console });
  const T = win.p86BtSyncPreview._test;

  test('Create only where a purchase order can be created; the addendum box starts unticked', async () => {
    const ds = await poRows();
    const data = { generatedAt: new Date().toISOString(), elapsedMs: 1, organization: { name: 'AGX' }, p86: { jobs: 1, leads: 0 },
      datasets: { jobs: { key: 'jobs', rows: [] }, leads: { key: 'leads', rows: [] }, purchaseOrders: ds } };
    T.resetPicks();
    T.setTab('purchaseOrders');
    T.setView('purchaseOrders', 'all');
    const html = T.render(data);
    expect(html).toContain('data-btp-create="8010"');
    expect(html).not.toContain('data-btp-create="8012"');
    expect(html).not.toContain('data-btp-create="8013"');
    expect(html).toContain('Waiting on its job');
    expect(html).toMatch(/Create 3 Buildertrend-only purchase orders in P86/);
    expect(html).toMatch(/data-btp-pick="cost" data-btp-row="8002"(?! checked)/);
    expect(html).toMatch(/data-btp-pick="status" data-btp-row="8002" checked/);
    T.setTab('jobs');
  });
});
