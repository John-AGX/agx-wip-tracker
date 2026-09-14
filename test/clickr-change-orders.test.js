// Buildertrend change orders → P86 change orders (services/clickr/co-match.js,
// sync-apply.js). P86 mirrors Buildertrend: link by id, take title / status /
// price / cost when ticked, create the change orders P86 lacks on the job they
// belong to. Never un-approve, never edit an applied change order, never create
// on a job whose change orders still live in its old per-job list.
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
  sqliteSchema(tableNames(), { pk: { organizations: 'id', users: 'id', roles: 'name', jobs: 'id', leads: 'id', clients: 'id', job_change_orders: 'id' } }),
  { jsonColumns: ['data'] }
);
globalThis.__P86_CLICKR_CO_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_CLICKR_CO_ENGINE__.pool }));
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});
jest.mock('../server/geocoder', () => ({ geocodeAddress: async () => null, geocodeViaGoogle: async () => null, geocodeViaCensus: async () => null }));

const { DATASETS } = require('../server/services/clickr/field-map');
const preview = require('../server/services/clickr/sync-preview');
const coMatch = require('../server/services/clickr/co-match');
const coMoney = require('../server/services/money/change-order-totals');
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const orgRoutes = require('../server/routes/admin-organizations-routes');

const KEY = 'ck_live_Zq9SECRETKEYxy7_0123456789ab';
const BASE = 'https://api.clickr.cloud';
const AGX = 1;
const OTHER = 2;

let seq = 0;
function coRec(id, jobId, coNumber, title, status, price, cost, o) {
  seq++;
  return Object.assign({
    _id: 'clickr' + seq, accountId: 'a', integrationId: 'i', builderId: 'b', changeOrderId: String(id), __v: 0,
    approvalStatus: status === 'Approved' ? 4 : status === 'Pending' ? 1 : 0, approvalStatusText: status,
    attachedFileCount: 0, builderCost: cost, coNumber, commentCount: 0, createdAt: '2026-03-01T10:00:00.000Z', createdBy: 'Lisa Dryden', createdById: '77',
    dateAdded: '2026-03-01T10:00:00.00', isDeleted: false, isInvoiceable: false, jobId: String(jobId), jobName: 'Job ' + jobId, ownerName: 'Board',
    poBuilderVariance: 0, poCustomerVariance: 0, purchaseOrderCost: 0, raw: { secret: 'never read' }, relatedPurchaseOrderIds: [], rfiCount: 0,
    statusChangedDate: '2026-03-04T15:20:11.12', subtotal: price, title, totalMarkup: price - cost, totalPrice: price, updatedAt: '2026-03-05T10:00:00.000Z',
    statusChangedBy: 'RPM - Melissa Johnson', ownerLastViewed: null, deadline: null,
  }, o || {});
}

const BT_COS = [
  coRec(7001, 111, 'CO-0001', 'Extra railing', 'Approved', 1200, 900),
  coRec(7002, 111, 'CO-0002', 'Paint touch up', 'Pending', 700, 500),
  coRec(7003, 111, 'CO-0005', 'Gate repair', 'Approved', 999, 300),
  coRec(7004, 111, 'CO-0003', 'Brand new work', 'Approved', 2500, 1500),
  coRec(7005, 111, 'CO-0004', 'Pending new', 'Pending', 300, 0),
  coRec(7006, 222, 'CO-0001', 'Stucco patch', 'Approved', 400, 250),
  coRec(7007, 333, 'CO-0001', 'Waiting CO', 'Approved', 100, 50),
  coRec(7008, 111, 'CO-0009', 'Different title here', 'Draft', 150, 100),
  coRec(7009, 111, 'CO-0007', 'Two line job', 'Draft', 750, 450),
  coRec(7010, 111, 'CO-0008', 'Null org CO', 'Draft', 20, 10),
  coRec(7011, 111, 'CO-0010', 'Node CO', 'Approved', 40, 30),
  coRec(7012, 111, 'CO-0011', 'Linked on the wrong job', 'Approved', 50, 40),
  coRec(7013, 111, 'CO-0013', 'Deleted in BT', 'Approved', 60, 50, { isDeleted: true }),
];

