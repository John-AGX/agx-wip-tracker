// Buildertrend bills -> P86 vendor bills (services/clickr/bill-match.js,
// field-map.js, sync-preview.js, sync-apply.js).
//
// The promises this file exists to hold:
//   * a bill is matched only inside the P86 job its Buildertrend job is linked
//     to, by a saved bt_bill_id or by the job plus the vendor invoice number,
//     and two candidates refuse rather than guess;
//   * MONEY NEVER MOVES BY ITSELF. The amount is a held-back item: the safe
//     press does not apply it, an "apply everything" press that names no fields
//     does not apply it, and the DATABASE ROW is asserted unchanged after both;
//   * payment status moves forward only along open -> approved -> paid, never
//     back, and a Buildertrend word P86 has none for is held back naming itself;
//   * a bill's purchase order is resolved ONLY through the bt_po_id a P86
//     purchase order already carries, on the same job, and never guessed;
//   * a deleted or duplicated Buildertrend bill is never created, and a P86 bill
//     linked to one is named rather than silently dropped;
//   * every read and write is this organization's, and a created bill takes its
//     organization from its parent JOB, never from the request;
//   * describeMapping names a declared key no record carries and a carried key
//     nothing declares — the diagnostic that confirms the real key names after
//     deploy, since CLICKR_API_KEY could not be reached from here.
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

globalThis.__P86_CLICKR_BILL_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_CLICKR_BILL_ENGINE__.pool }));
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});
jest.mock('../server/geocoder', () => ({ geocodeAddress: async () => null, geocodeViaGoogle: async () => null, geocodeViaCensus: async () => null }));

const { DATASETS, readRecord, readBill, describeMapping } = require('../server/services/clickr/field-map');
const preview = require('../server/services/clickr/sync-preview');
const billMatch = require('../server/services/clickr/bill-match');
const applyMod = require('../server/services/clickr/sync-apply');
const since = require('../server/services/clickr/since-refresh');
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const orgRoutes = require('../server/routes/admin-organizations-routes');

const KEY = 'ck_live_Zq9SECRETKEYxy7_0123456789ab';
const BASE = 'https://api.clickr.cloud';
const AGX = 1;
const OTHER = 2;

// Clickr's REST records carry NO _id: identity is billId, and several share a
// jobId. Every declared key is present on every fixture record, so a mapping
// diagnostic that reports anything is reporting a real drift.
function billRec(id, jobId, billNumber, amount, paymentStatus, o) {
  o = o || {};
  return Object.assign({
    accountId: 'a', integrationId: 'i', builderId: 'b',
    billId: String(id), billNumber, title: o.title === undefined ? 'Bill ' + billNumber : o.title,
    jobId: String(jobId), jobName: 'Job ' + jobId,
    documentType: 'Bill', source: 'Buildertrend',
    amount, amountPaid: o.paid === undefined ? 0 : o.paid,
    remainingBalance: o.remaining === undefined ? amount : o.remaining,
    paymentStatus, payTo: o.payTo === undefined ? null : o.payTo,
    invoiceDate: o.invoiceDate === undefined ? '2026-03-01T00:00:00' : o.invoiceDate,
    dueDate: o.dueDate === undefined ? '2026-03-31T00:00:00' : o.dueDate,
    createdDate: '2026-03-01T10:00:00.00', createdBy: 'Lisa Dryden', createdById: '77',
    relatedPurchaseOrderIds: o.pos || [], costCodes: o.codes || ['Subcontractors Costs'],
    lienWaiverStatus: 1, lienWaiverStatusText: o.lien === undefined ? 'Not Requested' : o.lien,
    isSubRequested: !!o.subRequested, isOriginatedFromAccounting: false,
    attachedFileCount: 0, commentCount: 0,
    isDuplicated: !!o.duplicated, isDeleted: !!o.deleted,
    raw: { secret: 'never read' },
  }, o.extra || {});
}

const BT_BILLS = [
  // rung 1 (job + bill number). Money differs (1500 vs P86's 1200), a PO P86 has
  // imported, and a vendor that is exactly one P86 sub.
  billRec(7001, 111, 'INV-100', 1500, 'Unpaid', { payTo: 'Catica International Inc', pos: ['9001'], title: 'Paint invoice' }),
  // rung 0 (saved bt_bill_id), and a forward status move open -> paid.
  billRec(7002, 111, 'INV-200', 500, 'Paid', { paid: 500, remaining: 0 }),
  // two P86 bills on this job carry DUP-1.
  billRec(7003, 111, 'DUP-1', 100, 'Unpaid'),
  // P86 has nothing like it.
  billRec(7004, 111, 'INV-NEW', 640, 'Unpaid', { payTo: 'Catica International Inc' }),
  // rung 0 onto a P86 bill whose number is P86's own BILL-#### placeholder.
  billRec(7005, 111, 'INV-555', 300, 'Unpaid'),
  // a PAID P86 bill: its amount is settled, so the difference is shown only.
  billRec(7006, 111, 'INV-900', 950, 'Paid', { paid: 950, remaining: 0 }),
  // a payment word P86 has NO term for, on a P86 bill with a NULL organization.
  billRec(7007, 111, 'INV-NULLORG', 400, 'Partially Paid', { paid: 150, remaining: 250 }),
  // two related purchase order ids: none is set.
  billRec(7008, 111, 'INV-TWOPO', 220, 'Unpaid', { pos: ['9001', '9002'] }),
  // one related purchase order id P86 has not imported.
  billRec(7009, 111, 'INV-NOPO', 230, 'Unpaid', { pos: ['9999'] }),
  // its Buildertrend job is not linked to a P86 job.
  billRec(7010, 333, 'INV-WAIT', 240, 'Unpaid'),
  // DELETED in Buildertrend, and a P86 bill is linked to it.
  billRec(7050, 111, 'INV-GONE', 250, 'Unpaid', { deleted: true }),
  // marked a duplicate in Buildertrend, nothing linked.
  billRec(7012, 111, 'INV-DUPE', 260, 'Unpaid', { duplicated: true }),
  // P86 has voided this bill.
  billRec(7013, 111, 'INV-VOID', 270, 'Paid', { paid: 270, remaining: 0, title: 'A different description' }),
  // its only related purchase order belongs to ANOTHER organization.
  billRec(7014, 111, 'INV-FOREIGNPO', 280, 'Unpaid', { pos: ['9009'] }),
  // on the other linked P86 job — the create target.
  billRec(7015, 222, 'INV-J2', 777.25, 'Unpaid', { payTo: 'Five Star Remodeling & Cleaning LLC', pos: ['9002'] }),
  // TWO Buildertrend bills landing on ONE P86 bill.
  billRec(7016, 111, 'CLAIM-1', 310, 'Unpaid'),
  billRec(7017, 111, 'CLAIM-1', 320, 'Unpaid'),
  // Buildertrend is BEHIND: unpaid against a P86 bill already approved.
  billRec(7018, 111, 'INV-APPR', 330, 'Unpaid'),
  // no vendor invoice number at all: created under a P86 BILL-#### placeholder.
  billRec(7019, 222, null, 55, 'Unpaid'),
  // its related purchase order IS in P86 and IS this organization's - but on a
  // DIFFERENT P86 job than the bill.
  billRec(7020, 111, 'INV-XJOB', 500, 'Unpaid', { pos: ['9002'] }),
  // on a job with exactly ONE P86 purchase order, naming a Buildertrend id that
  // is not that purchase order's.
  billRec(7021, 222, 'INV-BADPO', 90, 'Unpaid', { pos: ['8888'] }),
  // ONE purchase order, named TWICE and once with stray spaces around it. It is
  // one purchase order, not a bill that "names 2 purchase orders" and refuses
  // the link. No payTo, so the vendor can only come from that purchase order.
  billRec(7022, 111, 'INV-DUPPO', 240, 'Unpaid', { pos: ['9001', ' 9001 '] }),
];

function clickrFetch(url) {
  const u = new URL(url);
  if (u.origin !== BASE) throw new Error('test: fetch reached a non-Clickr host');
  const skip = Number(u.searchParams.get('skip') || 0);
  const limit = Number(u.searchParams.get('limit') || 200);
  const list = u.pathname.includes(DATASETS.bills.datasetId) ? BT_BILLS : null;
  if (!list) return Promise.resolve({ status: 404, text: async () => '{"error":"Route not found"}' });
  const body = { recordType: 'x', columns: [], records: list.slice(skip, skip + limit), count: list.length, sort: {} };
  return Promise.resolve({ status: 200, text: async () => JSON.stringify(body) });
}

const line = (cost) => ({ description: 'x', qty: 1, unitCost: cost });

