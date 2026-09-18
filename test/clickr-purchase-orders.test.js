// Buildertrend purchase orders → P86 purchase orders (services/clickr/po-match.js,
// sync-apply.js). Status moves forward only; cost lands on an unlocked PO's line
// or, ticked on purpose, as an approved addendum on a locked one — never below
// what is billed; a sub is filled only from exactly one sub of THIS organization.
// No bill is ever created. A PO a sync leaves sent or approved (any active
// status) with a sub of THIS organization gives that sub portal access to the
// job's files — the PO page's own grant (services/po-sub-access.js), run after
// the purchase-order write commits: never for a draft, a PO without a sub, a
// foreign sub, or a write that did not persist. A sub that already has that
// access is left alone (nothing rewritten, nothing reported); one whose access
// is missing — a linked, up-to-date PO included — is counted on the page's safe
// button, named in its confirm, and given access when it is pressed.
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
// The derived schema carries no constraints. These two are the ones the grant's
// ON CONFLICT arms name (server/db.js: idx_job_subs_unique_v2 and the table
// UNIQUE on attachment_folder_grants) — without them every grant would throw
// at prepare and "no access was granted" would pass for the wrong reason.
engine.db.exec(`
  CREATE UNIQUE INDEX idx_job_subs_unique_v2 ON job_subs(job_id, sub_id);
  CREATE UNIQUE INDEX idx_afg_unique ON attachment_folder_grants(sub_id, entity_type, entity_id, folder);
`);

// ── the transaction boundary pg-sqlite cannot show ─────────────────────────
// Postgres runs a pool query on ANOTHER connection: inside a client's open
// transaction it cannot see that transaction's uncommitted PO, and its own
// writes survive the transaction's rollback. pg-sqlite has one connection, so
// it would show neither. Instead, every grant write that reaches the POOL while
// a client transaction is open is recorded, and the tests require none.
const txWatch = { open: 0, grantsInsideTx: [], failCommit: 0 };
const GRANT_WRITE = /INSERT INTO (job_subs|attachment_folder_grants)\b/i;
{
  const rawConnect = engine.pool.connect;
  const rawQuery = engine.pool.query;
  engine.pool.connect = async () => {
    const c = await rawConnect();
    let inTx = false;
    const close = () => { if (inTx) { inTx = false; txWatch.open--; } };
    return {
      query: async (sql, params) => {
        const t = String(sql).trim().toUpperCase();
        if (t === 'BEGIN') { inTx = true; txWatch.open++; }
        if (t === 'COMMIT' && txWatch.failCommit > 0) { txWatch.failCommit--; throw new Error('test: the commit was refused'); }
        const out = await c.query(sql, params);
        if (t === 'COMMIT' || t === 'ROLLBACK') close();
        return out;
      },
      release: () => { close(); c.release(); },
    };
  };
  engine.pool.query = async (sql, params) => {
    if (txWatch.open > 0 && GRANT_WRITE.test(String(sql))) txWatch.grantsInsideTx.push(String(sql).replace(/\s+/g, ' ').slice(0, 60));
    return rawQuery(sql, params);
  };
}

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
const poRoutes = require('../server/routes/purchase-order-routes');

const KEY = 'ck_live_Zq9SECRETKEYxy7_0123456789ab';
const BASE = 'https://api.clickr.cloud';
const AGX = 1;
const OTHER = 2;