function clickrFetch(url) {
  const u = new URL(url);
  if (u.origin !== BASE) throw new Error('test: fetch reached a non-Clickr host');
  const skip = Number(u.searchParams.get('skip') || 0);
  const limit = Number(u.searchParams.get('limit') || 200);
  const list = u.pathname.includes(DATASETS.changeOrders.datasetId) ? BT_COS : null;
  if (!list) return Promise.resolve({ status: 404, text: async () => '{"error":"Route not found"}' });
  const body = { recordType: 'x', columns: [], records: list.slice(skip, skip + limit), count: list.length, sort: {} };
  return Promise.resolve({ status: 200, text: async () => JSON.stringify(body) });
}

function line(o) { return Object.assign({ description: 'x', qty: 1 }, o); }

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
  `);
  const job = engine.db.prepare('INSERT INTO jobs (id, owner_id, organization_id, bt_job_id, data) VALUES (?,?,?,?,?)');
  job.run('j-1', 10, AGX, '111', JSON.stringify({ jobNumber: 'RV2000', title: 'Waterside III', status: 'In Progress' }));
  job.run('j-2', 10, AGX, '222', JSON.stringify({ jobNumber: 'RV2001', title: 'Waterside I', status: 'In Progress', changeOrders: [{ id: 'old1', income: 100, estimatedCosts: 60 }] }));
  job.run('j-3', 10, AGX, null, JSON.stringify({ jobNumber: 'RV2003', title: 'Hidden River', status: 'In Progress' }));
  job.run('j-b', 20, OTHER, '111', JSON.stringify({ jobNumber: 'RV2000', title: 'Waterside III', status: 'In Progress' }));
  const co = engine.db.prepare('INSERT INTO job_change_orders (id, job_id, owner_id, status, co_number, data, is_locked, organization_id, bt_co_id) VALUES (?,?,?,?,?,?,?,?,?)');
  co.run('co-a', 'j-1', 10, 'draft', 'CO-1', JSON.stringify({ title: 'Extra railing', lines: [line({ id: 'la', unitCost: 800, markup: 25 })] }), 0, AGX, null);
  co.run('co-b', 'j-1', 10, 'approved', 'CO-2', JSON.stringify({ title: 'Paint touch up', lines: [line({ id: 'lb', unitCost: 500, unitSell: 700 })] }), 1, AGX, null);
  co.run('co-c', 'j-1', 10, 'applied', 'CO-5', JSON.stringify({ title: 'Gate repair', lines: [line({ id: 'lc', unitCost: 300, unitSell: 400 })] }), 1, AGX, null);
  co.run('co-d', 'j-1', 10, 'draft', 'CO-9', JSON.stringify({ title: 'Something else', lines: [line({ id: 'ld', unitCost: 100, unitSell: 150 })] }), 0, AGX, null);
  co.run('co-e', 'j-1', 10, 'draft', 'CO-12', JSON.stringify({ title: 'Orphan in P86', lines: [line({ id: 'le', unitCost: 50, unitSell: 60 })] }), 0, AGX, null);
  co.run('co-f', 'j-1', 10, 'draft', 'CO-7', JSON.stringify({ title: 'Two line job', lines: [line({ id: 'lf1', qty: 2, unitCost: 100, markup: 50 }), line({ id: 'lf2', unitCost: 200, markup: 50 })] }), 0, AGX, null);
  co.run('co-g', 'j-1', 10, 'draft', 'CO-8', JSON.stringify({ title: 'Null org CO', lines: [line({ id: 'lg', unitCost: 10, unitSell: 20 })] }), 0, null, null);
  co.run('co-h', 'j-1', 10, 'draft', 'CO-10', JSON.stringify({ title: 'Node CO', lines: [line({ id: 'lh', unitCost: 30, unitSell: 40 })] }), 0, AGX, null);
  engine.db.prepare("UPDATE job_change_orders SET linked_node_id = 'node-1' WHERE id = 'co-h'").run();
  co.run('co-i', 'j-3', 10, 'draft', 'CO-11', JSON.stringify({ title: 'Linked on the wrong job', lines: [line({ id: 'li', unitCost: 40, unitSell: 50 })] }), 0, AGX, '7012');
  co.run('co-x', 'j-b', 20, 'draft', 'CO-1', JSON.stringify({ title: 'Extra railing', lines: [line({ id: 'lx', unitCost: 800, markup: 25 })] }), 0, OTHER, null);
}

const coRow = (id) => engine.db.prepare('SELECT * FROM job_change_orders WHERE id = ?').get(id);
const coData = (id) => JSON.parse(coRow(id).data);
const coM = (id) => coMoney.changeOrderMoney(coData(id));
const coByBt = (btId) => engine.db.prepare('SELECT * FROM job_change_orders WHERE bt_co_id = ?').all(btId);

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
const OTHER_ADMIN = { id: 20, email: 'admin@other.test', name: 'Oscar Other', role: 'admin', organization_id: OTHER };
const put = (user, body) => call('PUT', APPLY, user, Object.assign({ dataset: 'changeOrders' }, body));

async function coRows() {
  preview.forgetFetch(AGX);
  const r = await call('GET', PREVIEW, ADMIN);
  expect(r.status).toBe(200);
  return r.json.datasets.changeOrders;
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

describe('PREVIEW — every Buildertrend change order matched inside its own linked job', () => {
  test('classes, rungs and proposals', async () => {
    const ds = await coRows();
    expect(ds.classified).toBe(true);
    expect(ds.mapping.missingKeys).toEqual([]);
    expect(ds.mapping.unexpectedKeys).toEqual([]);

    const r1 = byBt(ds, 7001);
    expect([r1.class, r1.rung, r1.p86.id]).toEqual(['conflict', 'CO number', 'co-a']);
    const fix = Object.fromEntries(r1.corrections.map((c) => [c.field, c]));
    expect(Object.keys(fix).sort()).toEqual(['cost', 'price', 'status']);
    expect([fix.status.from, fix.status.to, fix.status.money]).toEqual(['draft', 'approved', true]);
    expect([fix.price.p86Value, fix.price.value, fix.cost.p86Value, fix.cost.value]).toEqual([1000, 1200, 800, 900]);

    // P86 approved, Buildertrend pending: held back, never applicable.
    const r2 = byBt(ds, 7002);
    expect(r2.class).toBe('matched');
    expect(r2.heldBack.map((h) => [h.field, h.applicable])).toEqual([['status', false]]);

    // Applied in P86: the price difference is shown, never applicable.
    const r3 = byBt(ds, 7003);
    expect(r3.corrections).toEqual([]);
    expect(r3.heldBack.map((h) => [h.field, h.applicable])).toEqual([['price', false]]);

    expect(byBt(ds, 7004).class).toBe('new');
    expect(byBt(ds, 7005).class).toBe('new');
    const r6 = byBt(ds, 7006);
    expect(r6.class).toBe('new');
    expect(r6.createBlocked).toMatch(/old per-job list/);
    const r7 = byBt(ds, 7007);
    expect([r7.class, r7.waitingOnJob]).toEqual(['refused', true]);

    const r8 = byBt(ds, 7008);
    expect(r8.class).toBe('ambiguous');
    expect(r8.candidates.map((c) => c.id)).toEqual(['co-d']);

    // Several unpromised lines: price via a client price is offered; cost is not
    // (it would move the price), so it is held back.
    const r9 = byBt(ds, 7009);
    expect(r9.corrections.map((c) => c.field)).toEqual(['price']);
    expect(r9.heldBack.map((h) => [h.field, h.applicable])).toEqual([['cost', false]]);

    // A change order row with no organization is still reached through its job.
    expect(byBt(ds, 7010).p86.id).toBe('co-g');

    // Linked to a Site Plan node: approval is held back for P86's own status route.
    const r11 = byBt(ds, 7011);
    expect(r11.corrections).toEqual([]);
    expect(r11.heldBack.map((h) => [h.field, h.applicable])).toEqual([['status', false]]);
    // Its P86 link sits on a job that is not Buildertrend's job: nothing proposed, never created.
    const r12 = byBt(ds, 7012);
    expect([r12.class, r12.p86]).toEqual(['refused', null]);
    expect(byBt(ds, 7013).class).toBe('refused');

    // Not in Buildertrend: the P86-only change order, never another tenant's.
    expect(ds.notInBuildertrend.rows.map((p) => p.id)).toEqual(['co-e']);
    const everyId = JSON.stringify(ds.rows);
    expect(everyId).not.toContain('co-x');
  });
});

describe('APPLY — ticked fields only; approve, price and cost land exactly', () => {
  test('every correction on CO-0001: approved and locked with Buildertrend\'s date, price and cost to the cent, linked', async () => {
    const r = await put(ADMIN, { btIds: ['7001'] });
    expect(r.status).toBe(200);
    expect(r.json.counts.applied).toBe(1);
    const row = coRow('co-a');
    expect(row.status).toBe('approved');
    expect(Boolean(row.is_locked)).toBe(true);
    expect(String(row.approved_at)).toMatch(/^2026-03-04/);
    expect(row.approved_by).toBeNull();
    expect(row.bt_co_id).toBe('7001');
    expect(coM('co-a')).toEqual({ income: 1200, costs: 900 });
    expect(coData('co-a').approvedInBuildertrend).toEqual({ by: 'RPM - Melissa Johnson', date: '2026-03-04' });
    // Re-read: linked by id, nothing left to correct.
    const again = byBt(await coRows(), 7001);
    expect([again.class, again.rung]).toEqual(['matched', 'Buildertrend ID']);
  });

  test('only the ticked box: cost changes, the price and the draft status stay', async () => {
    await put(ADMIN, { btIds: ['7001'], fields: ['cost'] });
    expect(coM('co-a')).toEqual({ income: 1000, costs: 900 });
    expect(coRow('co-a').status).toBe('draft');
  });

  test('a price on several unpromised lines is reached with a client price', async () => {
    await put(ADMIN, { btIds: ['7009'], fields: ['price'] });
    const m = coM('co-f');
    expect(Math.abs(m.income - 750)).toBeLessThan(0.005);
    expect(m.costs).toBe(400);
  });

  test('an applied change order is never edited, even when price is asked for by name', async () => {
    const before = coRow('co-c').data;
    await put(ADMIN, { btIds: ['7003'], fields: ['price', 'title', 'status'] });
    expect(coRow('co-c').data).toBe(before);
    expect(coRow('co-c').status).toBe('applied');
  });

  test('a Site Plan-linked draft is not approved by a sync, even when status is asked for by name', async () => {
    await put(ADMIN, { btIds: ['7011'], fields: ['status'] });
    expect(coRow('co-h').status).toBe('draft');
    expect(coRow('co-h').bt_co_id).toBe('7011');
  });

  test('a sync never un-approves: Pending in Buildertrend leaves an approved P86 change order approved', async () => {
    await put(ADMIN, { btIds: ['7002'], fields: ['status'] });
    expect(coRow('co-b').status).toBe('approved');
  });

  test('safe mode links the confident matches and changes nothing else', async () => {
    const r = await put(ADMIN, { mode: 'safe' });
    expect(r.status).toBe(200);
    expect(['co-a', 'co-b', 'co-c', 'co-f', 'co-g', 'co-h'].map((id) => coRow(id).bt_co_id)).toEqual(['7001', '7002', '7003', '7009', '7010', '7011']);
    expect(coRow('co-a').status).toBe('draft');
    expect(coM('co-a')).toEqual({ income: 1000, costs: 800 });
    expect(coRow('co-d').bt_co_id).toBeNull();
    expect(coRow('co-x').bt_co_id).toBeNull();
  });
});

describe('CREATE — the change orders P86 lacks, on the job they belong to', () => {
  test('one: approved, locked, Buildertrend\'s number, price and cost as one line; a second press does nothing', async () => {
    const r = await put(ADMIN, { mode: 'create', btIds: ['7004'] });
    expect(r.json.counts.created).toBe(1);
    const [row] = coByBt('7004');
    expect([row.job_id, row.status, row.co_number, Boolean(row.is_locked), row.approved_by, row.owner_id]).toEqual(['j-1', 'approved', 'CO-0003', true, null, 10]);
    expect(String(row.organization_id)).toBe(String(AGX));
    expect(coMoney.changeOrderMoney(JSON.parse(row.data))).toEqual({ income: 2500, costs: 1500 });
    const again = await put(ADMIN, { mode: 'create', btIds: ['7004'] });
    expect(again.json.counts.created || 0).toBe(0);
    expect(coByBt('7004')).toHaveLength(1);
  });

  test('bulk: every creatable one; the legacy-list job and the unlinked job get nothing; no cost means cost = price, flagged', async () => {
    const r = await put(ADMIN, { mode: 'create' });
    expect(r.json.counts.created).toBe(2);
    expect(coByBt('7004')).toHaveLength(1);
    const [pending] = coByBt('7005');
    expect(pending.status).toBe('draft');
    const d = JSON.parse(pending.data);
    expect(d.lines[0].costPending).toBe(true);
    expect(coMoney.changeOrderMoney(d)).toEqual({ income: 300, costs: 300 });
    expect(coByBt('7006')).toHaveLength(0);
    expect(coByBt('7007')).toHaveLength(0);
    expect(coByBt('7012')).toHaveLength(1);
    expect(coByBt('7013')).toHaveLength(0);
    expect(coRow('co-h').status).toBe('draft');
    expect(engine.db.prepare("SELECT COUNT(*) AS n FROM job_change_orders WHERE job_id = 'j-2'").get().n).toBe(0);
  });

  test('the blocked row cannot be created by id either', async () => {
    const r = await put(ADMIN, { mode: 'create', btIds: ['7006'] });
    expect(r.json.counts.created || 0).toBe(0);
    expect(coByBt('7006')).toHaveLength(0);
  });
});

describe('LINK — a person picks the P86 change order for an ambiguous row', () => {
  test('the listed candidate links; an unlisted one, or another tenant\'s, does not', async () => {
    expect((await put(ADMIN, { mode: 'link', btId: '7008', p86Id: 'co-e' })).json.counts.linked).toBe(0);
    expect((await put(ADMIN, { mode: 'link', btId: '7008', p86Id: 'co-x' })).json.counts.linked).toBe(0);
    expect(coRow('co-e').bt_co_id).toBeNull();
    expect(coRow('co-x').bt_co_id).toBeNull();
    const ok = await put(ADMIN, { mode: 'link', btId: '7008', p86Id: 'co-d' });
    expect(ok.json.counts.linked).toBe(1);
    expect(coRow('co-d').bt_co_id).toBe('7008');
  });
});

describe('GATES', () => {
  test('a PM and another organization\'s admin are refused, and nothing is written', async () => {
    expect((await put(PM, { mode: 'create' })).status).toBe(403);
    const other = await put(OTHER_ADMIN, { mode: 'create' });
    expect(other.status).toBe(403);
    expect(coByBt('7004')).toHaveLength(0);
  });
});

describe('UNIT — withPrice / withCost prove the figure before anything is offered', () => {
  const d = (lines, extra) => Object.assign({ lines }, extra || {});
  test('one line: price and cost set exactly, the other figure holds', () => {
    const base = d([line({ unitCost: 800, markup: 25 })]);
    expect(coMatch.money(coMatch.withPrice(base, 1234.56))).toEqual({ income: 1234.56, costs: 800 });
    const c = coMatch.withCost(base, 900);
    expect(coMatch.money(c)).toEqual({ income: 1000, costs: 900 });
  });
  test('several lines without promised prices: cost refused; with promised prices: cost scales and price holds', () => {
    expect(coMatch.withCost(d([line({ unitCost: 100, markup: 50 }), line({ unitCost: 200, markup: 50 })]), 450)).toBeNull();
    const promised = d([line({ unitCost: 100, unitSell: 150 }), line({ unitCost: 300, unitSell: 350 })]);
    const m = coMatch.money(coMatch.withCost(promised, 200));
    expect(Math.abs(m.costs - 200)).toBeLessThan(0.005);
    expect(m.income).toBe(500);
  });
  test('no content lines: nothing is offered', () => {
    expect(coMatch.withPrice(d([]), 100)).toBeNull();
    expect(coMatch.withCost(d([]), 100)).toBeNull();
  });
});

describe('PAGE — the Change orders tab', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'bt-sync-preview.js'), 'utf8');
  const win = {};
  vm.runInNewContext(src, { window: win, document: {}, console });
  const T = win.p86BtSyncPreview._test;

  test('Create shows only where a change order can be created; a waiting row says why', async () => {
    const ds = await coRows();
    const data = { generatedAt: new Date().toISOString(), elapsedMs: 1, organization: { name: 'AGX' }, p86: { jobs: 1, leads: 0 },
      datasets: { jobs: { key: 'jobs', rows: [] }, leads: { key: 'leads', rows: [] }, changeOrders: ds } };
    T.setTab('changeOrders');
    T.setView('changeOrders', 'all');
    const html = T.render(data);
    expect(html).toContain('data-btp-create="7004"');
    expect(html).toContain('data-btp-create="7005"');
    expect(html).not.toContain('data-btp-create="7006"');
    expect(html).not.toContain('data-btp-create="7007"');
    expect(html).toContain('Waiting on its job');
    expect(html).toContain('data-btp-link="7008" data-btp-link-p86="co-d"');
    expect(html).toMatch(/Create 2 Buildertrend-only change orders in P86/);
    T.setView('changeOrders', 'notinbt');
    const nib = T.render(data);
    expect(nib).toContain('CO-12 Orphan in P86');
    expect(nib).not.toContain('data-btp-archive=');
    T.setTab('jobs');
  });
});