function seed() {
  engine.db.exec(`
    DELETE FROM jobs; DELETE FROM users; DELETE FROM roles; DELETE FROM organizations; DELETE FROM subs;
    DELETE FROM job_purchase_orders; DELETE FROM job_vendor_bills;
    INSERT INTO organizations (id, slug, name) VALUES (1, 'agx', 'AGX Central Florida'), (2, 'other', 'Other Builders');
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ROLES_MANAGE","USERS_MANAGE","JOBS_VIEW_ALL","ESTIMATES_EDIT"]'),
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
  job.run('j-2', 10, AGX, '222', JSON.stringify({ jobNumber: 'RV2000', title: 'Waterside III', status: 'In Progress' }));
  job.run('j-3', 10, AGX, null, JSON.stringify({ jobNumber: 'RV2013', title: 'Saddlebrook', status: 'In Progress' }));
  // ANOTHER TENANT's job carrying the SAME Buildertrend job id.
  job.run('j-b', 20, OTHER, '111', JSON.stringify({ jobNumber: 'RV2004', title: 'Citi Lakes', status: 'In Progress' }));

  const po = engine.db.prepare('INSERT INTO job_purchase_orders (id, job_id, organization_id, owner_id, sub_id, status, po_number, data, is_locked, bt_po_id) VALUES (?,?,?,?,?,?,?,?,?,?)');
  po.run('po-1', 'j-1', AGX, 10, 's-1', 'approved', '0001', JSON.stringify({ title: 'Exterior paint', lines: [line(10000)], baselineTotal: 10000 }), 1, '9001');
  po.run('po-2', 'j-2', AGX, 10, 's-2', 'approved', '0001', JSON.stringify({ title: 'Stucco', lines: [line(2000)], baselineTotal: 2000 }), 1, '9002');
  po.run('po-3', 'j-1', AGX, 10, null, 'draft', '0003', JSON.stringify({ title: 'Unlinked PO', lines: [line(50)] }), 0, null);
  // ANOTHER TENANT's purchase order, carrying the Buildertrend id 7014 names.
  po.run('po-x', 'j-b', OTHER, 20, 's-x', 'approved', '0001', JSON.stringify({ title: 'Foreign PO', lines: [line(5000)], baselineTotal: 5000 }), 1, '9009');

  const bill = engine.db.prepare(
    'INSERT INTO job_vendor_bills (id, job_id, organization_id, owner_id, po_id, sub_id, status, bill_number, amount, bill_date, due_date, data, bt_bill_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const D = (desc) => JSON.stringify({ description: desc, lienWaiver: 'none' });
  bill.run('bill-a', 'j-1', AGX, 10, null, null, 'open', 'INV-100', 1200, '2026-03-01', '2026-03-31', D('Paint invoice'), null);
  bill.run('bill-b', 'j-1', AGX, 10, null, null, 'open', 'INV-200', 500, '2026-03-01', '2026-03-31', D('Bill INV-200'), '7002');
  bill.run('bill-c', 'j-1', AGX, 10, null, null, 'open', 'DUP-1', 100, null, null, D('One'), null);
  bill.run('bill-d', 'j-1', AGX, 10, null, null, 'open', 'DUP-1', 200, null, null, D('Two'), null);
  bill.run('bill-e', 'j-1', AGX, 10, null, null, 'open', 'BILL-0007', 300, '2026-03-01', '2026-03-31', D('Bill INV-555'), '7005');
  bill.run('bill-f', 'j-1', AGX, 10, null, null, 'paid', 'INV-900', 900, '2026-03-01', '2026-03-31', D('Bill INV-900'), null);
  bill.run('bill-g', 'j-1', AGX, 10, null, null, 'open', 'INV-ONLY', 111, null, null, D('P86 only'), null);
  // NULL organization: an older row the tolerance arm must still reach.
  bill.run('bill-h', 'j-1', null, 10, null, null, 'open', 'INV-NULLORG', 400, '2026-03-01', '2026-03-31', D('Bill INV-NULLORG'), null);
  bill.run('bill-i', 'j-1', AGX, 10, null, null, 'void', 'INV-VOID', 270, '2026-03-01', '2026-03-31', D('Voided here'), null);
  bill.run('bill-del', 'j-1', AGX, 10, null, null, 'open', 'INV-GONE', 250, null, null, D('Still here'), '7050');
  bill.run('bill-j', 'j-1', AGX, 10, null, null, 'open', 'CLAIM-1', 300, null, null, D('Claimed twice'), null);
  bill.run('bill-k', 'j-1', AGX, 10, null, null, 'approved', 'INV-APPR', 330, '2026-03-01', '2026-03-31', D('Bill INV-APPR'), null);
  bill.run('bill-l', 'j-1', AGX, 10, null, null, 'open', 'INV-XJOB', 500, '2026-03-01', '2026-03-31', D('Bill INV-XJOB'), null);
  // ANOTHER TENANT's bill, same job id, same vendor invoice number.
  bill.run('bill-x', 'j-b', OTHER, 20, null, null, 'open', 'INV-100', 1200, null, null, D('Foreign'), null);
}

const billRow = (id) => engine.db.prepare('SELECT * FROM job_vendor_bills WHERE id = ?').get(id);
const billData = (id) => JSON.parse(billRow(id).data);
const billByBt = (btId) => engine.db.prepare('SELECT * FROM job_vendor_bills WHERE bt_bill_id = ?').all(btId);
const allBills = () => engine.db.prepare('SELECT * FROM job_vendor_bills ORDER BY id').all();
const count = (table) => engine.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
const setBill = (id, sets) => engine.db.prepare('UPDATE job_vendor_bills SET ' + Object.keys(sets).map((k) => k + ' = ?').join(', ') + ' WHERE id = ?')
  .run(...Object.values(sets), id);

let server;
let baseUrl;
const origFetch = global.fetch;

// THE WINDOW BETWEEN THE MATCH AND THE LOCK. apply() re-reads P86 and re-runs
// the matcher, then opens a transaction and re-reads the row FOR UPDATE. In
// Postgres another connection can change the row in between, and every
// re-check inside applyBill exists for that window. pg-sqlite has one
// connection, so the only way to stand in the window is to write from inside
// it: raceAtBegin(fn) runs fn once, on the next BEGIN, after the matcher has
// already decided and before the locked read happens.
let _race = null;
const raceAtBegin = (fn) => { _race = fn; };
function installRaceHook() {
  const rawConnect = engine.pool.connect;
  engine.pool.connect = async () => {
    const c = await rawConnect();
    return {
      query: async (sql, params) => {
        const out = await c.query(sql, params);
        if (String(sql).trim().toUpperCase() === 'BEGIN' && _race) { const f = _race; _race = null; f(); }
        return out;
      },
      release: () => c.release(),
    };
  };
}

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
const put = (user, body) => call('PUT', APPLY, user, Object.assign({ dataset: 'bills' }, body));

async function billRows() {
  preview.forgetFetch(AGX);
  const r = await call('GET', PREVIEW, ADMIN);
  expect(r.status).toBe(200);
  return r.json.datasets.bills;
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
  installRaceHook();
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
  _race = null;
  await refreshRoleCache();
});

// ── THE READ AND THE MAPPING DIAGNOSTIC ───────────────────────────────────
describe('THE READ — REST-shaped records, read whole, and the diagnostic that confirms the key names', () => {
  test('the dataset is read complete and classified; several bills share a jobId and none is lost', async () => {
    const ds = await billRows();
    expect([ds.fetch.complete, ds.fetch.reason]).toEqual([true, null]);
    expect(ds.fetch.fetched).toBe(BT_BILLS.length);
    expect(ds.classified).toBe(true);
    expect(ds.error).toBeNull();
    // No fixture carries _id: identity is billId alone.
    expect(BT_BILLS.every((r) => !Object.prototype.hasOwnProperty.call(r, '_id'))).toBe(true);
  });

  test('every declared key is carried by the fixtures, and nothing undeclared is', async () => {
    const ds = await billRows();
    expect(ds.mapping.missingKeys).toEqual([]);
    expect(ds.mapping.unexpectedKeys).toEqual([]);
    expect([ds.mapping.requiredKey, ds.mapping.requiredOk, ds.mapping.requiredUsable]).toEqual(['jobName', true, BT_BILLS.length]);
  });

  test('THE DIAGNOSTIC THAT CONFIRMS THE REAL KEY NAMES: a declared key nothing carries is missing, and the key it really used is unexpected', () => {
    // Exactly the live case this mapping is braced for: "Pay to" is not payTo.
    const renamed = BT_BILLS.map((r) => {
      const c = Object.assign({}, r);
      delete c.payTo;
      c.vendorDisplayName = 'Catica International Inc';
      return c;
    });
    const d = describeMapping('bills', renamed);
    expect(d.missingKeys).toEqual(['payTo']);
    expect(d.unexpectedKeys).toEqual([{ key: 'vendorDisplayName', carriedBy: renamed.length }]);
    // The dataset still classifies: a wrong key costs the vendor, not the tab.
    expect([d.requiredOk, d.refusal]).toEqual([true, null]);
    // And NO VALUE is echoed by the diagnostic.
    expect(JSON.stringify(d)).not.toContain('Catica International Inc');
    expect(JSON.stringify(d)).not.toContain('INV-100');
  });

  test('a wrong key reads as ABSENT, never as a wrong value, and never throws', () => {
    const v = readBill({ billId: '1', jobName: 'J', vendorDisplayName: 'Acme', amountDue: 99 });
    expect([v.vendorName, v.amount, v.billNumber, v.paymentStatusText]).toEqual([null, null, null, null]);
    expect(v.relatedPurchaseOrderIds).toEqual([]);
    // Not an object, and a record of nulls: neither crashes.
    expect(readBill(null).btId).toBeNull();
    expect(readBill('nope').isDeleted).toBe(false);
  });

  test('one purchase order NAMED TWICE reads as ONE id, whitespace and all', () => {
    // Buildertrend can name the same purchase order twice on one bill. Deduped
    // HERE, through the same trim-and-collapse both readers apply, so neither
    // resolvePo nor createBill sees a bill that "names 2 purchase orders".
    const ids = (v) => readBill({ billId: '1', jobName: 'J', relatedPurchaseOrderIds: v }).relatedPurchaseOrderIds;
    expect(ids(['884', '884', ' 884 '])).toEqual(['884']);
    expect(ids([884, '884'])).toEqual(['884']);
    expect(ids(['', '  ', null, {}, '884'])).toEqual(['884']);
    // TWO DIFFERENT purchase orders are still two.
    expect(ids(['9001', '9002'])).toEqual(['9001', '9002']);
    expect(ids([])).toEqual([]);
  });

  test('the required key is jobName, and losing it refuses the WHOLE dataset rather than classifying blanks', () => {
    expect(DATASETS.bills.requiredKey).toBe('jobName');
    expect(DATASETS.bills.idKey).toBe('billId');
    const nameless = BT_BILLS.map((r) => Object.assign({}, r, { jobName: '--' }));
    const d = describeMapping('bills', nameless);
    expect(d.requiredOk).toBe(false);
    expect(d.refusal).toMatch(/carry a usable "jobName"/);
  });
});

// ── PREVIEW: the rungs and the classes ─────────────────────────────────────
describe('PREVIEW — rungs, classes, and the refusal to guess', () => {
  test('rung 1 (job + bill number): the money is held back, the purchase order and vendor are corrections', async () => {
    const ds = await billRows();
    const r = byBt(ds, 7001);
    expect([r.class, r.rung, r.p86.id]).toEqual(['conflict', 'Bill number', 'bill-a']);
    const c = fieldsOf(r.corrections);
    expect(Object.keys(c).sort()).toEqual(['po', 'sub']);
    expect([c.po.value, c.po.kind, c.sub.value]).toEqual(['po-1', 'fill', 's-1']);
    // 1500 vs 1200 is NEVER a correction.
    expect(r.corrections.map((x) => x.field)).not.toContain('amount');
    const h = fieldsOf(r.heldBack);
    expect([h.amount.applicable, h.amount.bt, h.amount.p86, h.amount.value, h.amount.p86Value]).toEqual([true, '$1,500.00', '$1,200.00', 1500, 1200]);
    expect(h.amount.money).toBe(true);
    // Buildertrend "Unpaid" against a P86 open bill agrees: no status item at all.
    expect(h.status).toBeUndefined();
  });

  test('rung 0 (a saved bt_bill_id) and a forward status move', async () => {
    const ds = await billRows();
    const r = byBt(ds, 7002);
    expect([r.class, r.rung, r.p86.id]).toEqual(['conflict', 'Buildertrend ID', 'bill-b']);
    const c = fieldsOf(r.corrections);
    expect([c.status.value, c.status.from, c.status.to, c.status.money]).toEqual(['paid', 'Open', 'Paid', true]);
  });

  test('two P86 bills carry the number: AMBIGUOUS, with both candidates and nothing proposed', async () => {
    const ds = await billRows();
    const r = byBt(ds, 7003);
    expect([r.class, r.rung, r.p86]).toEqual(['ambiguous', null, null]);
    expect(r.candidates.map((x) => x.id).sort()).toEqual(['bill-c', 'bill-d']);
    expect([r.corrections, r.heldBack]).toEqual([[], []]);
    expect(r.notes.join(' ')).toMatch(/2 P86 bills on this job carry this vendor invoice number/);
  });

  test('two Buildertrend bills landing on ONE P86 bill: neither is matched', async () => {
    const ds = await billRows();
    for (const id of [7016, 7017]) {
      const r = byBt(ds, id);
      expect([r.class, r.rung, r.p86]).toEqual(['ambiguous', null, null]);
      expect(r.candidates.map((x) => x.id)).toEqual(['bill-j']);
      expect(r.notes.join(' ')).toMatch(/2 Buildertrend bills land on this same P86 bill/);
    }
  });

  test('P86 has nothing like it: NEW; and a Buildertrend job with no P86 job WAITS rather than failing', async () => {
    const ds = await billRows();
    expect(byBt(ds, 7004).class).toBe('new');
    const w = byBt(ds, 7010);
    expect([w.class, w.waitingOnJob, w.p86]).toEqual(['refused', true, null]);
    expect(w.notes.join(' ')).toMatch(/is not linked to a P86 job yet/);
  });

  test('the P86 bills nothing in Buildertrend reached are review only, and nothing is proposed for deletion', async () => {
    const ds = await billRows();
    expect(ds.notInBuildertrend.rows.map((p) => p.id)).toEqual(['bill-g']);
    expect(ds.notInBuildertrend.sentence).toMatch(/Nothing is proposed for deletion, and a sync never voids one/);
  });
});

// ── STATUS ────────────────────────────────────────────────────────────────
describe('PREVIEW — the payment status mapping, in both directions', () => {
  test('the mapping, asked directly: only Paid and the unpaid words map, and nothing mints approved or void', () => {
    expect(billMatch.btBillStatus('Paid')).toBe('paid');
    expect(billMatch.btBillStatus('paid in full')).toBe('paid');
    expect(billMatch.btBillStatus('Unpaid')).toBe('open');
    expect(billMatch.btBillStatus('Not Paid')).toBe('open');
    // The exact-equality guard: 'Partially Paid' must not be swallowed by a
    // substring test into 'paid'.
    expect(billMatch.btBillStatus('Partially Paid')).toBeNull();
  });

  // The live dataset sends a NUMBER here — there is no text field on bills —
  // and the codes were measured against what each bill had actually been paid.
  test('the numeric code Buildertrend really sends is read: 2 is paid, 0 is open, 1 is nobody\u2019s guess', () => {
    expect(billMatch.btBillStatus('2')).toBe('paid');
    expect(billMatch.btBillStatus(2)).toBe('paid');
    expect(billMatch.btBillStatus('0')).toBe('open');
    // 8 live bills carry it and not one has a payment against it, so it is not
    // "partly paid" — and a wrong guess here marks a payable settled.
    expect(billMatch.btBillStatus('1')).toBeNull();
    expect(billMatch.btBillStatus('7')).toBeNull();
    // A word still reads as a word.
    expect(billMatch.btBillStatus('Paid')).toBe('paid');
    expect(billMatch.btBillStatus('Pending Payment')).toBeNull();
    expect(billMatch.btBillStatus('Approved')).toBeNull();
    expect(billMatch.btBillStatus('Void')).toBeNull();
    // 2 as a NUMBER is the live spelling of paid (see the code map above); an
    // unknown code is still nothing.
    expect(billMatch.btBillStatus(9)).toBeNull();
    expect(billMatch.btBillStatus('')).toBeNull();
    // 'void' is deliberately OFF the ladder, so nothing can move onto or off it.
    expect(billMatch.RANK.void).toBeUndefined();
    expect([billMatch.RANK.open, billMatch.RANK.approved, billMatch.RANK.paid]).toEqual([0, 1, 2]);
  });

  test('FORWARD: open -> paid is a correction', async () => {
    const ds = await billRows();
    expect(fieldsOf(byBt(ds, 7002).corrections).status.value).toBe('paid');
  });

  test('BACKWARD: a sync never un-approves — Buildertrend Unpaid against a P86 approved bill is held back, not applied', async () => {
    const ds = await billRows();
    const r = byBt(ds, 7018);
    expect([r.class, r.p86.id]).toEqual(['matched', 'bill-k']);
    expect(r.corrections).toEqual([]);
    const st = fieldsOf(r.heldBack).status;
    expect([st.applicable, st.bt, st.p86]).toEqual([false, 'Open', 'Approved']);
    expect(st.note).toBe('A sync never un-approves and never un-pays a bill. If Buildertrend is right, change it in P86.');
  });

  test('A WORD P86 HAS NONE FOR is held back NAMING itself, never rounded to paid or open', async () => {
    const ds = await billRows();
    const r = byBt(ds, 7007);
    expect(r.p86.id).toBe('bill-h');        // reached through the NULL-organization tolerance arm
    const st = fieldsOf(r.heldBack).status;
    expect([st.applicable, st.bt, st.p86]).toEqual([false, 'Partially Paid', 'Open']);
    expect(st.note).toMatch(/has no Project 86 word/);
    expect(r.corrections.map((c) => c.field)).not.toContain('status');
  });

  test('a VOIDED P86 bill is never brought back, and nothing on it is proposed', async () => {
    const ds = await billRows();
    const r = byBt(ds, 7013);
    expect([r.class, r.p86.id, r.corrections]).toEqual(['matched', 'bill-i', []]);
    const h = fieldsOf(r.heldBack);
    expect(h.status.applicable).toBe(false);
    expect(h.status.note).toMatch(/never brings a voided bill back/);
    expect(h.description.applicable).toBe(false);
  });
});

// ── MONEY ─────────────────────────────────────────────────────────────────
describe('PREVIEW — the three money figures', () => {
  test('a PAID P86 bill’s amount is settled: shown with both figures, never applicable', async () => {
    const ds = await billRows();
    const h = fieldsOf(byBt(ds, 7006).heldBack);
    expect([h.amount.applicable, h.amount.bt, h.amount.p86]).toEqual([false, '$950.00', '$900.00']);
    expect(h.amount.note).toMatch(/P86 has this bill paid, so its amount is settled/);
  });

  test('a BUILDERTREND PART PAYMENT is held back, showing both sides, and is never applicable', async () => {
    const ds = await billRows();
    // Buildertrend: $150 paid and $250 owing on a $400 bill it calls
    // "Partially Paid" - its own figures disagree with its own word. P86 reads
    // the bill open at $400, and has no field for the difference.
    const h = fieldsOf(byBt(ds, 7007).heldBack);
    expect([h.amountPaid.applicable, h.amountPaid.bt, h.amountPaid.p86]).toEqual([false, '$150.00', '$0.00']);
    expect([h.remainingBalance.applicable, h.remainingBalance.bt, h.remainingBalance.p86]).toEqual([false, '$250.00', '$400.00']);
    expect(h.amountPaid.note).toMatch(/carrying a part payment/);
    expect(h.amountPaid.note).toMatch(/P86 keeps NO paid figure on a bill/);
  });

  test('a bill whose settlement figures AGREE with its own Buildertrend word raises neither item, even where the amounts differ', async () => {
    const ds = await billRows();
    // 7002: Paid, $500 paid, $0 owing on a $500 bill. Consistent.
    const agree = fieldsOf(byBt(ds, 7002).heldBack);
    expect([agree.amountPaid, agree.remainingBalance]).toEqual([undefined, undefined]);
    // 7006: Paid, $950 paid, $0 owing on a $950 bill, against a P86 bill of
    // $900. The $50 belongs to the AMOUNT item and is said ONCE.
    const paid = fieldsOf(byBt(ds, 7006).heldBack);
    expect([paid.amountPaid, paid.remainingBalance]).toEqual([undefined, undefined]);
    expect(paid.amount.bt).toBe('$950.00');
    // 7018: Unpaid, $0 paid, $330 owing on a $330 bill. Consistent.
    const unpaid = fieldsOf(byBt(ds, 7018).heldBack);
    expect([unpaid.amountPaid, unpaid.remainingBalance]).toEqual([undefined, undefined]);
  });

  test('a part payment under a word P86 DOES map is caught too', () => {
    const rows = billMatch.matchBills(
      [readBill(billRec(7777, 111, 'INV-PART', 1000, 'Unpaid', { paid: 400, remaining: 600 }))],
      { jobs: [{ id: 'j-1', bt_job_id: '111', data: {} }],
        billRows: [{ id: 'b1', job_id: 'j-1', status: 'open', bill_number: 'INV-PART', amount: 1000, data: {} }],
        poRows: [], subs: [] });
    const h = fieldsOf(rows[0].heldBack);
    expect([h.amountPaid.bt, h.amountPaid.applicable]).toEqual(['$400.00', false]);
    expect([h.remainingBalance.bt, h.remainingBalance.applicable]).toEqual(['$600.00', false]);
  });

  // One Buildertrend bill against one P86 bill, built inline so no shared
  // fixture moves. Every one of these turns on the payment word.
  const oneBill = (rec) => billMatch.matchBills([readBill(rec)],
    { jobs: [{ id: 'j-1', bt_job_id: '111', data: {} }],
      billRows: [{ id: 'b1', job_id: 'j-1', status: 'open', bill_number: rec.billNumber, amount: rec.amount, data: {} }],
      poRows: [], subs: [] })[0];

  test('a fully-unpaid bill under a word P86 does NOT map raises NEITHER settlement item', () => {
    // $400 still owing on a $400 bill nobody has paid is the most ordinary row
    // there is. Measured as "any non-zero figure disagrees" - which is what an
    // unmapped word used to mean - the remaining balance fired on every one of
    // them, showing two identical figures under a note asserting a part payment
    // that is not there. A word P86 cannot read has TWO consistent ends.
    const under = (word) => oneBill(billRec(7778, 111, 'INV-PEND', 400, word, { paid: 0, remaining: 400 }));
    for (const word of ['Pending Payment', 3, undefined]) {
      const h = fieldsOf(under(word).heldBack);
      expect([h.amountPaid, h.remainingBalance]).toEqual([undefined, undefined]);
    }
    // The unrecognised word is still NAMED, so the row still says something -
    // including the NUMERIC code the mapping is braced for.
    expect(fieldsOf(under('Pending Payment').heldBack).status.bt).toBe('Pending Payment');
    expect(fieldsOf(under(3).heldBack).status.bt).toBe('3');
    // A key name that turns out to be wrong reads as ABSENT, and an absent word
    // is not a part payment either - on all 103 rows at once.
    expect(fieldsOf(under(undefined).heldBack).status).toBeUndefined();
    // ...and a figure strictly BETWEEN the two ends still fires both items,
    // under that same unmapped word. That is the part payment they exist for.
    const part = fieldsOf(oneBill(billRec(7779, 111, 'INV-PART2', 400, 'Pending Payment', { paid: 150, remaining: 250 })).heldBack);
    expect([part.amountPaid.bt, part.remainingBalance.bt]).toEqual(['$150.00', '$250.00']);
  });

  test('a bill SETTLED IN FULL under a word P86 does not map is not a part payment either', () => {
    const r = oneBill(billRec(7780, 111, 'INV-CODE', 400, 3, { paid: 400, remaining: 0 }));
    const h = fieldsOf(r.heldBack);
    expect([h.amountPaid, h.remainingBalance]).toEqual([undefined, undefined]);
    // Nothing is swallowed: the unrecognised word is named beside the P86
    // status, and all three Buildertrend figures are on the row, which is what
    // the page prints on every bill.
    expect([h.status.bt, h.status.p86, h.status.applicable]).toEqual(['3', 'Open', false]);
    expect([r.bt.amountText, r.bt.paidText, r.bt.remainingText]).toEqual(['$400.00', '$400.00', '$0.00']);
  });

  test('a word P86 DOES map still has exactly ONE consistent figure, not a range', () => {
    // The second end belongs to an UNMAPPED word alone. 'Unpaid' is a word P86
    // maps: it implies nothing paid and the whole amount still owing, so a bill
    // Buildertrend calls Unpaid while reporting the whole $400 paid is
    // Buildertrend disagreeing with itself, and the item must still fire.
    const unpaid = fieldsOf(oneBill(billRec(7782, 111, 'INV-SAYSUNPAID', 400, 'Unpaid', { paid: 400, remaining: 0 })).heldBack);
    expect([unpaid.amountPaid.bt, unpaid.amountPaid.applicable]).toEqual(['$400.00', false]);
    // Its still-owing figure contradicts the same word, so that item fires too:
    // $0.00 owing is not what 'Unpaid' implies on a $400 bill.
    expect(unpaid.remainingBalance.bt).toBe('$0.00');
    // The mirror: 'Paid' implies nothing still owing.
    const paid = fieldsOf(oneBill(billRec(7783, 111, 'INV-SAYSPAID', 400, 'Paid', { paid: 400, remaining: 400 })).heldBack);
    expect([paid.remainingBalance.bt, paid.remainingBalance.applicable]).toEqual(['$400.00', false]);
    expect(paid.amountPaid).toBeUndefined();
  });
});

// ── THE PURCHASE ORDER LINK ───────────────────────────────────────────────
describe('PREVIEW — the purchase order resolves through bt_po_id, or not at all', () => {
  test('ONE id P86 has imported, on this job: a deterministic fill naming the P86 purchase order', async () => {
    const ds = await billRows();
    const po = fieldsOf(byBt(ds, 7001).corrections).po;
    expect([po.kind, po.value, po.to]).toEqual(['fill', 'po-1', '0001 Exterior paint']);
    expect(po.note).toMatch(/already carries its Buildertrend id, so the link is exact/);
  });

  test('MORE THAN ONE id: none is set, and the row says how many', async () => {
    const ds = await billRows();
    const r = byBt(ds, 7008);
    expect(r.corrections.map((c) => c.field)).not.toContain('po');
    expect(r.notes.join(' ')).toMatch(/Buildertrend names 2 purchase orders on this bill \(9001, 9002\)/);
  });

  test('THE SAME id NAMED TWICE is ONE purchase order, and the link is still made', () => {
    const onePo = (pos) => billMatch.matchBills(
      [readBill(billRec(7781, 111, 'INV-DUPPO', 240, 'Unpaid', { pos }))],
      { jobs: [{ id: 'j-1', bt_job_id: '111', data: {} }],
        billRows: [{ id: 'b1', job_id: 'j-1', status: 'open', bill_number: 'INV-DUPPO', amount: 240, data: {} }],
        poRows: [{ id: 'po-1', job_id: 'j-1', po_number: '0001', bt_po_id: '9001', data: JSON.stringify({ title: 'Exterior paint' }) }],
        subs: [] })[0];
    for (const pos of [['9001', '9001'], ['9001', ' 9001 '], ['9001', '9001', '9001']]) {
      const r = onePo(pos);
      const po = fieldsOf(r.corrections).po;
      expect([po && po.kind, po && po.value, po && po.to]).toEqual(['fill', 'po-1', '0001 Exterior paint']);
      expect(r.notes.join(' ')).not.toMatch(/purchase orders on this bill/);
    }
    // TWO DIFFERENT ids still refuse, and still say how many.
    const two = onePo(['9001', '9002']);
    expect(two.corrections.map((c) => c.field)).not.toContain('po');
    expect(two.notes.join(' ')).toMatch(/names 2 purchase orders on this bill \(9001, 9002\)/);
  });

  test('the same id twice through the CREATE press: the purchase order is set and the vendor inherited from it', async () => {
    const res = await put(ADMIN, { mode: 'create', btIds: ['7022'] });
    expect(res.json.counts.created).toBe(1);
    const b = billRow(res.json.results[0].p86Id);
    expect([b.job_id, b.po_id, b.sub_id, Number(b.amount)]).toEqual(['j-1', 'po-1', 's-1', 240]);
    const notes = res.json.results[0].notes.join(' ');
    expect(notes).not.toMatch(/purchase orders on this bill/);
    expect(notes).toMatch(/inherited from the linked purchase order/);
  });

  test('an id P86 HAS NOT IMPORTED: none is set, and the row says where to import it', async () => {
    const ds = await billRows();
    const r = byBt(ds, 7009);
    expect(r.corrections.map((c) => c.field)).not.toContain('po');
    expect(r.notes.join(' ')).toMatch(/purchase order 9999 is not in P86 yet.*Purchase orders tab/);
  });

  test('an id belonging to ANOTHER ORGANIZATION’s purchase order resolves to nothing', async () => {
    const ds = await billRows();
    const r = byBt(ds, 7014);
    expect(r.corrections.map((c) => c.field)).not.toContain('po');
    expect(r.notes.join(' ')).toMatch(/purchase order 9009 is not in P86 yet/);
    expect(JSON.stringify(ds)).not.toContain('po-x');
  });

  test('a purchase order P86 HAS imported, on a DIFFERENT P86 job, is not set', async () => {
    const ds = await billRows();
    const r = byBt(ds, 7020);
    expect([r['class'], r.p86.id]).toEqual(['matched', 'bill-l']);
    expect(r.corrections.map((c) => c.field)).not.toContain('po');
    expect(r.notes.join(' ')).toMatch(/purchase order 9002 is on a different P86 job than this bill/);
    // And a press cannot set it either.
    await put(ADMIN, { mode: 'rows', btIds: ['7020'] });
    expect(billRow('bill-l').po_id).toBeNull();
  });

  test('the joined P86 purchase order is the one on the BILL’S OWN job, so a stray po_id never borrows another job’s number', async () => {
    // po-2 lives on j-2; bill-a lives on j-1. po_id is a loose column with no
    // foreign key, so this state is reachable, and reading it through the join
    // unscoped would print j-2's purchase order number as if it were this
    // bill's.
    setBill('bill-a', { po_id: 'po-2' });
    const ds = await billRows();
    expect(byBt(ds, 7001).p86.poNumber).toBe('');
    expect(fieldsOf(byBt(ds, 7001).heldBack).po.p86).toBe('po-2');
  });

  test('a P86 bill already on a DIFFERENT purchase order is shown, never moved', async () => {
    setBill('bill-a', { po_id: 'po-3' });
    const ds = await billRows();
    const h = fieldsOf(byBt(ds, 7001).heldBack);
    expect([h.po.applicable, h.po.bt, h.po.p86]).toEqual([false, '0001 Exterior paint', '0003']);
    expect(h.po.note).toMatch(/moves its money from one commitment to another/);
  });
});

// ── DELETED AND DUPLICATED ────────────────────────────────────────────────
describe('PREVIEW and CREATE — a deleted or duplicated Buildertrend bill', () => {
  test('a DELETED one is refused, names the P86 bill still linked to it, and is never row.p86', async () => {
    const ds = await billRows();
    const r = byBt(ds, 7050);
    expect([r.class, r.p86, r.corrections, r.heldBack]).toEqual(['refused', null, [], []]);
    expect(r.p86Linked).toEqual({ id: 'bill-del', billNumber: 'INV-GONE', status: 'Open', amountText: '$250.00' });
    expect(r.notes.join(' ')).toMatch(/Deleted in Buildertrend.*never deletes or voids a P86 bill/);
  });

  test('a DUPLICATED one is refused too', async () => {
    const ds = await billRows();
    const r = byBt(ds, 7012);
    expect([r.class, r.p86]).toEqual(['refused', null]);
    expect(r.notes.join(' ')).toMatch(/Marked a duplicate in Buildertrend/);
  });

  test('NEITHER is ever created — by name or in the bulk press', async () => {
    const before = count('job_vendor_bills');
    const named = await put(ADMIN, { mode: 'create', btIds: ['7050', '7012'] });
    expect(named.json.results.every((x) => x.outcome === 'skipped')).toBe(true);
    await put(ADMIN, { mode: 'create' });
    expect(billByBt('7012')).toHaveLength(0);
    // 7050's id belongs to the P86 bill that was already linked to it, and no
    // second row was minted for it.
    expect(billByBt('7050').map((b) => b.id)).toEqual(['bill-del']);
    expect(billRow('bill-del').status).toBe('open');
    expect(Number(billRow('bill-del').amount)).toBe(250);
    expect(count('job_vendor_bills')).toBeGreaterThan(before);     // the creatable ones did run
  });

  test('a deleted Buildertrend bill is never APPLIED either — it is not a confident row', async () => {
    const before = JSON.stringify(billRow('bill-del'));
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7050'], fields: ['status', 'amount'] });
    expect(res.json.results[0].outcome).toBe('skipped');
    expect(res.json.results[0].reason).toMatch(/Not a confident match \(refused\)/);
    expect(JSON.stringify(billRow('bill-del'))).toBe(before);
  });
});

// ── THE SAFE PATH: MONEY DOES NOT MOVE ────────────────────────────────────
describe('APPLY — the safe press links and NOTHING else; the database row proves it', () => {
  test('"Link confident matches" leaves amount, status, purchase order, vendor and number exactly as they were', async () => {
    const before = allBills().map((b) => JSON.stringify(b));
    const res = await put(ADMIN, { mode: 'safe' });
    expect(res.status).toBe(200);
    expect(res.json.counts.linked).toBeGreaterThan(0);

    const a = billRow('bill-a');
    expect(a.bt_bill_id).toBe('7001');                 // the link IS what the press does
    expect(Number(a.amount)).toBe(1200);               // 1500 in Buildertrend, and it did NOT move
    expect([a.status, a.po_id, a.sub_id, a.bill_number]).toEqual(['open', null, null, 'INV-100']);

    // bill-b was already linked; its status move to paid is a correction, and
    // safe mode applies no corrections at all.
    expect(billRow('bill-b').status).toBe('open');
    // bill-e's bill number is a held-back match key: untouched.
    expect(billRow('bill-e').bill_number).toBe('BILL-0007');
    // Nothing anywhere gained or lost a row.
    expect(allBills()).toHaveLength(before.length);
    // Only bt_bill_id, data.btStatus and updated_at moved on any row. btStatus
    // is BUILDERTREND'S OWN WORD beside the P86 status (the same key jobs and
    // change orders record), which is exactly what the safe confirm promises;
    // no P86 status, amount, number, purchase order or vendor moved anywhere.
    const strip = (r) => {
      const d = JSON.parse(r.data);
      delete d.btStatus;
      return Object.assign({}, r, { bt_bill_id: null, updated_at: null, data: JSON.stringify(d) });
    };
    for (const b of allBills()) {
      expect(strip(b)).toEqual(strip(JSON.parse(before.find((s) => JSON.parse(s).id === b.id))));
    }
    expect(billData('bill-a').btStatus).toBe('Unpaid');
    expect(billData('bill-h').btStatus).toBe('Partially Paid');   // the word P86 has no status for is kept
    // A press that moves no status invents no approval date, on a bill P86
    // already has paid least of all.
    expect(billRow('bill-f').approved_at).toBeNull();
    expect(billRow('bill-k').approved_at).toBeNull();
  });

  test('approved_at is stamped by the write that MOVES the status, and by nothing else', async () => {
    // bill-b: open with no approval date. The ticked status move stamps it.
    await put(ADMIN, { mode: 'rows', btIds: ['7002'], fields: ['status'] });
    const stamped = billRow('bill-b').approved_at;
    expect(stamped).toBeTruthy();
    // A second press moves nothing, and must not rewrite when it was approved.
    await put(ADMIN, { mode: 'rows', btIds: ['7002'], fields: ['status'] });
    expect(billRow('bill-b').approved_at).toBe(stamped);
    // A press on a bill whose status does not move leaves the column alone.
    await put(ADMIN, { mode: 'rows', btIds: ['7018'], fields: ['status'] });
    expect(billRow('bill-k').approved_at).toBeNull();
  });

  test('an "apply everything" press that names NO fields still does not move the money or the number', async () => {
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7001', '7005'] });
    expect(res.status).toBe(200);
    // Corrections DID apply (that is what an unfielded rows press does)...
    expect(billRow('bill-a').po_id).toBe('po-1');
    expect(billRow('bill-a').sub_id).toBe('s-1');
    // ...and the held-back money and match key did NOT.
    expect(Number(billRow('bill-a').amount)).toBe(1200);
    expect(billRow('bill-e').bill_number).toBe('BILL-0007');
  });

  test('ticked BY NAME, the amount moves — and only to the figure the preview was made from', async () => {
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7001'], fields: ['amount'] });
    expect(res.json.results[0].outcome).toBe('applied');
    expect(res.json.results[0].fields).toEqual([{ field: 'amount', from: '$1,200.00', to: '$1,500.00' }]);
    expect(Number(billRow('bill-a').amount)).toBe(1500);
    // The purchase order was NOT named, so it did not apply.
    expect(billRow('bill-a').po_id).toBeNull();
  });

  test('the apply RE-READS and RE-MATCHES: a P86 amount edited since the preview decides the from, and the browser’s figures decide nothing', async () => {
    const ds = await billRows();
    expect(fieldsOf(byBt(ds, 7001).heldBack).amount.p86Value).toBe(1200);
    setBill('bill-a', { amount: 1250 });
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7001'], fields: ['amount'] });
    // The proposal is recomputed against 1250, so that is the from - the stale
    // browser's 1200 never reaches the write.
    expect(res.json.results[0].fields).toEqual([{ field: 'amount', from: '$1,250.00', to: '$1,500.00' }]);
    expect(Number(billRow('bill-a').amount)).toBe(1500);
  });

  test('a PAID bill’s amount is refused even when the request names it: the re-match marks it not applicable', async () => {
    const ds = await billRows();
    expect(fieldsOf(byBt(ds, 7006).heldBack).amount.applicable).toBe(false);
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7006'], fields: ['amount'] });
    expect(Number(billRow('bill-f').amount)).toBe(900);
    expect(res.json.results[0].fields || []).toEqual([]);
    // And a bill P86 marks paid AFTER the preview is refused by the same route.
    setBill('bill-a', { status: 'paid' });
    const again = await put(ADMIN, { mode: 'rows', btIds: ['7001'], fields: ['amount'] });
    expect(Number(billRow('bill-a').amount)).toBe(1200);
    expect(again.json.results[0].fields || []).toEqual([]);
  });

  test('a VOID bill takes the link and nothing else, however the request is shaped', async () => {
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7013'], fields: ['status', 'amount', 'description', 'dueDate'] });
    const b = billRow('bill-i');
    expect([b.status, Number(b.amount), b.bt_bill_id]).toEqual(['void', 270, '7013']);
    expect(billData('bill-i').description).toBe('Voided here');
    expect(res.json.results[0].outcome).toBe('applied');   // the link
  });
});

describe('APPLY — the second layer: the row changes between the match and the lock', () => {
  test('a bill somebody PAID in the window keeps its amount', async () => {
    const ds = await billRows();
    expect(fieldsOf(byBt(ds, 7001).heldBack).amount.applicable).toBe(true);
    raceAtBegin(() => setBill('bill-a', { status: 'paid' }));
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7001'], fields: ['amount'] });
    expect(Number(billRow('bill-a').amount)).toBe(1200);
    expect((res.json.results[0].stale || []).join(' ')).toMatch(/Amount \u2014 the bill is paid in P86/);
  });

  test('a bill somebody VOIDED in the window takes the link and nothing else', async () => {
    raceAtBegin(() => setBill('bill-a', { status: 'void' }));
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7001'], fields: ['amount', 'po', 'sub', 'description'] });
    const b = billRow('bill-a');
    expect([b.status, Number(b.amount), b.po_id, b.sub_id]).toEqual(['void', 1200, null, null]);
    expect(b.bt_bill_id).toBe('7001');
    expect((res.json.results[0].stale || []).join(' ')).toMatch(/the bill is void in P86/);
  });

  test('a bill somebody moved FORWARD in the window is not moved back, nor moved twice', async () => {
    raceAtBegin(() => setBill('bill-b', { status: 'paid' }));
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7002'], fields: ['status'] });
    expect(billRow('bill-b').status).toBe('paid');
    expect((res.json.results[0].stale || []).join(' ')).toMatch(/Status \u2014 P86 is no longer behind Buildertrend/);
  });

  test('an amount somebody EDITED in the window is refused rather than overwritten', async () => {
    raceAtBegin(() => setBill('bill-a', { amount: 1250 }));
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7001'], fields: ['amount'] });
    expect(Number(billRow('bill-a').amount)).toBe(1250);
    expect((res.json.results[0].stale || []).join(' ')).toMatch(/Amount/);
  });

  test('a bill MOVED TO ANOTHER TENANT’S JOB in the window is not written at all', async () => {
    // The matcher decided on bill-a as a bill of j-1. If it is on j-b by the
    // time the transaction opens, the locked re-read must not find it: j-b
    // carries the SAME Buildertrend job id, so only the organization tells them
    // apart, and a write here would land on another tenant's job.
    raceAtBegin(() => setBill('bill-a', { job_id: 'j-b' }));
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7001'], fields: ['amount', 'po', 'sub'] });
    expect(res.json.results[0].outcome).toBe('skipped');
    expect(res.json.results[0].reason).toMatch(/no longer on the job linked to this Buildertrend job/);
    const b = billRow('bill-a');
    expect([b.bt_bill_id, Number(b.amount), b.po_id, b.sub_id]).toEqual([null, 1200, null, null]);
  });
});

// ── THE STATUS WRITE ──────────────────────────────────────────────────────
describe('APPLY — the status write, forward only', () => {
  test('open -> paid stamps approved_at, records Buildertrend’s own word, and never names an approver', async () => {
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7002'], fields: ['status'] });
    expect(res.json.results[0].outcome).toBe('applied');
    const b = billRow('bill-b');
    expect([b.status, b.bt_bill_id]).toEqual(['paid', '7002']);
    expect(b.approved_at).toBeTruthy();
    expect(b.approved_by).toBeNull();               // a sync never forges who approved a payable
    expect(billData('bill-b').btStatus).toBe('Paid');
    expect(billData('bill-b').paidAt).toBeUndefined();   // nor invents a payment date
  });

  test('a bill P86 already moved past Buildertrend keeps its status: the re-match proposes nothing at all', async () => {
    setBill('bill-b', { status: 'paid' });
    const ds = await billRows();
    expect(byBt(ds, 7002).corrections.map((c) => c.field)).not.toContain('status');
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7002'], fields: ['status'] });
    expect(billRow('bill-b').status).toBe('paid');
    expect((res.json.results[0].fields || []).map((x) => x.field)).not.toContain('status');
  });

  test('a backward move is never applied, even asked for by name', async () => {
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7018'], fields: ['status'] });
    expect(billRow('bill-k').status).toBe('approved');
    expect(res.json.results[0].fields || []).toEqual([]);
  });
});

// ── THE BILL NUMBER, WHICH IS A MATCH KEY ─────────────────────────────────
describe('APPLY — the bill number is offered, never corrected', () => {
  test('a P86 placeholder BILL-#### is offered Buildertrend’s real number, unticked', async () => {
    const ds = await billRows();
    const h = fieldsOf(byBt(ds, 7005).heldBack).billNumber;
    expect([h.applicable, h.bt, h.p86, h.value]).toEqual([true, 'INV-555', 'BILL-0007', 'INV-555']);
    expect(h.note).toMatch(/A bill number is a match key, so it is offered rather than corrected/);
    // It is never a correction, so it is never ticked by default.
    expect(byBt(ds, 7005).corrections.map((c) => c.field)).not.toContain('billNumber');
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7005'], fields: ['billNumber'] });
    expect(res.json.results[0].outcome).toBe('applied');
    expect(billRow('bill-e').bill_number).toBe('INV-555');
  });

  test('a DIFFERENT real number on each side is shown and never applied', async () => {
    setBill('bill-e', { bill_number: 'INV-OTHER' });
    const ds = await billRows();
    const h = fieldsOf(byBt(ds, 7005).heldBack).billNumber;
    expect([h.applicable, h.bt, h.p86]).toEqual([false, 'INV-555', 'INV-OTHER']);
    expect(h.note).toMatch(/A bill number is a MATCH KEY, never something a sync corrects/);
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7005'], fields: ['billNumber'] });
    expect(billRow('bill-e').bill_number).toBe('INV-OTHER');
    expect(res.json.results[0].fields || []).toEqual([]);
  });

  test('a number another P86 bill on the job already uses is refused and named', async () => {
    setBill('bill-c', { bill_number: 'INV-555' });
    const res = await put(ADMIN, { mode: 'rows', btIds: ['7005'], fields: ['billNumber'] });
    expect(billRow('bill-e').bill_number).toBe('BILL-0007');
    expect((res.json.results[0].stale || []).join(' ')).toMatch(/another P86 bill on this job already uses INV-555/);
  });

  test('billNumberKey, asked directly: a placeholder is no key, and leading zeros are NOT stripped', () => {
    expect(billMatch.billNumberKey('BILL-0007')).toBe('');
    expect(billMatch.billNumberKey('bill-12')).toBe('');
    expect(billMatch.billNumberKey('')).toBe('');
    expect(billMatch.billNumberKey('--')).toBe('');
    // Case, spacing and punctuation are the vendor's own formatting.
    expect(billMatch.billNumberKey('inv 100')).toBe(billMatch.billNumberKey('INV-100'));
    // Two DIFFERENT vendor invoices, and they must stay different.
    expect(billMatch.billNumberKey('0042')).not.toBe(billMatch.billNumberKey('42'));
  });
});

// ── CREATE ────────────────────────────────────────────────────────────────
describe('CREATE — the bills P86 lacks', () => {
  test('one: created on its linked job at Buildertrend’s amount, with its purchase order, vendor and dates', async () => {
    const res = await put(ADMIN, { mode: 'create', btIds: ['7015'] });
    expect(res.json.counts.created).toBe(1);
    const b = billRow(res.json.results[0].p86Id);
    expect([b.job_id, b.bill_number, Number(b.amount), b.status, b.po_id, b.sub_id, b.bt_bill_id])
      .toEqual(['j-2', 'INV-J2', 777.25, 'open', 'po-2', 's-2', '7015']);
    expect([b.bill_date, b.due_date]).toEqual(['2026-03-01', '2026-03-31']);
    expect(b.approved_at).toBeNull();
    expect(billData(b.id).description).toBe('Bill INV-J2');
    expect(billData(b.id).lienWaiver).toBe('none');
  });

  test('THE ORGANIZATION COMES FROM THE PARENT JOB, never from the request', async () => {
    const res = await put(ADMIN, { mode: 'create', btIds: ['7015'] });
    const b = billRow(res.json.results[0].p86Id);
    expect(b.organization_id).toBe(AGX);
    expect(engine.db.prepare('SELECT organization_id FROM jobs WHERE id = ?').get('j-2').organization_id).toBe(AGX);
    // Every bill on every job still carries its own job's organization.
    for (const row of allBills()) {
      if (row.organization_id == null) continue;       // the deliberate legacy row
      const jobOrg = engine.db.prepare('SELECT organization_id FROM jobs WHERE id = ?').get(row.job_id).organization_id;
      expect(row.organization_id).toBe(jobOrg);
    }
  });

  test('no vendor invoice number: P86 assigns its own BILL-#### and says so', async () => {
    const res = await put(ADMIN, { mode: 'create', btIds: ['7019'] });
    const b = billRow(res.json.results[0].p86Id);
    expect(b.bill_number).toMatch(/^BILL-\d{4}$/);
    expect(b.bill_number).not.toBe('BILL-0007');        // the existing placeholder is counted
    expect(res.json.results[0].notes.join(' ')).toMatch(/sent no vendor invoice number, so P86 assigned/);
  });

  test('a Buildertrend bill PAID is created paid, with approved_at stamped and no approver', async () => {
    engine.db.prepare("DELETE FROM job_vendor_bills WHERE id = 'bill-f'").run();
    const res = await put(ADMIN, { mode: 'create', btIds: ['7006'] });
    const b = billRow(res.json.results[0].p86Id);
    expect([b.status, Number(b.amount)]).toEqual(['paid', 950]);
    expect(b.approved_at).toBeTruthy();
    expect(b.approved_by).toBeNull();
  });

  test('a purchase order P86 has not imported leaves po_id blank and says where to import it', async () => {
    const res = await put(ADMIN, { mode: 'create', btIds: ['7009'] });
    const b = billRow(res.json.results[0].p86Id);
    expect(b.po_id).toBeNull();
    expect(res.json.results[0].notes.join(' ')).toMatch(/9999 is not on this P86 job yet/);
  });

  test('a vendor that is not exactly one P86 sub leaves the vendor blank and keeps the name', async () => {
    const res = await put(ADMIN, { mode: 'create', btIds: ['7008'] });
    const b = billRow(res.json.results[0].p86Id);
    expect([b.sub_id, b.po_id]).toEqual([null, null]);
    expect(res.json.results[0].notes.join(' ')).toMatch(/2 purchase orders on this bill/);
  });

  test('the same Buildertrend bill is never created twice', async () => {
    const first = await put(ADMIN, { mode: 'create', btIds: ['7015'] });
    expect(first.json.counts.created).toBe(1);
    const again = await put(ADMIN, { mode: 'create', btIds: ['7015'] });
    expect(again.json.results[0].outcome).toBe('skipped');
    expect(billByBt('7015')).toHaveLength(1);
  });

  test('a P86 bill the PREVIEW cannot see but that already carries the id blocks the create', async () => {
    // A bill on THIS organization's job stamped with ANOTHER organization is
    // invisible to the org-scoped read, so the matcher calls 7004 "new". The
    // create's own check reaches it anyway - through the JOB, without the
    // bill's own column - and refuses, instead of minting a second P86 bill on
    // the same Buildertrend id for the unique index to reject.
    engine.db.prepare('INSERT INTO job_vendor_bills (id, job_id, organization_id, status, bill_number, amount, data, bt_bill_id) VALUES (?,?,?,?,?,?,?,?)')
      .run('bill-mis', 'j-1', OTHER, 'open', 'INV-NEW', 640, '{}', '7004');
    const ds = await billRows();
    expect(byBt(ds, 7004)['class']).toBe('new');          // the read genuinely cannot see it
    expect(JSON.stringify(ds)).not.toContain('bill-mis');
    const res = await put(ADMIN, { mode: 'create', btIds: ['7004'] });
    expect(res.json.results[0].outcome).toBe('skipped');
    expect(res.json.results[0].reason).toMatch(/already linked to this Buildertrend bill/);
    expect(billByBt('7004').map((b) => b.id)).toEqual(['bill-mis']);
  });

  test('a created bill takes ONLY a purchase order carrying that exact Buildertrend id', async () => {
    // j-2 has exactly one purchase order, and 7021 names a Buildertrend id that
    // is not its. Matching on "the job's only purchase order" would attach the
    // bill to a commitment Buildertrend never named.
    const res = await put(ADMIN, { mode: 'create', btIds: ['7021'] });
    const b = billRow(res.json.results[0].p86Id);
    expect(b.po_id).toBeNull();
    expect(b.sub_id).toBeNull();                          // and no vendor inherited from it
    expect(res.json.results[0].notes.join(' ')).toMatch(/8888 is not on this P86 job yet/);
  });

  test('a bulk create makes every creatable row and no refused, ambiguous or already-matched one', async () => {
    const res = await put(ADMIN, { mode: 'create' });
    const madeFor = res.json.results.filter((r) => r.outcome === 'created').map((r) => r.btId).sort();
    expect(madeFor).toEqual(['7004', '7008', '7009', '7014', '7015', '7019', '7021', '7022']);
    for (const id of ['7003', '7010', '7012', '7050', '7016', '7017', '7001']) expect(madeFor).not.toContain(id);
  });
});

// ── LINK ──────────────────────────────────────────────────────────────────
describe('LINK — a person picks between candidates, and only a listed one', () => {
  test('only a candidate the matcher listed links, and only the id is written', async () => {
    const before = Number(billRow('bill-c').amount);
    const ok = await put(ADMIN, { mode: 'link', btId: '7003', p86Id: 'bill-c' });
    expect(ok.json.counts.linked).toBe(1);
    const b = billRow('bill-c');
    expect([b.bt_bill_id, b.status, Number(b.amount)]).toEqual(['7003', 'open', before]);
    // A second Buildertrend bill cannot take a P86 bill someone already linked.
    // 7016 and 7017 both list bill-j; once one has it, the re-match drops bill-j
    // out of the OTHER's candidates entirely (rung 1 only ever considers P86
    // bills with no Buildertrend id), so the second link is refused for the
    // stronger reason: it is not a candidate at all, and 7017 is now simply a
    // Buildertrend bill P86 does not have.
    const first = await put(ADMIN, { mode: 'link', btId: '7016', p86Id: 'bill-j' });
    expect(first.json.counts.linked).toBe(1);
    const twice = await put(ADMIN, { mode: 'link', btId: '7017', p86Id: 'bill-j' });
    expect(twice.json.counts.linked).toBeFalsy();
    expect(twice.json.results[0].reason).toMatch(/not one of the candidates/);
    expect(billRow('bill-j').bt_bill_id).toBe('7016');
    const ds = await billRows();
    expect(byBt(ds, 7017)['class']).toBe('new');
  });

  test('a P86 bill that is NOT a listed candidate is refused', async () => {
    const res = await put(ADMIN, { mode: 'link', btId: '7003', p86Id: 'bill-g' });
    expect(res.json.results[0].reason).toMatch(/not one of the candidates/);
    expect(billRow('bill-g').bt_bill_id).toBeNull();
  });

  test('ANOTHER ORGANIZATION’s bill never links, however it is named', async () => {
    const res = await put(ADMIN, { mode: 'link', btId: '7003', p86Id: 'bill-x' });
    expect(res.json.counts.linked).toBeFalsy();
    expect(billRow('bill-x').bt_bill_id).toBeNull();
  });
});

// ── THE TENANT BOUNDARY ───────────────────────────────────────────────────
describe('THE TENANT — another organization is never read, matched or written', () => {
  test('the other tenant’s job carries the same Buildertrend job id and the same invoice number, and reaches nothing', async () => {
    const ds = await billRows();
    expect(byBt(ds, 7001).p86.id).toBe('bill-a');
    const json = JSON.stringify(ds);
    expect(json).not.toContain('bill-x');
    expect(json).not.toContain('j-b');
    expect(json).not.toContain('po-x');
    expect(json).not.toContain('Other Tenant Sub');
  });

  test('the bills read is scoped to this organization’s jobs, so no P86 bill hides behind an unlisted one', async () => {
    const ds = await billRows();
    // Every P86 bill the read returned is on a job this read also returned, so
    // nothing is silently dropped from "not in Buildertrend". The other
    // tenant's bill-x sits on j-b: read unscoped it would land here, counted
    // but unnamed, which is how a cross-tenant row hides in plain sight.
    expect(ds.notInBuildertrend.notListed).toBe(0);
    expect(ds.notInBuildertrend.rows.map((p) => p.id)).toEqual(['bill-g']);
  });

  test('no press of any shape touches the other tenant’s bill', async () => {
    const before = JSON.stringify(billRow('bill-x'));
    await put(ADMIN, { mode: 'safe' });
    await put(ADMIN, { mode: 'create' });
    await put(ADMIN, { mode: 'rows', btIds: BT_BILLS.map((b) => b.billId), fields: ['amount', 'status', 'po', 'sub', 'billNumber'] });
    expect(JSON.stringify(billRow('bill-x'))).toBe(before);
    expect(engine.db.prepare('SELECT COUNT(*) AS n FROM job_vendor_bills WHERE job_id = ?').get('j-b').n).toBe(1);
  });

  test('a PM without ROLES_MANAGE is refused, and the other tenant’s admin is refused by the owner gate', async () => {
    const pm = await put(PM, { mode: 'safe' });
    expect(pm.status).toBe(403);
    const other = await call('PUT', APPLY, { id: 20, email: 'admin@other.test', name: 'Oscar Other', role: 'admin', organization_id: OTHER },
      { dataset: 'bills', mode: 'safe' });
    expect(other.status).toBe(403);
    expect(count('job_vendor_bills')).toBe(14);
  });
});

// ── THE PLUMBING ──────────────────────────────────────────────────────────
describe('the dataset is wired in everywhere a dataset has to be', () => {
  test('bills is a preview kind, an apply dataset, and a since-refresh snapshot', () => {
    expect(applyMod.parseInput({ dataset: 'bills', mode: 'safe' }).error).toBeUndefined();
    expect(applyMod.parseInput({ dataset: 'nope', mode: 'safe' }).error).toMatch(/"bills"/);
    expect(Object.keys(since.SNAPSHOT_FIELDS)).toContain('bills');
    const snap = since.snapshotOf('bills', readRecord('bills', BT_BILLS[0]));
    expect(snap).toEqual({ billNumber: 'INV-100', title: 'Paint invoice', job: 'Job 111', status: 'Unpaid',
      amount: 1500, amountPaid: 0, remainingBalance: 1500, vendor: 'Catica International Inc',
      invoiceDate: '2026-03-01', dueDate: '2026-03-31' });
    expect(since.snapshotLabel('bills', snap, '7001')).toBe('INV-100 Paint invoice (Job 111)');
  });

  test('a changed Buildertrend amount reads as a CHANGE, and an apply never does', () => {
    const a = since.snapshotOf('bills', readRecord('bills', BT_BILLS[0]));
    const b = since.snapshotOf('bills', readRecord('bills', Object.assign({}, BT_BILLS[0], { amount: 1600, paymentStatus: 'Paid' })));
    expect(since.diffSnapshots(a, b, 'bills').map((c) => [c.field, c.from, c.to]))
      .toEqual([['status', 'Unpaid', 'Paid'], ['amount', '$1,500.00', '$1,600.00']]);
    expect(since.sameSnapshot(a, a, 'bills')).toBe(true);
  });

  test('the amount and the bill number are NOT in the correction table — writable() could not apply either', () => {
    const row = { corrections: [{ field: 'amount', value: 9 }, { field: 'billNumber', value: 'X' }, { field: 'status', value: 'paid' }], heldBack: [] };
    expect(applyMod.writable('bills', row, 'rows', null).map((c) => c.field)).toEqual(['status']);
    // ...and safe mode applies no bill correction at all.
    expect(applyMod.writable('bills', row, 'safe', null)).toEqual([]);
  });

  test('pickedHeldBack refuses the money unless the request names it, and refuses it outright in safe mode', () => {
    const row = { corrections: [], heldBack: [{ field: 'amount', applicable: true }, { field: 'status', applicable: false }] };
    expect(applyMod.pickedHeldBack('bills', row, 'rows', ['amount']).map((h) => h.field)).toEqual(['amount']);
    expect(applyMod.pickedHeldBack('bills', row, 'rows', ['status'])).toEqual([]);
    expect(applyMod.pickedHeldBack('bills', row, 'rows', null)).toEqual([]);
    expect(applyMod.pickedHeldBack('bills', row, 'safe', ['amount'])).toEqual([]);
  });

  test('a linked bill whose Buildertrend word P86 has not recorded yet keeps the safe press live', async () => {
    const ds = await billRows();
    // bill-h has never recorded a word, so its row is due one.
    expect(byBt(ds, 7007).btStatusDue).toBe(true);
    // EXACTLY what the safe button's own sub-text promises before the press
    // (js/bt-sync-preview.js statusWordCount, over this same preview).
    const promised = ds.rows.filter((r) => (r['class'] === 'matched' || r['class'] === 'conflict')
      && r.bt && r.bt.btId != null && r.bt.btId !== '' && r.btStatusDue === true).length;
    expect(promised).toBeGreaterThan(0);
    const res = await put(ADMIN, { mode: 'safe' });
    // THE REPORT, not only the row. Buildertrend’s own word is the only thing
    // those rows changed, so a press that does not count it reads as a bare
    // "N updated" with no field named - on a money page.
    expect(res.json.counts.statusWord).toBe(promised);
    expect(res.json.results.filter((r) => r.btStatus).length).toBe(promised);
    expect(billData('bill-h').btStatus).toBe('Partially Paid');
    const after = await billRows();
    expect(byBt(after, 7007).btStatusDue).toBe(false);
    // An ambiguous row never carries one.
    expect(byBt(after, 7016).btStatusDue).toBe(false);
  });

  test('a press whose ONLY effect is Buildertrend’s word says so, instead of a bare "1 updated"', async () => {
    await put(ADMIN, { mode: 'safe' });                  // links everything, records every word
    const d = billData('bill-h');
    expect(d.btStatus).toBe('Partially Paid');
    setBill('bill-h', { data: JSON.stringify(Object.assign({}, d, { btStatus: 'Unpaid' })) });
    const res = await put(ADMIN, { mode: 'safe' });
    // Already linked, no correction a safe press can apply: the word is the
    // whole of what moved, and it is the only thing the page can point at.
    expect(res.json.counts).toMatchObject({ applied: 1, fields: 0, statusWord: 1 });
    expect(res.json.counts.linked).toBeFalsy();
    expect(billData('bill-h').btStatus).toBe('Partially Paid');
  });

  test('a DATE column reads as its written calendar day whether pg hands back a Date or the engine hands back text', () => {
    expect(billMatch.dayKey('2026-03-01')).toBe('2026-03-01');
    expect(billMatch.dayKey('2026-03-01T05:00:00.000Z')).toBe('2026-03-01');
    // A Date at LOCAL midnight, which is what pg builds for type 1082.
    expect(billMatch.dayKey(new Date(2026, 2, 1))).toBe('2026-03-01');
    expect(billMatch.dayKey(new Date(2026, 11, 31))).toBe('2026-12-31');
    expect(billMatch.dayKey(null)).toBe('');
  });
});