let seq = 0;
function poRec(id, jobId, poNumber, title, status, cost, o) {
  seq++;
  o = o || {};
  return Object.assign({
    // Clickr's REST records carry no _id: identity is purchaseOrderId, and several share a jobId.
    accountId: 'a', integrationId: 'i', builderId: 'b', purchaseOrderId: String(id),
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
  // P1: P86 closed this purchase order; Buildertrend is still in draft, so it is
  // BUILDERTREND that is behind.
  poRec(8018, 111, '0018', 'Closed here, draft there', 'Draft', 500),
  // P3: recalled in Buildertrend, with a P86 purchase order already linked to it.
  poRec(8019, 111, '0019', 'Recalled but linked', 'Sub/Vendor Approved', 700, { recalled: true }),
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
  po.run('po-i', 'j-1', AGX, 10, null, 'closed', '0018', JSON.stringify({ title: 'Closed here, draft there', lines: [line(500)], baselineTotal: 500 }), 1);
  po.run('po-j', 'j-1', AGX, 10, null, 'approved', '0019', JSON.stringify({ title: 'Recalled but linked', lines: [line(700)], baselineTotal: 700 }), 1);
  engine.db.prepare("UPDATE job_purchase_orders SET bt_po_id = '8019' WHERE id = 'po-j'").run();
  po.run('po-x', 'j-b', OTHER, 20, null, 'draft', '0001', JSON.stringify({ title: 'Exterior paint labor', lines: [line(5000)] }), 0);
  const bill = engine.db.prepare('INSERT INTO job_vendor_bills (id, job_id, po_id, status, amount, organization_id) VALUES (?,?,?,?,?,?)');
  bill.run('b-1', 'j-1', 'po-b', 'open', 1000, AGX);
  bill.run('b-2', 'j-1', 'po-f', 'approved', 900, AGX);
}

const poRow = (id) => engine.db.prepare('SELECT * FROM job_purchase_orders WHERE id = ?').get(id);
const poData = (id) => JSON.parse(poRow(id).data);
const poByBt = (btId) => engine.db.prepare('SELECT * FROM job_purchase_orders WHERE bt_po_id = ?').all(btId);
const count = (table) => engine.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
const setPo = (id, sets) => engine.db.prepare('UPDATE job_purchase_orders SET ' + Object.keys(sets).map((k) => k + ' = ?').join(', ') + ' WHERE id = ?')
  .run(...Object.values(sets), id);

// What sub portal access exists: the job-level assignment (with the tenant it
// was stamped with) and the job folder grant that surfaces the job in the portal.
function access() {
  return {
    assigned: engine.db.prepare('SELECT job_id, sub_id, level, organization_id FROM job_subs').all()
      .map((r) => r.job_id + '/' + r.sub_id + '/' + r.level + '@' + r.organization_id).sort(),
    granted: engine.db.prepare('SELECT sub_id, entity_type, entity_id, folder FROM attachment_folder_grants').all()
      .map((r) => r.sub_id + ' -> ' + r.entity_type + ':' + r.entity_id + '/' + r.folder).sort(),
  };
}
const NONE = { assigned: [], granted: [] };
// Access for these subs on job j-1, stamped with j-1's tenant.
const onJ1 = (...subs) => ({
  assigned: subs.map((s) => 'j-1/' + s + '/job@' + AGX).sort(),
  granted: subs.map((s) => s + ' -> job:j-1/general').sort(),
});
const clearAccess = () => engine.db.exec('DELETE FROM job_subs; DELETE FROM attachment_folder_grants;');

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

let warn;
const refusals = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => /\[po sub-access\] refused:/.test(m));

beforeAll(async () => {
  seed();
  setRolePool(engine.pool);
  await refreshRoleCache();
  const app = express();
  app.use(express.json());
  app.use('/api/admin/organizations', orgRoutes);
  app.use('/api', poRoutes);
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
  txWatch.grantsInsideTx = [];
  txWatch.failCommit = 0;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await refreshRoleCache();
});
afterEach(() => {
  // The grant must never have run through the pool inside a PO transaction.
  expect(txWatch.grantsInsideTx).toEqual([]);
  expect(txWatch.open).toBe(0);
  warn.mockRestore();
});

describe('PREVIEW — purchase orders matched inside their own linked job', () => {
  test('classes, rungs and proposals', async () => {
    const ds = await poRows();
    expect(ds.classified).toBe(true);
    // Several records share a jobId: the read is still whole.
    expect([ds.fetch.complete, ds.fetch.reason]).toEqual([true, null]);
    expect(ds.mapping.missingKeys).toEqual([]);
    expect(ds.mapping.unexpectedKeys).toEqual([]);

    const r1 = byBt(ds, 8001);
    expect([r1.class, r1.rung, r1.p86.id]).toEqual(['conflict', 'PO number', 'po-a']);
    const f1 = Object.fromEntries(r1.corrections.map((c) => [c.field, c]));
    expect(Object.keys(f1).sort()).toEqual(['cost', 'costCode', 'scheduledCompletion', 'status', 'sub']);
    expect([f1.status.value, f1.sub.value, f1.cost.value, f1.scheduledCompletion.to]).toEqual(['approved', 's-1', 5500, '2026-10-01']);
    // The page says what applying does: the sub gets portal access once the PO is sent or approved.
    expect(f1.status.note).toMatch(/sub gets portal access to the job's files, as on the PO page/);
    expect(f1.status.note).not.toMatch(/does not grant/);
    expect(f1.sub.note).toMatch(/portal access to the job's files once the purchase order is sent or approved/);

    // Locked: the status moves forward; the cost is an addendum a person must tick.
    const r2 = byBt(ds, 8002);
    expect(r2.corrections.map((c) => [c.field, c.value])).toEqual([['status', 'work_complete']]);
    expect(r2.heldBack.map((h) => [h.field, h.applicable])).toEqual([['title', false], ['cost', true]]);

    // Backwards status and a DIFFERENT sub: shown, never applicable.
    expect(byBt(ds, 8003).heldBack.map((h) => [h.field, h.applicable])).toEqual([['status', false], ['sub', false]]);
    expect(byBt(ds, 8004).class).toBe('ambiguous');
    expect(byBt(ds, 8005).heldBack.map((h) => [h.field, h.applicable])).toEqual([['cost', false]]);
    // P1: P86 closed is the END of a purchase order, so Buildertrend approved
    // AGREES with it — only the cost difference is left to show.
    expect(byBt(ds, 8006).heldBack.map((h) => [h.field, h.applicable])).toEqual([['cost', false]]);
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
    // Nothing synced yet, no access anywhere: only active POs with an org sub are due.
    expect(ds.rows.filter((r) => r.subAccessDue).map((r) => String(r.bt.btId)).sort()).toEqual(['8002', '8003']);

    expect(ds.notInBuildertrend.rows.map((p) => p.id)).toEqual(['po-e']);
    expect(JSON.stringify(ds)).not.toContain('po-x');
  });
});

describe('PREVIEW — a closed P86 purchase order, a recall, and which approval it was', () => {
  test('P1 — Buildertrend approved or work complete agrees with a P86 closed purchase order; nothing is held back and nothing corrected', async () => {
    const ds = await poRows();
    const r6 = byBt(ds, 8006);             // Sub/Vendor Approved vs P86 closed
    expect(r6.heldBack.map((h) => h.field)).not.toContain('status');
    expect(r6.corrections.map((c) => c.field)).not.toContain('status');
    expect(JSON.stringify(r6)).not.toMatch(/never moves a purchase order backwards/);
  });

  test('P1 — a Buildertrend draft against a P86 closed purchase order is called out as BUILDERTREND being behind', async () => {
    const ds = await poRows();
    const r = byBt(ds, 8018);
    expect([r.class, r.rung, r.p86.id]).toEqual(['matched', 'PO number', 'po-i']);
    expect(r.corrections).toEqual([]);
    const st = r.heldBack.find((h) => h.field === 'status');
    expect([st.applicable, st.bt, st.p86]).toEqual([false, 'Draft', 'Closed']);
    expect(st.note).toBe('Buildertrend is behind P86 here: P86 closed this purchase order. Nothing is proposed — move it on in Buildertrend if P86 is right.');
    expect(st.note).not.toMatch(/never moves a purchase order backwards/);
  });

  test('P3 — a recalled purchase order a P86 one is LINKED to is computed and names what P86 still has', async () => {
    const ds = await poRows();
    const r = byBt(ds, 8019);
    expect([r.class, r.rung, r.p86.id]).toEqual(['matched', 'Buildertrend ID', 'po-j']);
    expect(r.corrections).toEqual([]);
    const st = r.heldBack.find((h) => h.bt === 'Recalled');
    expect([st.field, st.applicable, st.p86]).toEqual(['status', false, 'Approved']);
    expect(st.note).toBe('Recalled in Buildertrend. P86 still has this purchase order as Approved. A recall is never applied — decide in P86 what happens to it.');
  });

  test('P3 — an UNLINKED recalled purchase order stays refused, and is never created', async () => {
    const ds = await poRows();
    const r = byBt(ds, 8015);
    expect([r.class, r.p86]).toEqual(['refused', null]);
    expect(r.notes.join(' ')).toBe('Recalled in Buildertrend, and no P86 purchase order is linked to it.');
    const created = await put(ADMIN, { mode: 'create' });
    expect(created.json.results.some((x) => x.btId === '8015')).toBe(false);
    expect(poByBt('8015')).toHaveLength(0);
  });

  test('P4 — the row says which Buildertrend approval it was, and never claims a P86 e-sign', async () => {
    const ds = await poRows();
    expect(byBt(ds, 8001).bt.approvalKind).toBe('sub');            // Sub/Vendor Approved
    expect(byBt(ds, 8005).bt.approvalKind).toBe('internal');       // Internally Approved
    expect(byBt(ds, 8016).bt.approvalKind).toBe('internal');       // Approved - Assigned Internally
    expect(byBt(ds, 8004).bt.approvalKind).toBeNull();             // Draft
    expect(byBt(ds, 8003).bt.approvalKind).toBeNull();             // Sent to Sub/Vendor - Pending
    expect(JSON.stringify(ds)).not.toMatch(/e-sign/i);
  });
});

describe('PREVIEW — the status note promises portal access only where there is a sub of this organization', () => {
  const statusNote = async () => (byBt(await poRows(), 8005).corrections.find((c) => c.field === 'status') || {}).note || '';
  test('no sub, another tenant\'s sub, then a sub of this organization', async () => {
    // po-f issued; Buildertrend 8005 is approved and names no sub: a forward status correction.
    setPo('po-f', { status: 'issued' });
    expect(await statusNote()).not.toMatch(/portal access/);
    setPo('po-f', { sub_id: 's-x' });
    expect(await statusNote()).not.toMatch(/portal access/);
    setPo('po-f', { sub_id: 's-2' });
    expect(await statusNote()).toMatch(/its sub gets portal access to the job's files, as on the PO page/);
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

  test('P4 — which Buildertrend approval it was is stored, at apply and at create', async () => {
    // APPLY: 0001 is "Sub/Vendor Approved" and moves the P86 draft to approved.
    await put(ADMIN, { btIds: ['8001'], fields: ['status'] });
    expect(poData('po-a').approvedInBuildertrend).toEqual({ by: 'Catica Office', kind: 'sub' });
    // The distinction is stored, never a P86 acceptance: nothing claims an e-sign.
    expect(poData('po-a').acceptance).toBeUndefined();
    // CREATE: 0010 is the sub's approval, 0016 the builder's own.
    await put(ADMIN, { mode: 'create' });
    const made = (btId) => JSON.parse(poByBt(btId)[0].data);
    expect(made('8010').approvedInBuildertrend).toEqual({ by: 'Catica Office', kind: 'sub' });
    expect(made('8016').approvedInBuildertrend).toEqual({ by: 'Catica Office', kind: 'internal' });
    expect(made('8016').acceptance).toBeUndefined();
    // A draft carries no approval at all.
    expect(made('8011').approvedInBuildertrend).toBeUndefined();
  });

  test('P4 — a purchase order P86 ALREADY has approved records which approval it was, though nothing moves', async () => {
    // 8005 is "Internally Approved" and po-f is already approved, so the two
    // AGREE: there is no status correction, which is exactly the case the stamp
    // used to sit inside and therefore never reached. It is also the common one.
    const ds = await poRows();
    const r5 = byBt(ds, 8005);
    expect([r5.class, r5.p86.id, r5.approvalKindDue]).toEqual(['matched', 'po-f', true]);
    expect(r5.corrections.map((c) => c.field)).not.toContain('status');
    expect(poData('po-f').approvedInBuildertrend).toBeUndefined();

    // The safe press reaches it, and is what records it.
    const r = await put(ADMIN, { mode: 'safe' });
    expect(poData('po-f').approvedInBuildertrend).toEqual({ by: 'Catica Office', kind: 'internal' });
    expect([poRow('po-f').status, poRow('po-f').is_locked]).toEqual(['approved', 1]);
    expect(r.json.counts.approvalKind).toBeGreaterThan(0);
    // Never a P86 acceptance: nothing claims the sub e-signed.
    expect(poData('po-f').acceptance).toBeUndefined();

    // Recorded once: the next read no longer asks, and pressing again is unchanged.
    const after = await poRows();
    expect(byBt(after, 8005).approvalKindDue).toBe(false);
    const again = await put(ADMIN, { btIds: ['8005'], fields: [] });
    expect(again.json.results[0].outcome).toBe('unchanged');
  });

  test('P4 — a RECALLED purchase order never records an approval Buildertrend withdrew', async () => {
    // 8019 says "Sub/Vendor Approved" and po-j is approved, but Buildertrend
    // recalled it: the approval is not P86's to record.
    const ds = await poRows();
    expect(byBt(ds, 8019).approvalKindDue).toBe(false);
    await put(ADMIN, { mode: 'safe' });
    expect(poData('po-j').approvedInBuildertrend).toBeUndefined();
  });

  test('no bill is ever written; sub access only for an active PO with a sub of this organization', async () => {
    const bills = count('job_vendor_bills');
    await put(ADMIN, { mode: 'safe' });
    await put(ADMIN, { btIds: ['8001', '8002'] });
    await put(ADMIN, { mode: 'create' });
    expect(count('job_vendor_bills')).toBe(bills);
    // s-1: po-c (work complete, linked by safe mode), po-a (8001 approved with its
    // sub filled) and the created 8010. s-2: po-b. Never s-x (po-h is a draft;
    // 8016's vendor is another tenant's sub and was never set).
    expect(access()).toEqual(onJ1('s-1', 's-2'));
    expect(JSON.stringify(access())).not.toContain('s-x');
  });
});

describe('APPLY — sub portal access, as the PO page grants it', () => {
  test('0001 applied approved with its sub filled: the sub is assigned to the job and granted its files, and the result says so', async () => {
    expect(access()).toEqual(NONE);
    const r = await put(ADMIN, { btIds: ['8001'] });
    expect([r.json.results[0].outcome, r.json.results[0].subAccess, r.json.counts.subAccess]).toEqual(['applied', true, 1]);
    expect(access()).toEqual(onJ1('s-1'));
    // Stamped with the job's tenant, granted by the person who pressed Apply.
    expect(engine.db.prepare('SELECT granted_by FROM attachment_folder_grants').get().granted_by).toBe(10);
  });

  test('a sub filled on a draft grants nothing; the status move out of draft then grants it', async () => {
    const sub = await put(ADMIN, { btIds: ['8001'], fields: ['sub'] });
    expect([poRow('po-a').status, poRow('po-a').sub_id]).toEqual(['draft', 's-1']);
    expect([sub.json.results[0].outcome, sub.json.results[0].subAccess]).toEqual(['applied', undefined]);
    expect(access()).toEqual(NONE);
    const status = await put(ADMIN, { btIds: ['8001'], fields: ['status'] });
    expect(poRow('po-a').status).toBe('approved');
    expect(status.json.results[0].subAccess).toBe(true);
    expect(access()).toEqual(onJ1('s-1'));
  });

  test('a status move on a PO that already has its sub (po-b, s-2) grants that sub', async () => {
    const r = await put(ADMIN, { btIds: ['8002'], fields: ['status'] });
    expect([poRow('po-b').status, r.json.results[0].subAccess]).toEqual(['work_complete', true]);
    expect(access()).toEqual(onJ1('s-2'));
  });

  test('an active PO without a sub grants nothing', async () => {
    const r = await put(ADMIN, { btIds: ['8005'] });
    expect([r.json.results[0].outcome, poRow('po-f').bt_po_id, r.json.results[0].subAccess]).toEqual(['applied', '8005', undefined]);
    expect(access()).toEqual(NONE);
  });

  test('pressing Apply again on a PO already up to date still gives its sub access (POs synced before this rule)', async () => {
    await put(ADMIN, { btIds: ['8002'], fields: ['status'] });
    clearAccess();
    const r = await put(ADMIN, { btIds: ['8002'], fields: ['status'] });
    expect([r.json.results[0].outcome, r.json.results[0].subAccess]).toEqual(['unchanged', true]);
    expect(access()).toEqual(onJ1('s-2'));
    // Pressed once more with the access in place: nothing to give, nothing reported.
    const again = await put(ADMIN, { btIds: ['8002'], fields: ['status'] });
    expect([again.json.results[0].outcome, again.json.results[0].subAccess, again.json.counts.subAccess]).toEqual(['unchanged', undefined, undefined]);
    expect(access()).toEqual(onJ1('s-2'));
  });

  test('access a sub already has is left alone: who granted it and when are not rewritten', async () => {
    engine.db.exec(`
      INSERT INTO job_subs (id, job_id, sub_id, level, status, organization_id) VALUES ('js-hand', 'j-1', 's-2', 'job', 'active', 1);
      INSERT INTO attachment_folder_grants (id, sub_id, entity_type, entity_id, folder, granted_by, granted_at)
        VALUES ('afg-hand', 's-2', 'job', 'j-1', 'general', 11, '2026-01-02 03:04:05');
    `);
    const r = await put(ADMIN, { btIds: ['8002'], fields: ['status'] });
    expect([r.json.results[0].outcome, poRow('po-b').status, r.json.results[0].subAccess, r.json.counts.subAccess]).toEqual(['applied', 'work_complete', undefined, undefined]);
    expect(engine.db.prepare('SELECT id, granted_by, granted_at FROM attachment_folder_grants').all()).toEqual([{ id: 'afg-hand', granted_by: 11, granted_at: '2026-01-02 03:04:05' }]);
    expect(engine.db.prepare('SELECT id FROM job_subs').all()).toEqual([{ id: 'js-hand' }]);
    // Only the folder grant removed by hand: it is given again, and reported.
    engine.db.exec("DELETE FROM attachment_folder_grants");
    const back = await put(ADMIN, { btIds: ['8002'], fields: ['status'] });
    expect([back.json.results[0].outcome, back.json.results[0].subAccess]).toEqual(['unchanged', true]);
    expect(access()).toEqual(onJ1('s-2'));
  });

  test('the audit entry names every PO whose sub was given access, an unchanged one included', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const lastApply = () => log.mock.calls.filter((c) => c[0] === '[AUDIT]').map((c) => JSON.parse(c[1]))
        .filter((e) => e.action === 'buildertrend.apply').pop();
      await put(ADMIN, { btIds: ['8002'], fields: ['status'] });
      clearAccess();
      const r = await put(ADMIN, { btIds: ['8002'], fields: ['status'] });
      expect([r.json.results[0].outcome, r.json.results[0].subAccess]).toEqual(['unchanged', true]);
      const entry = lastApply();
      expect(entry.detail.counts.subAccess).toBe(1);
      expect(entry.detail.applied).toEqual([expect.objectContaining({ btId: '8002', p86Id: 'po-b', subAccess: true })]);
      // An unchanged PO that gave nobody access is still not listed.
      await put(ADMIN, { btIds: ['8002'], fields: ['status'] });
      expect(lastApply().detail.applied).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  test('another tenant\'s sub on an ACTIVE PO is refused by the grant itself', async () => {
    // po-h carries s-x (organization 2) on AGX's job. Made active, it reaches
    // the grant — and the grant's own sub-org check refuses it.
    setPo('po-h', { status: 'approved', is_locked: 1 });
    const r = await put(ADMIN, { btIds: ['8007'] });
    expect([r.json.results[0].outcome, poRow('po-h').bt_po_id]).toEqual(['applied', '8007']);
    expect(r.json.results[0].subAccess).toBeUndefined();
    expect(access()).toEqual(NONE);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toMatch(/sub s-x is not in org 1/);
  });

  test('a failed write grants nothing; the same PO grants once its write persists', async () => {
    txWatch.failCommit = 1;
    const failed = await put(ADMIN, { btIds: ['8001'] });
    expect([failed.json.results[0].outcome, failed.json.results[0].subAccess]).toEqual(['failed', undefined]);
    expect([poRow('po-a').status, poRow('po-a').sub_id, poRow('po-a').bt_po_id]).toEqual(['draft', null, null]);
    expect(access()).toEqual(NONE);
    const ok = await put(ADMIN, { btIds: ['8001'] });
    expect([ok.json.results[0].outcome, ok.json.results[0].subAccess]).toEqual(['applied', true]);
    expect(access()).toEqual(onJ1('s-1'));
  });

  test('a failed write on a PO that is ALREADY active with a sub of this organization grants nothing', async () => {
    // po-b is approved with s-2 before and after the refused commit, so only the
    // failure itself can keep the grant from running.
    txWatch.failCommit = 1;
    const failed = await put(ADMIN, { btIds: ['8002'], fields: ['status'] });
    expect([failed.json.results[0].outcome, failed.json.results[0].subAccess, failed.json.counts.subAccess]).toEqual(['failed', undefined, undefined]);
    expect([poRow('po-b').status, poRow('po-b').sub_id, poRow('po-b').bt_po_id]).toEqual(['approved', 's-2', null]);
    expect(access()).toEqual(NONE);
    const ok = await put(ADMIN, { btIds: ['8002'], fields: ['status'] });
    expect([ok.json.results[0].outcome, ok.json.results[0].subAccess]).toEqual(['applied', true]);
    expect(access()).toEqual(onJ1('s-2'));
  });

  test('the post-commit re-read is org-scoped: another tenant\'s PO id grants nothing, even with a sub of this organization', async () => {
    const { grantPoSubAccessAfterCommit } = require('../server/services/clickr/sync-apply');
    // po-x is on organization 2's job. Given s-1 (organization 1) and approved, only
    // the re-read's org predicate stops organization 1's grant from reaching j-b.
    setPo('po-x', { sub_id: 's-1', status: 'approved', is_locked: 1 });
    expect(await grantPoSubAccessAfterCommit(engine.pool, AGX, 'po-x', ADMIN)).toBe(false);
    expect(access()).toEqual(NONE);
    // The same call on this organization's own active PO does grant.
    expect(await grantPoSubAccessAfterCommit(engine.pool, AGX, 'po-b', ADMIN)).toBe(true);
    expect(access()).toEqual(onJ1('s-2'));
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
    // Created approved with a sub of this organization: that sub gets access.
    expect([r.json.results[0].subAccess, r.json.counts.subAccess]).toEqual([true, 1]);
    expect(access()).toEqual(onJ1('s-1'));
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
    // Only 8010 (approved, s-1) grants; the draft and the sub-less approved one do not.
    const by = Object.fromEntries(r.json.results.map((x) => [x.btId, x.subAccess]));
    expect([by['8010'], by['8011'], by['8016'], r.json.counts.subAccess]).toEqual([true, undefined, undefined, 1]);
    expect(access()).toEqual(onJ1('s-1'));
  });

  test('a create that does not commit grants nothing', async () => {
    txWatch.failCommit = 1;
    const r = await put(ADMIN, { mode: 'create', btIds: ['8010'] });
    expect([r.json.results[0].outcome, r.json.results[0].subAccess]).toEqual(['failed', undefined]);
    expect(poByBt('8010')).toHaveLength(0);
    expect(access()).toEqual(NONE);
  });
});

describe('LINK and GATES', () => {
  test('only the listed candidate links; another tenant\'s PO never does', async () => {
    expect((await put(ADMIN, { mode: 'link', btId: '8004', p86Id: 'po-e' })).json.counts.linked).toBe(0);
    expect((await put(ADMIN, { mode: 'link', btId: '8004', p86Id: 'po-x' })).json.counts.linked).toBe(0);
    expect((await put(ADMIN, { mode: 'link', btId: '8004', p86Id: 'po-d' })).json.counts.linked).toBe(1);
    expect(poRow('po-d').bt_po_id).toBe('8004');
    expect(poRow('po-x').bt_po_id).toBeNull();
    expect(access()).toEqual(NONE);
  });

  test('"Link to this one" on a PO already approved with a sub gives that sub access', async () => {
    setPo('po-d', { sub_id: 's-2', status: 'approved', is_locked: 1 });
    const r = await put(ADMIN, { mode: 'link', btId: '8004', p86Id: 'po-d' });
    expect([r.json.counts.linked, r.json.results[0].subAccess, r.json.counts.subAccess]).toEqual([1, true, 1]);
    expect(access()).toEqual(onJ1('s-2'));
  });

  test('linking a DRAFT PO with a sub grants nothing', async () => {
    setPo('po-d', { sub_id: 's-2' });
    const r = await put(ADMIN, { mode: 'link', btId: '8004', p86Id: 'po-d' });
    expect([r.json.counts.linked, r.json.results[0].subAccess]).toEqual([1, undefined]);
    expect(access()).toEqual(NONE);
  });

  test('a link that does not commit grants nothing', async () => {
    setPo('po-d', { sub_id: 's-2', status: 'approved', is_locked: 1 });
    txWatch.failCommit = 1;
    const r = await put(ADMIN, { mode: 'link', btId: '8004', p86Id: 'po-d' });
    expect([r.json.results[0].outcome, r.json.results[0].subAccess]).toEqual(['failed', undefined]);
    expect(poRow('po-d').bt_po_id).toBeNull();
    expect(access()).toEqual(NONE);
  });

  test('a PM is refused and nothing is written', async () => {
    expect((await put(PM, { mode: 'create' })).status).toBe(403);
    expect(poByBt('8010')).toHaveLength(0);
    expect(access()).toEqual(NONE);
  });
});

describe('PO PAGE — the same grant the sync now uses', () => {
  // The PO page's routes call the grant without awaiting it (it never blocks the
  // PO write), so wait for its rows — or its refusal — to land.
  async function settle(done) {
    for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setImmediate(r));
  }
  const fullRows = () => ({
    assigned: engine.db.prepare('SELECT job_id, sub_id, level, building_id, phase_id, contract_amt, billed_to_date, status, notes, organization_id FROM job_subs').all(),
    granted: engine.db.prepare('SELECT sub_id, entity_type, entity_id, folder, folder_id, granted_by FROM attachment_folder_grants').all(),
  });

  test('issuing a PO with a sub on the PO page writes exactly the rows a sync link of the same PO writes', async () => {
    expect((await call('PUT', '/api/purchase-orders/po-d', ADMIN, { sub_id: 's-2' })).status).toBe(200);
    await settle(() => false); // room for a (wrong) grant on a draft to land
    expect(access()).toEqual(NONE); // still a draft
    expect((await call('POST', '/api/purchase-orders/po-d/status', ADMIN, { status: 'issued' })).status).toBe(200);
    await settle(() => count('attachment_folder_grants') > 0);
    expect(access()).toEqual(onJ1('s-2'));
    const page = fullRows();

    seed();
    setPo('po-d', { sub_id: 's-2', status: 'issued', is_locked: 1 });
    const r = await put(ADMIN, { mode: 'link', btId: '8004', p86Id: 'po-d' });
    expect(r.json.results[0].subAccess).toBe(true);
    expect(fullRows()).toEqual(page);
  });

  test('the PO page refuses another tenant\'s sub at the grant, with the caller\'s org', async () => {
    // Seeded directly: this proves the grant's own refusal, not what a door does with a foreign sub id.
    setPo('po-e', { sub_id: 's-x' });
    expect((await call('POST', '/api/purchase-orders/po-e/status', ADMIN, { status: 'issued' })).status).toBe(200);
    await settle(() => refusals().length > 0);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toMatch(/sub s-x is not in org 1/);
    expect(access()).toEqual(NONE);
  });
});

describe('UNIT', () => {
  // One Buildertrend purchase order against one P86 purchase order, straight
  // through the matcher. Nothing here touches BT_POS, so the whole-set counts
  // the PREVIEW tests pin stay exactly as they are.
  const probe = (bt, p86) => poMatch.matchPurchaseOrders([Object.assign({ btId: '9001', jobId: '111', poNumber: '0099',
    title: 'Probe PO', statusText: 'Sub/Vendor Approved', workStatusText: 'Not Complete', cost: 700, subName: null,
    isDeleted: false, isRecalled: false, approvalUser: 'Catica Office', costCodes: [], estCompleteDate: null, jobName: 'Job 111' }, bt)], {
    jobs: [{ id: 'j-1', bt_job_id: '111', data: { jobNumber: 'RV2004', title: 'Citi Lakes' } }],
    poRows: [Object.assign({ id: 'po-probe', job_id: 'j-1', po_number: '0099', status: 'draft', is_locked: 0,
      data: JSON.stringify({ title: 'Probe PO', lines: [line(700)], baselineTotal: 700 }),
      bt_po_id: null, sub_id: null, sub_name: null, sub_access: null, billed: 0 }, p86)],
    subs: [] })[0];
  const statusItems = (r) => (r.heldBack || []).filter((h) => h.field === 'status');

  test('P1 — Buildertrend WORK COMPLETE agrees with a P86 closed purchase order, exactly as an approval does', () => {
    // The two are the same place. Nothing is corrected and nothing is held back.
    const done = probe({ workStatusText: 'Complete' }, { status: 'closed', is_locked: 1 });
    expect(done.bt.state86).toBe('work_complete');
    expect(done.corrections.map((c) => c.field)).not.toContain('status');
    expect(statusItems(done)).toEqual([]);
    // And the approval on its own, which the fixtures already cover, still agrees.
    const appr = probe({}, { status: 'closed', is_locked: 1 });
    expect(statusItems(appr)).toEqual([]);
    // Buildertrend genuinely behind is still called out — as BUILDERTREND behind.
    for (const [text, label] of [['Draft', 'Draft'], ['Sent to Sub/Vendor - Pending', 'Issued']]) {
      const behind = probe({ statusText: text }, { status: 'closed', is_locked: 1 });
      expect(statusItems(behind).map((h) => [h.bt, h.p86, h.applicable])).toEqual([[label, 'Closed', false]]);
      expect(statusItems(behind)[0].note).toMatch(/^Buildertrend is behind P86 here/);
    }
  });

  test('P3 — a RECALLED purchase order never proposes a forward status move, whatever P86 still has', () => {
    // The held-back item says a recall is never applied. A correction beside it
    // would BE that application — and a pre-ticked, money-flagged one at that.
    for (const status of ['draft', 'issued', 'approved', 'work_complete', 'closed']) {
      const r = probe({ isRecalled: true }, { status, is_locked: status === 'draft' ? 0 : 1, bt_po_id: '9001' });
      expect([status, r.rung]).toEqual([status, 'Buildertrend ID']);
      expect(r.corrections.map((c) => c.field)).not.toContain('status');
      // Exactly ONE status item, and it is the recall: never two Status rows.
      const st = statusItems(r);
      expect(st).toHaveLength(1);
      expect([st[0].bt, st[0].applicable]).toEqual(['Recalled', false]);
      expect(st[0].note).toMatch(/A recall is never applied/);
    }
  });

  test('Buildertrend statuses map forward-only onto P86\'s', () => {
    expect(poMatch.btPoState('Draft', 'Not Complete')).toBe('draft');
    expect(poMatch.btPoState('Sent to Sub/Vendor - Pending', 'Complete')).toBe('issued');
    expect(poMatch.btPoState('Approved - Assigned Internally', 'Not Complete')).toBe('approved');
    expect(poMatch.btPoState('Internally Approved', 'Complete')).toBe('work_complete');
    expect(poMatch.btPoState('Something new', '')).toBeNull();
  });
  test('P4 — the three Buildertrend approvals, and nothing else, carry a kind', () => {
    expect(poMatch.btApprovalKind('Sub/Vendor Approved')).toBe('sub');
    expect(poMatch.btApprovalKind('Internally Approved')).toBe('internal');
    expect(poMatch.btApprovalKind('Approved - Assigned Internally')).toBe('internal');
    for (const t of ['Draft', 'Sent to Sub/Vendor - Pending', '', null, 'Recalled']) expect(poMatch.btApprovalKind(t)).toBeNull();
    // Of the texts P86 knows, exactly the three approvals carry a kind.
    for (const t of ['Sub/Vendor Approved', 'Internally Approved', 'Approved - Assigned Internally', 'Draft', 'Sent to Sub/Vendor - Pending']) {
      expect(poMatch.btApprovalKind(t) != null).toBe(poMatch.btPoState(t, 'Not Complete') === 'approved');
    }
  });

  test('P4 — an unrecognised “Approved …” text says nothing about WHO approved it', () => {
    // btPoState keeps a broad fallback on purpose: Buildertrend's vocabulary is
    // not closed, and any approval still commits the purchase order. The KIND
    // must not follow it — the page prints it as a sentence about a person, so
    // guessing "internally" from a text that never said it is a false claim.
    for (const t of ['Approved', 'Approved - Assigned to Sub', 'Approved by Sub/Vendor', 'approvedX']) {
      expect(poMatch.btApprovalKind(t)).toBeNull();
      expect(poMatch.btPoState(t, 'Not Complete')).toBe('approved');
    }
    // With no kind to record, nothing is due — and nothing claims one.
    expect(poMatch.approvalKindDue({ statusText: 'Approved', workStatusText: 'Not Complete' }, { status: 'approved', data: {} })).toBe(false);
  });

  test('the matcher\'s portal-access statuses are the grant\'s own', () => {
    const { PO_ACTIVE_STATUS } = require('../server/services/po-sub-access');
    expect([...poMatch.SUB_ACCESS_STATUS].sort()).toEqual([...PO_ACTIVE_STATUS].sort());
    expect(PO_ACTIVE_STATUS.size).toBe(4);
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
    // The create copy says what the sync now does with a sent or approved PO's sub.
    expect(html).toContain('No bill is created. A sent or approved PO’s sub gets portal access to the job’s files, as on the PO page.');
    expect(html).not.toContain('no sub portal access is granted');
    T.setTab('jobs');
  });

  const pageData = (ds) => ({ generatedAt: new Date().toISOString(), elapsedMs: 1, organization: { name: 'AGX' }, p86: { jobs: 1, leads: 0 },
    datasets: { jobs: { key: 'jobs', rows: [] }, leads: { key: 'leads', rows: [] }, purchaseOrders: ds } });

  test('a linked, up-to-date PO whose sub has no access is counted on the safe button, named in its confirm, and given access', async () => {
    await put(ADMIN, { mode: 'safe' }); // links every confident PO; po-b (s-2) and po-c (s-1) grant
    T.resetPicks();
    T.setTab('purchaseOrders');
    T.setView('purchaseOrders', 'all');
    let ds = await poRows();
    expect(ds.rows.filter((r) => (r.class === 'matched' || r.class === 'conflict') && r.rung !== 'Buildertrend ID')).toHaveLength(0);
    expect(ds.rows.filter((r) => r.subAccessDue)).toHaveLength(0);
    expect(T.render(pageData(ds))).toMatch(/data-btp-apply-safe="1" disabled>Link confident matches \+ give subs portal access \(0\)/);

    // Access removed by hand, and another tenant's sub made active on po-h.
    clearAccess();
    setPo('po-h', { status: 'approved', is_locked: 1 });
    ds = await poRows();
    const r3 = byBt(ds, 8003);
    expect([r3.class, r3.rung, r3.subAccessDue]).toEqual(['matched', 'Buildertrend ID', true]);
    expect(r3.notes.join(' ')).toMatch(/no portal access to this job's files yet/);
    expect([byBt(ds, 8002).subAccessDue, byBt(ds, 8005).subAccessDue, byBt(ds, 8007).subAccessDue]).toEqual([true, false, false]);
    const html = T.render(pageData(ds));
    // 8003 has nothing to apply on its own row, but the safe button now reaches it.
    expect(html).toMatch(/data-btp-apply-safe="1">Link confident matches \+ give subs portal access \(2\)<\/button>/);
    expect(html).toContain('<span class="btp-tag is-linked">Linked</span>');
    // Every confident match is already linked: the confirm does not offer to link zero.
    expect(T.safeConfirmText('purchaseOrders', ds)).toBe('The sub of 2 sent or approved purchase orders gets portal access to the job’s files, as on the PO page — including where that access was removed by hand. ' +
      'Nothing is linked and no P86 status, money or other field changes.');

    const r = await put(ADMIN, { mode: 'safe' });
    expect(r.json.counts.subAccess).toBe(2);
    expect(r.json.results.filter((x) => x.subAccess).map((x) => [x.btId, x.outcome]).sort()).toEqual([['8002', 'unchanged'], ['8003', 'unchanged']]);
    expect(access()).toEqual(onJ1('s-1', 's-2'));
    expect(refusals().some((m) => /sub s-x is not in org 1/.test(m))).toBe(true);
    ds = await poRows();
    expect(ds.rows.filter((x) => x.subAccessDue)).toHaveLength(0);
    T.setTab('jobs');
  });

  test('P4 — a linked, up-to-date PO whose Buildertrend approval was never recorded keeps the safe press live', async () => {
    // A purchase order P86 already has approved raises no correction, so its row
    // shows a bare "Linked" tag. The safe press is the only thing that records
    // which Buildertrend approval it carries, so it has to reach such a row.
    await put(ADMIN, { mode: 'safe' });
    T.resetPicks();
    T.setTab('purchaseOrders');
    T.setView('purchaseOrders', 'all');
    let ds = await poRows();
    expect(ds.rows.filter((r) => r.approvalKindDue)).toHaveLength(0);
    expect(T.render(pageData(ds))).toMatch(/data-btp-apply-safe="1" disabled>Link confident matches \+ give subs portal access \(0\)/);

    // po-f as a purchase order synced BEFORE this rule: approved in P86 and
    // linked, with nothing stored about which Buildertrend approval it was.
    const d = poData('po-f');
    delete d.approvedInBuildertrend;
    setPo('po-f', { data: JSON.stringify(d) });
    ds = await poRows();
    expect(byBt(ds, 8005).approvalKindDue).toBe(true);
    expect(byBt(ds, 8005).corrections.map((c) => c.field)).not.toContain('status');
    const html = T.render(pageData(ds));
    expect(html).toMatch(/data-btp-apply-safe="1">Link confident matches \+ give subs portal access \(1\)</);
    expect(html).toContain('Records which Buildertrend approval 1 committed purchase order carries: the sub’s, or the builder’s own.');
    expect(T.safeConfirmText('purchaseOrders', ds)).toContain('Records which Buildertrend approval 1 committed purchase order carries');

    // Pressing it records the approval and the button falls quiet again.
    await put(ADMIN, { mode: 'safe' });
    expect(poData('po-f').approvedInBuildertrend).toEqual({ by: 'Catica Office', kind: 'internal' });
    expect(T.render(pageData(await poRows()))).toMatch(/data-btp-apply-safe="1" disabled>Link confident matches \+ give subs portal access \(0\)/);
    T.setTab('jobs');
  });

  test('the confirm dialogs say a sent or approved PO\'s sub gets portal access — on purchase orders only', async () => {
    const ds = await poRows();
    expect(T.createAllConfirmText('purchaseOrders', ds)).toContain('Where one has a P86 sub, that sub gets portal access to the job’s files, as on the PO page.');
    expect(T.safeConfirmText('purchaseOrders', ds)).toMatch(/The sub of 2 sent or approved purchase orders gets portal access to the job’s files, as on the PO page/);
    // Confident matches still to link: the confirm names them first.
    expect(T.safeConfirmText('purchaseOrders', ds)).toMatch(/^Link [1-9]\d* confident purchase order match(es)? to Buildertrend\? No P86 status, money or other field changes\. The sub of/);
    for (const key of ['jobs', 'leads', 'clients', 'changeOrders']) {
      const other = { key, rows: ds.rows };
      expect(T.createAllConfirmText(key, other)).not.toMatch(/portal access/);
      expect(T.safeConfirmText(key, other)).not.toMatch(/portal access/);
    }
  });

  test('P4 — the P86 side says which Buildertrend approval it was', async () => {
    const ds = await poRows();
    T.resetPicks();
    T.setTab('purchaseOrders');
    T.setView('purchaseOrders', 'all');
    const html = T.render(pageData(ds));
    expect(html).toContain('Approved in Buildertrend by the sub');
    expect(html).toContain('Approved in Buildertrend internally');
    expect(html).not.toMatch(/e-sign/i);
    T.setTab('jobs');
  });

  test('the result sentence names the POs whose sub was given access', () => {
    expect(T.applyResultText({ mode: 'link', counts: { linked: 1, subAccess: 1 }, results: [{ outcome: 'linked', subAccess: true }] }))
      .toMatch(/sub portal access granted on 1/);
    expect(T.applyResultText({ mode: 'rows', counts: { applied: 1 }, results: [{ outcome: 'applied' }] }))
      .not.toMatch(/portal access/);
  });

  test('the result sentence names what a press RECORDED, so “N updated” is never bare', () => {
    // Neither is a P86 field, so both leave fields at 0. Reported as a bare
    // "2 updated" they would read as two records changed with nothing to show.
    expect(T.applyResultText({ mode: 'safe', counts: { applied: 2, fields: 0, statusWord: 2 }, results: [] }))
      .toBe('2 updated · Buildertrend’s own word recorded on 2.');
    expect(T.applyResultText({ mode: 'safe', counts: { applied: 1, fields: 0, approvalKind: 1 }, results: [] }))
      .toBe('1 updated · which Buildertrend approval recorded on 1.');
    // Nothing recorded, nothing claimed.
    expect(T.applyResultText({ mode: 'rows', counts: { applied: 1, fields: 1 }, results: [] })).not.toMatch(/recorded on/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// CLOSE — Buildertrend approved + work Complete + PAID may OFFER P86 'closed'
// ══════════════════════════════════════════════════════════════════════════
//
// Closing a purchase order in P86 is the one write with no supported way back:
// edit, unlock, re-lock, addendum, delete and every status transition all refuse
// a closed purchase order, and a sync can never undo it either (RANK[bt] is
// always below RANK.closed, so the backwards item is not applicable). So the
// offer is held back, never a correction; on its OWN field key 'close', never
// 'status'; unticked by default; refused in safe mode and in an apply that names
// no fields; and its confirm says the word permanent.
describe('CLOSE — the offer', () => {
  // The isolated matcher probe: nothing here touches BT_POS, so every whole-set
  // count the PREVIEW tests pin stays exactly as it is. Same shape as the one
  // in describe('UNIT'), with Buildertrend's paid status added — it is the
  // field this whole feature turns on.
  const probe = (bt, p86) => poMatch.matchPurchaseOrders([Object.assign({ btId: '9001', jobId: '111', poNumber: '0099',
    title: 'Probe PO', statusText: 'Sub/Vendor Approved', workStatusText: 'Not Complete', paidStatusText: 'Not Paid',
    cost: 700, subName: null, amountPaid: 0,
    isDeleted: false, isRecalled: false, approvalUser: 'Catica Office', costCodes: [], estCompleteDate: null, jobName: 'Job 111' }, bt)], {
    jobs: [{ id: 'j-1', bt_job_id: '111', data: { jobNumber: 'RV2004', title: 'Citi Lakes' } }],
    poRows: [Object.assign({ id: 'po-probe', job_id: 'j-1', po_number: '0099', status: 'draft', is_locked: 0,
      data: JSON.stringify({ title: 'Probe PO', lines: [line(700)], baselineTotal: 700 }),
      bt_po_id: null, sub_id: null, sub_name: null, sub_access: null, billed: 0 }, p86)],
    subs: [] })[0];
  const closeOf = (r) => (r.heldBack || []).filter((h) => h.field === 'close');
  const PAID_DONE = { statusText: 'Sub/Vendor Approved', workStatusText: 'Complete', paidStatusText: 'Paid' };

  test('approved + Complete + Paid against a P86 approved purchase order OFFERS the close', () => {
    const r = probe(PAID_DONE, { status: 'approved', is_locked: 1 });
    const c = closeOf(r);
    expect(c).toHaveLength(1);
    expect([c[0].label, c[0].reason, c[0].applicable, c[0].value, c[0].p86Value, c[0].bt, c[0].p86])
      .toEqual(['Close', 'permanent', true, 'closed', 'approved', 'Closed', 'Approved']);
    // It is NOT a correction: a correction is ticked by default.
    expect(r.corrections.map((x) => x.field)).not.toContain('close');
    // The note is the whole agreement, in words.
    expect(c[0].note).toMatch(/cannot be edited, unlocked, revised by addendum or deleted/);
    expect(c[0].note).toMatch(/cost does not change/);
    expect(c[0].note).toMatch(/sub keeps portal access/);
    expect(c[0].note).toMatch(/drops off the Purchase orders hub/);
    // It must not claim P86 verified the payment.
    expect(c[0].note).toMatch(/creates no bills from Buildertrend/);
  });

  test('from work_complete it is the ONLY item, and the row still reads as a match', () => {
    const r = probe(PAID_DONE, { status: 'work_complete', is_locked: 1 });
    expect(r['class']).toBe('matched');
    expect(r.corrections).toEqual([]);
    expect(r.heldBack.map((h) => h.field)).toEqual(['close']);
    expect(closeOf(r)[0].p86Value).toBe('work_complete');
  });

  test('PARTIALLY PAID is refused — the exact-equality guard', () => {
    // textKey collapses 'Partially Paid' to 'partially paid'. .includes('paid')
    // and .endsWith('paid') would BOTH match it. This is the assertion that
    // stops either from being written.
    expect(closeOf(probe(Object.assign({}, PAID_DONE, { paidStatusText: 'Partially Paid' }), { status: 'approved', is_locked: 1 }))).toEqual([]);
    // And the offer really does fire on the same row when the word is Paid, so
    // this is not vacuous.
    expect(closeOf(probe(PAID_DONE, { status: 'approved', is_locked: 1 }))).toHaveLength(1);
  });

  test('NOT PAID, blank paid status, and work NOT complete are each refused on their own', () => {
    for (const bt of [
      Object.assign({}, PAID_DONE, { paidStatusText: 'Not Paid' }),
      Object.assign({}, PAID_DONE, { paidStatusText: '' }),
      Object.assign({}, PAID_DONE, { workStatusText: 'Not Complete' }),
      Object.assign({}, PAID_DONE, { statusText: 'Sent to Sub/Vendor - Pending' }),
      Object.assign({}, PAID_DONE, { statusText: 'Draft' }),
    ]) {
      expect([bt.statusText, bt.workStatusText, bt.paidStatusText, closeOf(probe(bt, { status: 'approved', is_locked: 1 })).length])
        .toEqual([bt.statusText, bt.workStatusText, bt.paidStatusText, 0]);
    }
  });

  test('a P86 purchase order BEHIND approved gets the forward correction and NO close', () => {
    // Below approved the sub never e-signed: approved_at and data.acceptance are
    // stamped only on the approved transition, and a close would freeze that for
    // ever with no route back. The person applies the status, refreshes, and the
    // close is offered next preview. Two presses, two refreshes.
    for (const status of ['draft', 'issued']) {
      const r = probe(PAID_DONE, { status, is_locked: status === 'draft' ? 0 : 1 });
      expect([status, closeOf(r).length]).toEqual([status, 0]);
      expect([status, r.corrections.some((c) => c.field === 'status')]).toEqual([status, true]);
    }
  });

  test('an ALREADY CLOSED purchase order is offered nothing, and its existing items are untouched', () => {
    const r = probe(PAID_DONE, { status: 'closed', is_locked: 1 });
    expect(closeOf(r)).toEqual([]);
    expect(r.corrections.map((c) => c.field)).not.toContain('status');
  });

  test('a RECALLED purchase order is never closed, however paid and complete Buildertrend says it is', () => {
    const r = probe(Object.assign({}, PAID_DONE, { isRecalled: true }), { status: 'approved', is_locked: 1, bt_po_id: '9001' });
    expect(closeOf(r)).toEqual([]);
    // The recall item is still the whole status story.
    expect(r.heldBack.filter((h) => h.field === 'status').map((h) => h.bt)).toEqual(['Recalled']);
  });

  test('a PENDING ADDENDUM blocks the close, and says why rather than going silent', () => {
    const withPending = { status: 'approved', is_locked: 1,
      data: JSON.stringify({ title: 'Probe PO', lines: [line(700)], baselineTotal: 700,
        addendums: [{ id: 'a1', seq: 1, delta: 100, status: 'pending' }] }) };
    const c = closeOf(probe(PAID_DONE, withPending));
    expect(c).toHaveLength(1);
    expect([c[0].applicable, c[0].reason]).toEqual([false, 'review']);
    expect(c[0].note).toMatch(/awaiting a signature/);
    // An APPROVED addendum does not block it. Baseline 700 + approved 100 = the
    // 800 the lines carry, which is the state the addendum route leaves behind.
    const approvedAdd = { status: 'approved', is_locked: 1,
      data: JSON.stringify({ title: 'Probe PO', lines: [line(800)], baselineTotal: 700,
        addendums: [{ id: 'a1', seq: 1, delta: 100, status: 'approved' }] }) };
    expect(closeOf(probe(PAID_DONE, approvedAdd))[0].applicable).toBe(true);
  });

  test('a purchase order UNLOCKED TO REVISE is refused the close, and told why', () => {
    // The row that made this necessary: P86 committed 700, someone unlocked it
    // and typed 1,750 into the lines. poTotal still returns the BASELINE, so the
    // preview's P86 total reads $700.00 against Buildertrend's $700.00 — a
    // perfect match with 1,050 of edited line value nowhere on the page. Closing
    // shuts every door back (edit, unlock, re-lock, addendum, delete), so the
    // money could never be recorded by anyone.
    const revising = { status: 'work_complete', is_locked: 0,
      data: JSON.stringify({ title: 'Probe PO', lines: [line(1750)], baselineTotal: 700, revising: true }) };
    const r = probe(PAID_DONE, revising);
    const c = closeOf(r);
    expect(c).toHaveLength(1);
    expect([c[0].applicable, c[0].reason]).toEqual([false, 'review']);
    expect(c[0].note).toMatch(/unlocked to revise/);
    expect(c[0].note).toMatch(/nobody has recorded/);
    expect(c[0].note).toMatch(/addendum/);
    // And the drift really is invisible on the row, which is the whole point.
    expect(poMatch.poTotal({ lines: [line(1750)], baselineTotal: 700, revising: true })).toBe(700);
  });

  test('a LOCKED purchase order whose lines drifted from its baseline is refused too', () => {
    // Reachable without `revising`: POST /purchase-orders/:id/status deletes
    // data.revising on any transition and never asks about the price, so
    // unlock -> edit -> "Mark work complete" leaves exactly this shape.
    const drifted = { status: 'work_complete', is_locked: 1,
      data: JSON.stringify({ title: 'Probe PO', lines: [line(1750)], baselineTotal: 700 }) };
    const c = closeOf(probe(PAID_DONE, drifted));
    expect([c.length, c[0].applicable, c[0].reason]).toEqual([1, false, 'review']);
    expect(c[0].note).toMatch(/no longer sum to its committed total/);
  });

  test('a BUILDERTREND cost addendum is NOT an unrecorded price change', () => {
    // withAddendum records Buildertrend's cost WITHOUT touching the lines, on
    // purpose. Counting it as drift would withhold the close on every purchase
    // order the sync has ever corrected — the one case where it IS recorded.
    const btAdd = { status: 'work_complete', is_locked: 1,
      data: JSON.stringify({ title: 'Probe PO', lines: [line(700)], baselineTotal: 700,
        addendums: [{ id: 'add_bt_1', seq: 1, delta: 100, status: 'approved', source: 'buildertrend' }] }) };
    expect(closeOf(probe(PAID_DONE, btAdd))[0].applicable).toBe(true);
    // A LEGACY purchase order with no frozen baseline has nothing to reconcile.
    const legacy = { status: 'work_complete', is_locked: 1,
      data: JSON.stringify({ title: 'Probe PO', lines: [line(1750)] }) };
    expect(closeOf(probe(PAID_DONE, legacy))[0].applicable).toBe(true);
  });

  test('unrecordedPriceChange, asked directly — the mutation check', () => {
    const u = poMatch.unrecordedPriceChange;
    expect(u({ lines: [line(700)], baselineTotal: 700 })).toBe(false);
    expect(u({ lines: [line(700)], baselineTotal: 700, revising: true })).toBe(true);
    expect(u({ lines: [line(1750)], baselineTotal: 700 })).toBe(true);
    expect(u({ lines: [line(700)] })).toBe(false);
    // Half a cent is the tolerance, as /relock uses.
    expect(u({ lines: [line(700.004)], baselineTotal: 700 })).toBe(false);
    expect(u({ lines: [line(700.01)], baselineTotal: 700 })).toBe(true);
  });

  test("btPoState is NEVER taught 'closed' — the guard against a later simplification", () => {
    // It is the shared mapper: the status correction, bt.state86 ("would be
    // created as") and createPurchaseOrder's initial status all read it.
    // Returning 'closed' would make the close a pre-ticked forward correction
    // and let a create mint a born-closed, undeletable purchase order.
    const texts = ['Draft', 'Sent to Sub/Vendor - Pending', 'Sub/Vendor Approved', 'Internally Approved',
      'Approved - Assigned Internally', 'Approved', 'Recalled', 'Closed', 'Paid', '', null];
    const works = ['Not Complete', 'Complete', 'Closed', '', null];
    const seen = new Set();
    for (const t of texts) for (const w of works) seen.add(String(poMatch.btPoState(t, w)));
    expect([...seen].sort()).toEqual(['approved', 'draft', 'issued', 'null', 'work_complete']);
    expect(poMatch.btPoState('Sub/Vendor Approved', 'Complete')).toBe('work_complete');
  });

  test('the whole-set preview: 8002 is approved + Complete and NOT paid, so it is offered no close', async () => {
    // Same approval, same work status; only the paid status differs. This is the
    // regression guard on the existing fixture set.
    const ds = await poRows();
    expect(byBt(ds, 8002).heldBack.map((h) => h.field)).not.toContain('close');
    // And no row anywhere carries 'close' as a CORRECTION.
    for (const r of ds.rows) expect((r.corrections || []).map((c) => c.field)).not.toContain('close');
  });
});

describe('CLOSE — applying it', () => {
  // Buildertrend records live for the length of ONE test, so every whole-set
  // count the other describes pin is untouched.
  async function withBt(recs, fn) {
    const n = BT_POS.length;
    BT_POS.push(...recs);
    preview.forgetFetch(AGX);
    try { return await fn(); } finally { BT_POS.length = n; preview.forgetFetch(AGX); }
  }
  const paidRec = (id, num, title, o) => poRec(id, 111, num, title, 'Sub/Vendor Approved', 700,
    Object.assign({ work: 'Complete', extra: { paidStatusText: 'Paid', paidStatus: 3, amountPaid: 700, amountRemaining: 0 } }, o || {}));
  function addPo(id, poNumber, status, extra) {
    engine.db.prepare('INSERT INTO job_purchase_orders (id, job_id, organization_id, owner_id, sub_id, status, po_number, data, is_locked) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, 'j-1', AGX, 10, (extra && extra.sub_id) || null, status, poNumber,
        JSON.stringify(Object.assign({ title: 'Settled work', lines: [line(700)], baselineTotal: 700 }, (extra && extra.data) || {})), 1);
  }

  test('NO fields named: the status stays put and nothing closes', async () => {
    addPo('po-k', '0017', 'work_complete');
    await withBt([paidRec(8017, '0017', 'Settled work')], async () => {
      await poRows();
      const r = await put(ADMIN, { btIds: ['8017'] });
      expect(r.status).toBe(200);
      // writable() with fields = null applies every CORRECTION; pickedHeldBack
      // returns [] the moment a fields list is absent. That is what makes close opt-in.
      expect(poRow('po-k').status).toBe('work_complete');
    });
  });

  test("fields: ['close'] closes it — locked, approved_at stamped, money and bills untouched", async () => {
    addPo('po-k', '0017', 'work_complete');
    const billsBefore = count('job_vendor_bills');
    await withBt([paidRec(8017, '0017', 'Settled work')], async () => {
      await poRows();
      const r = await put(ADMIN, { btIds: ['8017'], fields: ['close'] });
      expect(r.status).toBe(200);
      const row = poRow('po-k');
      expect(row.status).toBe('closed');
      expect(Boolean(row.is_locked)).toBe(true);
      // THE DEAD END: 'closed' had to be added to the approved_at CASE. The
      // status route stamps only on next === 'approved' and closed has no legal
      // transition out, so a NULL here could never be filled by anything again.
      expect(row.approved_at == null).toBe(false);
      // Closing costs nothing and earns nothing.
      expect(poMatch.poTotal(poData('po-k'))).toBe(700);
      expect(poData('po-k').addendums).toBeUndefined();
      expect(count('job_vendor_bills')).toBe(billsBefore);
      expect(r.json.results[0].fields.map((f) => [f.field, f.to])).toContainEqual(['close', 'closed']);
    });
  });

  test('a mid-revision purchase order is never closed, asked for by name or not', async () => {
    // Refused twice over. The matcher withholds the offer (applicable: false),
    // so pickedHeldBack never returns it; and applyPurchaseOrder re-asks the
    // same question against the LOCKED row, because the row it is handed was
    // read before the transaction began. That re-check reads the row AS READ:
    // the status block deletes data.revising when a ticked status correction
    // locks the purchase order, which would otherwise hide this exact state.
    engine.db.prepare('INSERT INTO job_purchase_orders (id, job_id, organization_id, owner_id, sub_id, status, po_number, data, is_locked) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('po-k', 'j-1', AGX, 10, null, 'work_complete', '0017',
        JSON.stringify({ title: 'Settled work', lines: [line(1750)], baselineTotal: 700, revising: true }), 0);
    await withBt([paidRec(8017, '0017', 'Settled work')], async () => {
      const ds = await poRows();
      const row = byBt(ds, '8017');
      expect((row.heldBack || []).filter((h) => h.field === 'close').map((h) => h.applicable)).toEqual([false]);
      const r = await put(ADMIN, { btIds: ['8017'], fields: ['close'] });
      expect(r.status).toBe(200);
      expect(poRow('po-k').status).toBe('work_complete');
      expect((r.json.results[0].fields || []).map((f) => f.field)).not.toContain('close');
      // The revision itself is untouched, so it can still be settled.
      expect(poData('po-k').revising).toBe(true);
    });
    // The apply-side re-check is the race guard for the window between the read
    // that built this row and the SELECT … FOR UPDATE inside the transaction.
    // It reads the row as read, never the mutated local, and it refuses.
    const SA = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'services', 'clickr', 'sync-apply.js'), 'utf8');
    expect(SA).toMatch(/const unrecordedPriceChange = poMatch\.unrecordedPriceChange\(data\);/);
    expect(SA).toMatch(/\} else if \(unrecordedPriceChange\) \{\r?\n\s*stale\.push\('Close — this purchase order is unlocked to revise/);
  });

  test('ONE ROW AT A TIME: a close naming many purchase orders is refused outright', async () => {
    // pickedHeldBack keeps the close out of safe mode and out of a fields-less
    // "apply everything" press. It does not stop one request from naming 200
    // ids beside fields: ['close'], which would close every one of them
    // permanently under a single capability check and no confirm.
    addPo('po-k', '0017', 'work_complete');
    addPo('po-l', '0021', 'work_complete');
    await withBt([paidRec(8017, '0017', 'Settled work'), paidRec(8021, '0021', 'Other work')], async () => {
      await poRows();
      const r = await put(ADMIN, { btIds: ['8017', '8021'], fields: ['close'] });
      expect(r.status).toBe(400);
      expect(r.json.error).toMatch(/one row at a time/);
      expect([poRow('po-k').status, poRow('po-l').status]).toEqual(['work_complete', 'work_complete']);
      // Not vacuous: the SAME ids, one at a time, really do close.
      expect((await put(ADMIN, { btIds: ['8017'], fields: ['close'] })).status).toBe(200);
      expect(poRow('po-k').status).toBe('closed');
      // A many-row apply that does NOT name close is untouched.
      expect((await put(ADMIN, { btIds: ['8021'], fields: ['title'] })).status).toBe(200);
    });
  });

  test('SAFE MODE never closes, even on a row that is offered it', async () => {
    addPo('po-k', '0017', 'work_complete');
    await withBt([paidRec(8017, '0017', 'Settled work')], async () => {
      const r = await put(ADMIN, { mode: 'safe' });
      expect(r.status).toBe(200);
      expect(poRow('po-k').status).toBe('work_complete');
      // It DID link it, so this is not "safe mode did nothing".
      expect(poRow('po-k').bt_po_id).toBe('8017');
    });
  });

  test('PARTIALLY PAID refuses the close even when it is asked for by name', async () => {
    addPo('po-k', '0017', 'work_complete');
    await withBt([paidRec(8017, '0017', 'Settled work', { extra: { paidStatusText: 'Partially Paid', amountPaid: 300, amountRemaining: 400 } })], async () => {
      await poRows();
      const r = await put(ADMIN, { btIds: ['8017'], fields: ['close'] });
      expect(poRow('po-k').status).toBe('work_complete');
      expect((r.json.results[0].fields || []).map((f) => f.field)).not.toContain('close');
    });
  });

  test('ORDERING — a ticked status correction and a ticked close COMPOSE, and the close wins', async () => {
    // The held-back loop runs BEFORE the status block. Resolving the close there
    // would let approved -> work_complete overwrite 'closed' back down, in the
    // same transaction, while the applied list reported both.
    addPo('po-k', '0017', 'approved');
    await withBt([paidRec(8017, '0017', 'Settled work')], async () => {
      await poRows();
      const r = await put(ADMIN, { btIds: ['8017'], fields: ['status', 'close'] });
      expect(poRow('po-k').status).toBe('closed');
      const got = r.json.results[0].fields.map((f) => [f.field, f.to]);
      expect(got).toContainEqual(['status', 'work_complete']);
      expect(got).toContainEqual(['close', 'closed']);
      // …and the order is status first, close last.
      expect(got.findIndex((g) => g[0] === 'close')).toBeGreaterThan(got.findIndex((g) => g[0] === 'status'));
    });
  });

  test('close ALONE from approved skips the rung, and still stamps approved_at', async () => {
    addPo('po-k', '0017', 'approved');
    await withBt([paidRec(8017, '0017', 'Settled work')], async () => {
      await poRows();
      await put(ADMIN, { btIds: ['8017'], fields: ['close'] });
      expect(poRow('po-k').status).toBe('closed');
      expect(poRow('po-k').approved_at == null).toBe(false);
    });
  });

  // TWO GATES. The apply door re-reads Buildertrend and re-matches P86 from
  // scratch before it writes anything, so a purchase order whose P86 side moved
  // since the preview is no longer OFFERED the close at all — that is the first
  // gate, and it is the one these two drives exercise. sync-apply then
  // re-checks the item against the row it holds under FOR UPDATE (a second
  // gate, for a write that lands between the match and the transaction), which
  // is why the assertion below is about the ROW and not about a message.
  test('FORGED — close named on a purchase order P86 has moved back to issued does not close it', async () => {
    addPo('po-k', '0017', 'work_complete');
    await withBt([paidRec(8017, '0017', 'Settled work')], async () => {
      await poRows();
      setPo('po-k', { status: 'issued' });
      const r = await put(ADMIN, { btIds: ['8017'], fields: ['close'] });
      expect(poRow('po-k').status).toBe('issued');
      expect((r.json.results[0].fields || []).map((f) => f.field)).not.toContain('close');
    });
  });

  test('FORGED — close named on a purchase order that gained a pending addendum does not close it', async () => {
    addPo('po-k', '0017', 'work_complete');
    await withBt([paidRec(8017, '0017', 'Settled work')], async () => {
      await poRows();
      setPo('po-k', { data: JSON.stringify({ title: 'Settled work', lines: [line(700)], baselineTotal: 700,
        addendums: [{ id: 'a1', seq: 1, delta: 50, status: 'pending' }] }) });
      const r = await put(ADMIN, { btIds: ['8017'], fields: ['close'] });
      expect(poRow('po-k').status).toBe('work_complete');
      expect((r.json.results[0].fields || []).map((f) => f.field)).not.toContain('close');
    });
  });

  test('the request cannot smuggle a close past pickedHeldBack', async () => {
    // pickedHeldBack is the gate between "the person ticked a box" and "the
    // writer sees an item". It is exported, so it is asked directly with the
    // three shapes a forged request would take.
    const sa = require('../server/services/clickr/sync-apply');
    const offered = { heldBack: [{ field: 'close', applicable: true }] };
    const blocked = { heldBack: [{ field: 'close', applicable: false }] };
    // Ticked, in rows mode, on an applicable item: the ONLY way through.
    expect(sa.pickedHeldBack('purchaseOrders', offered, 'rows', ['close'])).toHaveLength(1);
    // Safe mode, no fields list at all, and a not-applicable item: none.
    expect(sa.pickedHeldBack('purchaseOrders', offered, 'safe', ['close'])).toEqual([]);
    expect(sa.pickedHeldBack('purchaseOrders', offered, 'rows', null)).toEqual([]);
    expect(sa.pickedHeldBack('purchaseOrders', offered, 'rows', ['cost'])).toEqual([]);
    expect(sa.pickedHeldBack('purchaseOrders', blocked, 'rows', ['close'])).toEqual([]);
    // And 'close' is NOT in PO_FIELDS, so writable() can never apply it as an
    // ordinary correction either.
    expect(sa.writable('purchaseOrders', { corrections: [{ field: 'close', value: 'closed' }] }, 'rows', ['close'])).toEqual([]);
  });

  test('the sub keeps portal access after a close, and a second close is refused', async () => {
    addPo('po-k', '0017', 'work_complete', { sub_id: 's-1' });
    await withBt([paidRec(8017, '0017', 'Settled work')], async () => {
      await poRows();
      await put(ADMIN, { btIds: ['8017'], fields: ['close'] });
      expect(poRow('po-k').status).toBe('closed');
      expect(access()).toEqual(onJ1('s-1'));

      const again = await poRows();
      // The row now shows the ordinary backwards held-back, never a close.
      expect(byBt(again, 8017).heldBack.map((h) => h.field)).not.toContain('close');
      const r2 = await put(ADMIN, { btIds: ['8017'], fields: ['close'] });
      expect(['unchanged', 'applied']).toContain(r2.json.results[0].outcome);
      expect(poRow('po-k').status).toBe('closed');
    });
  });
});

describe('CLOSE — the page', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const vm2 = require('vm');
  const src2 = fs2.readFileSync(path2.join(__dirname, '..', 'js', 'bt-sync-preview.js'), 'utf8');
  const win2 = {};
  vm2.runInNewContext(src2, { window: win2, document: {}, console });
  const T2 = win2.p86BtSyncPreview._test;
  const pageData = (ds) => ({ generatedAt: new Date().toISOString(), elapsedMs: 1, organization: { name: 'AGX' }, p86: { jobs: 1, leads: 0 },
    datasets: { jobs: { key: 'jobs', rows: [] }, leads: { key: 'leads', rows: [] }, purchaseOrders: ds } });

  async function withBt(recs, fn) {
    const n = BT_POS.length;
    BT_POS.push(...recs);
    preview.forgetFetch(AGX);
    try { return await fn(); } finally { BT_POS.length = n; preview.forgetFetch(AGX); }
  }
  const paidRec = (id, num, title, o) => poRec(id, 111, num, title, 'Sub/Vendor Approved', 700,
    Object.assign({ work: 'Complete', extra: { paidStatusText: 'Paid', paidStatus: 3, amountPaid: 700, amountRemaining: 0 } }, o || {}));

  test('the close box is rendered, UNTICKED, and Buildertrend\'s paid status is on the page', async () => {
    engine.db.prepare('INSERT INTO job_purchase_orders (id, job_id, organization_id, owner_id, sub_id, status, po_number, data, is_locked) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('po-k', 'j-1', AGX, 10, null, 'work_complete', '0017', JSON.stringify({ title: 'Settled work', lines: [line(700)], baselineTotal: 700 }), 1);
    await withBt([paidRec(8017, '0017', 'Settled work')], async () => {
      const ds = await poRows();
      T2.resetPicks();
      T2.setTab('purchaseOrders');
      T2.setView('purchaseOrders', 'all');
      const html = T2.render(pageData(ds));
      // Same shape the addendum box is asserted with: present, and NOT checked.
      expect(html).toMatch(/data-btp-pick="close" data-btp-row="8017"(?! checked)/);
      // The person is being asked to act on "Paid" — so the page shows it.
      expect(html).toContain('Paid: Paid');
      expect(html).toContain('<span class="btp-tag is-permanent">permanent</span>');
      T2.setTab('jobs');
    });
  });

  test('a Partially Paid row gets no close box at all', async () => {
    engine.db.prepare('INSERT INTO job_purchase_orders (id, job_id, organization_id, owner_id, sub_id, status, po_number, data, is_locked) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('po-k', 'j-1', AGX, 10, null, 'work_complete', '0017', JSON.stringify({ title: 'Settled work', lines: [line(700)], baselineTotal: 700 }), 1);
    await withBt([paidRec(8017, '0017', 'Settled work', { extra: { paidStatusText: 'Partially Paid', amountPaid: 300, amountRemaining: 400 } })], async () => {
      const ds = await poRows();
      T2.resetPicks();
      T2.setTab('purchaseOrders');
      T2.setView('purchaseOrders', 'all');
      const html = T2.render(pageData(ds));
      expect(html).not.toContain('data-btp-pick="close"');
      expect(html).toContain('Paid: Partially Paid');
      T2.setTab('jobs');
    });
  });

  test('the close confirm, asked directly: it says PERMANENT and what can never be done again', () => {
    const row = { corrections: [], heldBack: [{ field: 'close', label: 'Close', reason: 'permanent', applicable: true, value: 'closed', bt: 'Closed' }] };
    const ask = T2.rowConfirm('purchaseOrders', row, ['close']);
    expect(ask).not.toBeNull();
    expect(ask.danger).toBe(true);
    expect(ask.label).toBe('Close it permanently');
    expect(ask.message).toMatch(/This is PERMANENT/);
    expect(ask.message).toMatch(/cannot be edited, unlocked, revised by addendum or deleted/);
    expect(ask.message).toMatch(/drops off the Purchase orders hub/);
    expect(ask.message).toMatch(/cost does not change/);
    expect(ask.message).toMatch(/sub keeps portal access/);
  });

  test('CLOSING takes precedence over the money sentence, and close is never named in both', () => {
    const row = { corrections: [{ field: 'status', label: 'Status', money: true, from: 'Approved', to: 'Work complete' }],
      heldBack: [{ field: 'close', label: 'Close', reason: 'permanent', applicable: true, bt: 'Closed' }] };
    const ask = T2.rowConfirm('purchaseOrders', row, ['status', 'close']);
    expect(ask.danger).toBe(true);
    expect(ask.message).toMatch(/This is PERMANENT/);
    // The money move is still named, once, as a rider.
    expect(ask.message).toMatch(/The same press FIRST applies Status → Work complete/);
    expect((ask.message.match(/Close/g) || []).length).toBeGreaterThan(0);
    expect(ask.message).not.toMatch(/Close → Closed/);
  });

  test('with a COST ticked beside it, the confirm never says the cost does not change', () => {
    // The reassurance is true of closing ALONE. With a cost addendum in the same
    // press the cost really does move — and is then frozen for ever — so the
    // sentence that would contradict the rider two clauses later is dropped.
    const row = { corrections: [],
      heldBack: [{ field: 'cost', label: 'Cost', reason: 'money', applicable: true, bt: '$8,000.00', p86: '$7,000.00' },
        { field: 'close', label: 'Close', reason: 'permanent', applicable: true, bt: 'Closed' }] };
    const ask = T2.rowConfirm('purchaseOrders', row, ['cost', 'close']);
    expect(ask.danger).toBe(true);
    expect(ask.message).toMatch(/This is PERMANENT/);
    expect(ask.message).not.toMatch(/cost does not change/);
    expect(ask.message).toMatch(/FIRST applies Cost → \$8,000\.00/);
    expect(ask.message).toMatch(/frozen for ever/);
    // Close alone still carries the reassurance, so this is not a blanket removal.
    const alone = T2.rowConfirm('purchaseOrders',
      { corrections: [], heldBack: [{ field: 'close', label: 'Close', reason: 'permanent', applicable: true, bt: 'Closed' }] }, ['close']);
    expect(alone.message).toMatch(/cost does not change/);
  });

  test('an ordinary money press is unchanged, and a press with nothing at stake asks nothing', () => {
    const moneyRow = { corrections: [{ field: 'cost', label: 'Cost', money: true, from: '$1', to: '$2' }], heldBack: [] };
    const ask = T2.rowConfirm('purchaseOrders', moneyRow, ['cost']);
    expect([ask.danger, ask.label]).toEqual([false, 'Apply']);
    expect(ask.message).toBe('Apply Cost → $2 to this purchase order?');
    expect(T2.rowConfirm('purchaseOrders', { corrections: [{ field: 'title', label: 'Title', to: 'x' }], heldBack: [] }, ['title'])).toBeNull();
  });

  test('askThen carries the danger flag through, and its other callers still get a plain dialog', () => {
    const src = fs2.readFileSync(path2.join(__dirname, '..', 'js', 'bt-sync-preview.js'), 'utf8');
    expect(src).toMatch(/function askThen\(message, label, fn, danger\)/);
    expect(src).toMatch(/danger: !!danger, destructive: !!danger/);
    // Every other call site passes three arguments -> undefined -> false.
    const threeArg = src.match(/askThen\([^;]*?\);/g) || [];
    expect(threeArg.length).toBeGreaterThan(1);
    expect(src).toMatch(/askThen\(ask\.message, ask\.label, go, ask\.danger\)/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PHASE 0 — the two doors that had to be fixed BEFORE the offer could ship
// ══════════════════════════════════════════════════════════════════════════
describe("P86's own Close door", () => {
  const fs3 = require('fs');
  const path3 = require('path');
  const SRC = fs3.readFileSync(path3.join(__dirname, '..', 'js', 'purchase-order-editor.js'), 'utf8');

  // The shipped expression, lifted and evaluated with its free variables
  // injected — so a change to it changes what this test runs.
  const m = SRC.match(/var canStep = ([^;]+);/);
  const canStep = (st, step, locked) => {
    expect(m).not.toBeNull();
    // eslint-disable-next-line no-new-func
    return new Function('st', 'step', 'locked', 'return (' + m[1] + ');')(st, step, locked);
  };

  test('the old step-and-not-locked gate is gone', () => {
    // Every purchase order past draft is locked, so that gate made Close PO —
    // the only forward step a work_complete purchase order has — unpressable,
    // and left work_complete a dead end inside P86 entirely.
    expect(SRC).not.toMatch(/step && !locked \?/);
    expect(SRC).toMatch(/\(canStep \?/);
  });

  test('a LOCKED work_complete purchase order can still be closed in P86', () => {
    expect(canStep('work_complete', { to: 'closed', label: 'Close PO' }, true)).toBe(true);
  });

  test('closing from the PO editor says PERMANENT, in a danger dialog', () => {
    // The door Phase 0.1 opened routed every non-approval step through one
    // generic gate: "Confirm / Move this PO to \"Closed\"? / Continue" — the same
    // words as the fully reversible Issue and Mark work complete steps, for the
    // one write with no undo anywhere in P86.
    expect(SRC).toMatch(/var CLOSE_WARNING = /);
    const w = SRC.match(/var CLOSE_WARNING = ([\s\S]*?);\r?\n/);
    expect(w).not.toBeNull();
    // eslint-disable-next-line no-new-func
    const text = new Function('return (' + w[1] + ');')();
    expect(text).toMatch(/This is PERMANENT/);
    expect(text).toMatch(/cannot be edited, unlocked, revised by addendum or deleted/);
    expect(text).toMatch(/drops off the Purchase orders hub/);
    // It is wired to the closed step only, and carries the danger flag.
    expect(SRC).toMatch(/step\.to === 'closed'/);
    expect(SRC).toMatch(/askYesNo\(CLOSE_WARNING, \{ title: [^}]*label: 'Close it permanently', danger: true \}\)/);
    expect(SRC).toMatch(/danger: !!opts\.danger, destructive: !!opts\.danger/);
    // The two ordinary steps still get the plain dialog: askYesNo's 2nd
    // parameter arrives undefined for them.
    expect(SRC).toMatch(/askYesNo\('Move this PO to "' \+ \(STATUS_LABEL\[step\.to\] \|\| step\.to\) \+ '"\?'\)/);
  });

  test('every other locked status keeps its read-only step button, and closed has no step', () => {
    expect(canStep('approved', { to: 'work_complete', label: 'x' }, true)).toBe(false);
    expect(canStep('issued', { to: 'approved', label: 'x' }, true)).toBe(false);
    expect(canStep('draft', { to: 'issued', label: 'x' }, false)).toBe(true);
    expect(canStep('closed', undefined, true)).toBeFalsy();
  });
});

describe('the addendum route refuses a CLOSED purchase order', () => {
  test('approving a pre-existing pending addendum on a closed purchase order is 409, and the money does not move', async () => {
    // Path (a) of the route. It was the ONLY purchase-order write door with no
    // closed check — it did not even SELECT the status — and it RAISES a closed
    // purchase order's committed total.
    setPo('po-g', { data: JSON.stringify({ title: 'Closed PO', lines: [line(500)], baselineTotal: 500,
      addendums: [{ id: 'add-1', seq: 1, delta: 250, status: 'pending' }] }) });
    const before = poMatch.poTotal(poData('po-g'));
    const r = await call('POST', '/api/purchase-orders/po-g/addendum', ADMIN, { addendumId: 'add-1', approve: true });
    expect(r.status).toBe(409);
    expect(String(r.json.error)).toMatch(/closed purchase order/);
    expect(poData('po-g').addendums[0].status).toBe('pending');
    expect(poMatch.poTotal(poData('po-g'))).toBe(before);
  });

  test('THE MUTATION — the same call on an OPEN purchase order still works', async () => {
    // Not vacuous: without this the 409 above could be coming from anywhere.
    setPo('po-c', { data: JSON.stringify({ title: 'Roofing', lines: [line(2000)], baselineTotal: 2000,
      addendums: [{ id: 'add-2', seq: 1, delta: 250, status: 'pending' }] }) });
    const r = await call('POST', '/api/purchase-orders/po-c/addendum', ADMIN, { addendumId: 'add-2', approve: true });
    expect(r.status).toBe(200);
    expect(poData('po-c').addendums[0].status).toBe('approved');
    expect(poMatch.poTotal(poData('po-c'))).toBe(2250);
  });
});
