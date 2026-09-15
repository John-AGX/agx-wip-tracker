// PUT /api/purchase-orders/:id proves a caller-supplied sub_id is in the
// caller's organization BEFORE it writes, as the create door already did.
//
// The portal-access grant (services/po-sub-access.js) refuses a foreign sub, so
// there was never a read channel — but the PO itself still saved pointing at
// another tenant's sub: that sub's name on the PO, and sub cost attributed to it.
// A foreign sub is now answered 404 and nothing on the PO changes. Clearing the
// sub (null or '') needs no proof and still saves; a LOCKED PO ignores sub_id
// entirely, so a save that carries one is not refused.
//
// Driven through the real express router, requireAuth / ESTIMATES_EDIT, a JWT,
// and the pg-sqlite engine derived from server/db.js.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema, tableNames } = require('./helpers/db-schema');

const engine = createPgSqlite(
  sqliteSchema(tableNames(), { pk: { organizations: 'id', users: 'id', roles: 'name', jobs: 'id', job_purchase_orders: 'id', subs: 'id' } }),
  { jsonColumns: ['data'] }
);
// The constraints the portal grant's ON CONFLICT arms name (server/db.js) — the
// locked, approved PO below reaches that grant after its save.
engine.db.exec(`
  CREATE UNIQUE INDEX idx_job_subs_unique_v2 ON job_subs(job_id, sub_id);
  CREATE UNIQUE INDEX idx_afg_unique ON attachment_folder_grants(sub_id, entity_type, entity_id, folder);
`);

globalThis.__P86_PO_SUB_SCOPE_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_PO_SUB_SCOPE_ENGINE__.pool }));
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const poRoutes = require('../server/routes/purchase-order-routes');

const AGX = 1;
const OTHER = 2;
const ADMIN = { id: 10, email: 'admin@agx.test', name: 'Ana Ruiz', role: 'admin', organization_id: AGX };
const DRAFT = { title: 'Exterior paint labor', lines: [{ description: 'x', qty: 1, unitCost: 5000 }] };

function seed() {
  engine.db.exec(`
    DELETE FROM jobs; DELETE FROM users; DELETE FROM roles; DELETE FROM organizations; DELETE FROM subs;
    DELETE FROM job_purchase_orders; DELETE FROM job_subs; DELETE FROM attachment_folder_grants;
    INSERT INTO organizations (id, slug, name) VALUES (1, 'agx', 'AGX Central Florida'), (2, 'other', 'Other Builders');
    INSERT INTO roles (name, label, capabilities) VALUES ('admin', 'Admin', '["JOBS_VIEW_ALL","ESTIMATES_EDIT"]');
    INSERT INTO users (id, email, password_hash, name, role, organization_id, active) VALUES
      (10, 'admin@agx.test', 'x', 'Ana Ruiz', 'admin', 1, 1),
      (20, 'admin@other.test', 'x', 'Oscar Other', 'admin', 2, 1);
    INSERT INTO subs (id, name, organization_id, status) VALUES
      ('s-1', 'Catica International Inc', 1, 'active'),
      ('s-2', 'Five Star Remodeling & Cleaning LLC', 1, 'active'),
      ('s-x', 'Other Tenant Sub', 2, 'active');
  `);
  engine.db.prepare('INSERT INTO jobs (id, owner_id, organization_id, data) VALUES (?,?,?,?)')
    .run('j-1', 10, AGX, JSON.stringify({ jobNumber: 'RV2004', title: 'Citi Lakes' }));
  const po = engine.db.prepare(`INSERT INTO job_purchase_orders
    (id, job_id, organization_id, owner_id, sub_id, status, po_number, data, is_locked, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?, '2026-01-02 03:04:05')`);
  po.run('po-a', 'j-1', AGX, 10, 's-1', 'draft', '0001', JSON.stringify(DRAFT), 0);
  po.run('po-l', 'j-1', AGX, 10, 's-2', 'approved', '0002', JSON.stringify(Object.assign({}, DRAFT, { baselineTotal: 5000 })), 1);
}

const poRow = (id) => {
  const r = engine.db.prepare('SELECT sub_id, data, updated_at FROM job_purchase_orders WHERE id = ?').get(id);
  return { sub_id: r.sub_id, data: JSON.parse(r.data), updated_at: r.updated_at };
};

let server;
let baseUrl;

function put(id, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(baseUrl + '/api/purchase-orders/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: 'Bearer ' + signToken(ADMIN) },
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

beforeAll(async () => {
  seed();
  setRolePool(engine.pool);
  await refreshRoleCache();
  const app = express();
  app.use(express.json());
  app.use('/api', poRoutes);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  engine.close();
});
beforeEach(async () => {
  seed();
  await refreshRoleCache();
});

describe('PUT /purchase-orders/:id — the sub_id is proved at the door', () => {
  test('a sub of this organization saves, with the rest of the body', async () => {
    const r = await put('po-a', { sub_id: 's-2', title: 'Renamed' });
    expect(r.status).toBe(200);
    expect(r.json.purchase_order.sub_id).toBe('s-2');
    expect([poRow('po-a').sub_id, poRow('po-a').data.title]).toEqual(['s-2', 'Renamed']);
  });

  test('another organization\'s sub is refused with 404 and the PO is unchanged', async () => {
    const before = poRow('po-a');
    const r = await put('po-a', { sub_id: 's-x', title: 'Renamed' });
    expect([r.status, r.json]).toEqual([404, { error: 'Subcontractor not found' }]);
    // Not the sub, not the title that rode along, not the timestamp.
    expect(poRow('po-a')).toEqual(before);
    expect(before.sub_id).toBe('s-1');
  });

  test('a sub id that exists nowhere is refused the same way', async () => {
    const before = poRow('po-a');
    const r = await put('po-a', { sub_id: 's-nope' });
    expect([r.status, r.json]).toEqual([404, { error: 'Subcontractor not found' }]);
    expect(poRow('po-a')).toEqual(before);
  });

  test('clearing the sub needs no proof — null and \'\' both save', async () => {
    const r = await put('po-a', { sub_id: null });
    expect([r.status, r.json.purchase_order.sub_id, poRow('po-a').sub_id]).toEqual([200, null, null]);
    engine.db.prepare("UPDATE job_purchase_orders SET sub_id = 's-1' WHERE id = 'po-a'").run();
    const blank = await put('po-a', { sub_id: '' });
    expect([blank.status, poRow('po-a').sub_id]).toEqual([200, null]);
  });

  test('a save that omits sub_id leaves the sub alone', async () => {
    const r = await put('po-a', { title: 'Renamed' });
    expect([r.status, poRow('po-a').sub_id, poRow('po-a').data.title]).toEqual([200, 's-1', 'Renamed']);
  });

  test('a LOCKED PO ignores sub_id, so a notes save carrying one is not refused and the sub stays', async () => {
    const r = await put('po-l', { sub_id: 's-x', internalNotes: 'called the sub' });
    expect(r.status).toBe(200);
    expect([poRow('po-l').sub_id, poRow('po-l').data.internalNotes]).toEqual(['s-2', 'called the sub']);
    // The route fires the grant without awaiting it: let it land, and it is for
    // the PO's own sub — never the one in the body.
    const granted = () => engine.db.prepare('SELECT sub_id FROM attachment_folder_grants').all().map((g) => g.sub_id);
    for (let i = 0; i < 200 && granted().length === 0; i++) await new Promise((res) => setImmediate(res));
    expect(granted()).toEqual(['s-2']);
  });
});
