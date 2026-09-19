// POST /api/clients/merge — fold one client into another.
//
// WHY THIS FILE EXISTS
// The directory's "Merge Client" told the user "Children, linked leads, and
// estimates of the source are reparented to the survivor. The source row is
// then deleted." Only the first clause and the last were true. js/clients.js
// PUT a blank-fill patch, PUT parent_client_id on each child, then DELETE'd —
// and the DELETE nulled every lead and project (FK ON DELETE SET NULL) and
// left jobs, invoices, payments and estimates holding the id of a row that no
// longer existed. The estimate ALSO kept a frozen display string naming the
// deleted client, so the folded name printed on proposals for ever.
//
// So the assertions here read the DATABASE ROW, never the response body
// alone: the old code would have returned a perfectly cheerful success for
// every one of those losses.
//
// Real express router, requireAuth / requireCapability, a JWT, and the
// pg-sqlite engine with every table derived from server/db.js.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema, tableNames, tableColumns } = require('./helpers/db-schema');

const engine = createPgSqlite(
  sqliteSchema(tableNames(), { pk: { organizations: 'id', users: 'id', roles: 'name', jobs: 'id', leads: 'id', clients: 'id', estimates: 'id' } }),
  { jsonColumns: ['data'] }
);
globalThis.__P86_CLIENT_MERGE_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_CLIENT_MERGE_ENGINE__.pool }));

const merge = require('../server/services/client-merge');
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const clientRoutes = require('../server/routes/client-routes');

const AGX = 1;
const OTHER = 2;
const ADMIN = { id: 10, email: 'admin@agx.test', name: 'Ana Ruiz', role: 'admin', organization_id: AGX };
const VIEWER = { id: 11, email: 'view@agx.test', name: 'Val Viewer', role: 'viewer', organization_id: AGX };
const OTHER_ADMIN = { id: 20, email: 'admin@other.test', name: 'Oscar Other', role: 'admin', organization_id: OTHER };

// The production case this was built for, with the names it really has.
const KEEP = 'c-keep';      // "BH - Fountain Square Apartments", under the BH firm
const PARENT = 'c-parent';  // "BH" / company_name "BH Management"
const SRC = 'c-src';        // "Pensum - Fountain Square Apartments"
const OTHER_C = 'c-other';  // same shape, different organization

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
const mergeReq = (body, user) => req('POST', '/api/clients/merge', user || ADMIN, body);
const fold = (source, target, user) => mergeReq({ sourceId: source, targetId: target }, user);

const q = (sql, ...params) => engine.db.prepare(sql).all(...params);
const one = (sql, ...params) => engine.db.prepare(sql).get(...params);
const run = (sql, ...params) => engine.db.prepare(sql).run(...params);
const blob = (table, id) => JSON.parse(one('SELECT data FROM ' + table + ' WHERE id = ?', id).data);
const exists = (table, id) => one('SELECT COUNT(*) AS n FROM ' + table + ' WHERE id = ?', id).n;

const SCHEMA = tableColumns().tables;

// Insert a row into a polymorphic table naming a client, setting only the
// columns that table actually has. Built from the DERIVED schema so a test
// fixture cannot invent a column.
function polyRow(table, id, entityId, orgId) {
  const cols = SCHEMA.get(table);
  const names = ['id', 'entity_type', 'entity_id'];
  const vals = [id, 'client', entityId];
  if (cols.has('organization_id') && orgId != null) { names.push('organization_id'); vals.push(orgId); }
  run('INSERT INTO ' + table + ' (' + names.join(', ') + ') VALUES (' + names.map(() => '?').join(', ') + ')', ...vals);
}

function seed() {
  for (const t of ['clients', 'leads', 'projects', 'jobs', 'invoices', 'payments', 'estimates',
    'file_folders', 'attachment_folder_grants', 'live_rooms', 'users', 'roles', 'organizations']
    .concat(merge.POLYMORPHIC)) {
    run('DELETE FROM ' + t);
  }
  engine.db.exec(`
    INSERT INTO organizations (id, slug, name) VALUES (1, 'agx', 'AGX Central Florida'), (2, 'other', 'Other Builders');
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ESTIMATES_VIEW","ESTIMATES_EDIT"]'),
      ('viewer', 'Viewer', '["ESTIMATES_VIEW"]');
    INSERT INTO users (id, email, password_hash, name, role, organization_id, active) VALUES
      (10, 'admin@agx.test', 'x', 'Ana Ruiz', 'admin', 1, 1),
      (11, 'view@agx.test', 'x', 'Val Viewer', 'viewer', 1, 1),
      (20, 'admin@other.test', 'x', 'Oscar Other', 'admin', 2, 1);
  `);

  // ── the two clients ──
  // The survivor is a PROPERTY under a management firm, which is what makes
  // the estimate's "Client Company Name" the FIRM's name and not its own.
  run("INSERT INTO clients (id, name, company_name, organization_id) VALUES (?, 'BH', 'BH Management', 1)", PARENT);
  run(`INSERT INTO clients (id, name, parent_client_id, organization_id, bt_contact_id,
        activation_status, community_name, city, notes)
       VALUES (?, 'BH - Fountain Square Apartments', ?, 1, '40029614', 'inactive', 'Fountain Square Apartments', 'Tampa', 'keep these notes')`, KEEP, PARENT);
  // Everything the source has that the survivor does not is a fill candidate;
  // `city` and `notes` are the two it must NOT touch.
  run(`INSERT INTO clients (id, name, company_name, short_name, organization_id,
        gate_code, phone, city, notes)
       VALUES (?, 'Pensum - Fountain Square Apartments', 'Pensum', 'Pensum', 1,
        '#4410', '813-555-0100', 'Clearwater', 'drop these notes')`, SRC);
  run("INSERT INTO clients (id, name, parent_client_id, organization_id) VALUES ('c-kid', 'Pensum Building 2', ?, 1)", SRC);
  run("INSERT INTO clients (id, name, organization_id) VALUES (?, 'Pensum - Somewhere Else', 2)", OTHER_C);

  // ── one row per moved reference ──
  run("INSERT INTO leads (id, title, status, client_id, organization_id) VALUES ('l-src', 'Stair Repairs', 'new', ?, 1)", SRC);
  run("INSERT INTO leads (id, title, status, client_id, organization_id) VALUES ('l-other', 'Other Org Lead', 'new', ?, 2)", OTHER_C);
  run("INSERT INTO projects (id, name, client_id, organization_id) VALUES ('p-src', 'Fountain Square', ?, 1)", SRC);
  run("INSERT INTO invoices (id, client_id, status, organization_id) VALUES ('inv-src', ?, 'draft', 1)", SRC);
  run("INSERT INTO payments (id, client_id, amount, organization_id) VALUES ('pay-src', ?, 250, 1)", SRC);
  run("INSERT INTO jobs (id, owner_id, client_id, organization_id, data) VALUES ('j-col', 10, ?, 1, ?)",
    SRC, JSON.stringify({ jobNumber: 'S1', title: 'Column link', client: 'Pensum - Fountain Square Apartments' }));
  run("INSERT INTO jobs (id, owner_id, organization_id, data) VALUES ('j-blob', 10, 1, ?)",
    JSON.stringify({ jobNumber: 'S2', title: 'Blob link', clientId: SRC, client: 'Pensum - Fountain Square Apartments' }));

  // The estimate: never sent, client link inside the blob under the key the
  // estimate editor really writes (`client_id`), plus the frozen names.
  run("INSERT INTO estimates (id, owner_id, organization_id, data) VALUES ('e-src', 10, 1, ?)",
    JSON.stringify({ title: 'Fountain Square Stairs', client_id: SRC, client: 'Pensum', community: 'Fountain Square Apartments', nickName: 'Pensum' }));
  // An estimate of ANOTHER tenant naming the same id. Nothing may touch it.
  run("INSERT INTO estimates (id, owner_id, organization_id, data) VALUES ('e-other', 20, 2, ?)",
    JSON.stringify({ title: 'Not ours', client_id: SRC, client: 'Pensum' }));

  // ── SHADOW ROWS: another tenant's rows that NAME OUR SOURCE ID ──
  // This is the fixture that makes the tenant predicate on each repoint mean
  // something. Without it, `UPDATE leads SET client_id = $1 WHERE client_id =
  // $2` with the predicate DELETED passes every other test in this file — the
  // statement still moves our lead, and no row exists that it should have left
  // alone. A client id is a guessable string written into other tenants' rows
  // by their own users (that is the whole premise of "the blob is not a tenant
  // boundary"), so this is the state the predicate defends against, and it has
  // to be on the table for a test to see it.
  run("INSERT INTO leads (id, title, status, client_id, organization_id) VALUES ('l-shadow', 'Theirs', 'new', ?, 2)", SRC);
  run("INSERT INTO projects (id, name, client_id, organization_id) VALUES ('p-shadow', 'Theirs', ?, 2)", SRC);
  run("INSERT INTO invoices (id, client_id, status, organization_id) VALUES ('inv-shadow', ?, 'draft', 2)", SRC);
  run("INSERT INTO payments (id, client_id, amount, organization_id) VALUES ('pay-shadow', ?, 99, 2)", SRC);
  run("INSERT INTO jobs (id, owner_id, client_id, organization_id, data) VALUES ('j-shadow', 20, ?, 2, ?)",
    SRC, JSON.stringify({ jobNumber: 'X9', title: 'Theirs', clientId: SRC, client: 'Pensum - Fountain Square Apartments' }));
  run("INSERT INTO clients (id, name, parent_client_id, organization_id) VALUES ('c-shadow-kid', 'Theirs', ?, 2)", SRC);
  for (const t of merge.POLYMORPHIC) polyRow(t, 'shadow-' + t, SRC, OTHER);
  run("INSERT INTO file_folders (id, entity_type, entity_id, parent_id, name, path, organization_id) VALUES ('f-shadow', 'client', ?, NULL, 'Documents', '/Documents', 2)", SRC);

  // Everything filed against the client.
  for (const t of merge.POLYMORPHIC) polyRow(t, 'poly-' + t, SRC, AGX);
  run("INSERT INTO file_folders (id, entity_type, entity_id, parent_id, name, path, organization_id) VALUES ('f-keep-docs', 'client', ?, NULL, 'Documents', '/Documents', 1)", KEEP);
  run("INSERT INTO file_folders (id, entity_type, entity_id, parent_id, name, path, organization_id) VALUES ('f-src-docs', 'client', ?, NULL, 'documents', '/documents', 1)", SRC);
  run("INSERT INTO file_folders (id, entity_type, entity_id, parent_id, name, path, organization_id) VALUES ('f-src-photos', 'client', ?, NULL, 'Photos', '/Photos', 1)", SRC);
  run("UPDATE attachments SET folder_id = 'f-src-docs' WHERE id = 'poly-attachments'");
  // A sub's access grant on the folder that is about to be FOLDED away.
  // attachment_folder_grants.folder_id is REFERENCES file_folders(id) ON DELETE
  // **CASCADE** in db.js, so in Postgres the fold's DELETE takes this whole ROW
  // with it unless the merge repoints it first — and the sub loses the files
  // the merge has just moved into the survivor's folder. The harness emits no
  // foreign keys, so it cannot reproduce the cascade; what it CAN prove is that
  // the pointer ends up on the survivor's folder and not on an id that is gone.
  run("INSERT INTO attachment_folder_grants (id, sub_id, entity_type, entity_id, folder, folder_id) VALUES ('g-src-docs', 'sub-1', 'client', ?, 'documents', 'f-src-docs')", SRC);
}

beforeAll(async () => {
  setRolePool(engine.pool);
  seed();
  await refreshRoleCache();
  const app = express();
  app.use(express.json());
  app.use('/api/clients', clientRoutes);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  engine.close();
});
beforeEach(async () => { seed(); await refreshRoleCache(); });

// ── the registry, pinned ───────────────────────────────────────────────────
describe('the merge covers the reference registry, and the registry is the schema"s', () => {
  // The registry itself is pinned to server/db.js by
  // test/reconcile-merge.test.js. These two say the MERGE consumes all of it.
  const COVERED_COLUMNS = [
    ['clients', 'parent_client_id'], ['leads', 'client_id'], ['projects', 'client_id'],
    ['jobs', 'client_id'], ['invoices', 'client_id'], ['payments', 'client_id'],
  ];

  test('every registered client id column is one this suite drives a row through', () => {
    expect(COVERED_COLUMNS.map(([t, c]) => t + '.' + c).sort())
      .toEqual(merge.PLAIN.clients.map((r) => r.table + '.' + r.col).sort());
  });

  test('every polymorphic table is tenanted or on the tenant-less list, and db.js agrees', () => {
    const tenantLessPoly = merge.TENANT_LESS.filter((t) => merge.POLYMORPHIC.includes(t));
    expect(merge.POLY_TENANTED.concat(tenantLessPoly).sort()).toEqual(merge.POLYMORPHIC.slice().sort());
    // The list is a claim about the SCHEMA, so the schema answers it. A table
    // that gains organization_id cannot quietly stay on the tenant-less side.
    for (const t of merge.POLY_TENANTED) {
      expect([t, SCHEMA.get(t).has('organization_id')]).toEqual([t, true]);
    }
    for (const t of merge.TENANT_LESS) {
      expect([t, SCHEMA.get(t).has('organization_id')]).toEqual([t, false]);
    }
  });

  test('the blank-fill set is the editable allowlist minus the folded row"s own names', () => {
    // The fill and the estimate/job reframe read ONE list, twice: the columns
    // the reframe ERASES are exactly the columns the fill must not COPY. A
    // column added to EDITABLE_FIELDS has to be a deliberate choice about which
    // side of that line it lands on, which is what this pin forces.
    expect(merge.FILL_FIELDS.concat(merge.IDENTITY_FIELDS).sort())
      .toEqual(merge.EDITABLE_FIELDS.slice().sort());
    expect(merge.IDENTITY_FIELDS.slice().sort())
      .toEqual(['community_name', 'company_name', 'name', 'short_name']);
    for (const c of merge.IDENTITY_FIELDS) {
      expect([c, merge.FILL_FIELDS.includes(c)]).toEqual([c, false]);
      // ...and EDITABLE_FIELDS did NOT shrink to achieve that: it is also
      // client-routes.js's PUT allowlist, so a user editing a client by hand
      // must still be able to type all four.
      expect([c, merge.EDITABLE_FIELDS.includes(c)]).toEqual([c, true]);
    }
  });
});

// ── the merge ──────────────────────────────────────────────────────────────
describe('folding Pensum into the BH record', () => {
  test('the lead moves to the survivor — the database row, not the reply', async () => {
    const r = await fold(SRC, KEEP);
    expect(r.status).toBe(200);
    expect(one("SELECT client_id FROM leads WHERE id = 'l-src'").client_id).toBe(KEEP);
    expect(r.json.moved.leads).toBe(1);
  });

  test('the estimate moves AND stops naming the folded client', async () => {
    const r = await fold(SRC, KEEP);
    expect(r.status).toBe(200);
    const d = blob('estimates', 'e-src');
    expect(d.client_id).toBe(KEEP);
    // "Client Company Name" is the FIRM for a property row — the rule
    // window.onEstimateClientPicked uses in js/clients.js.
    expect(d.client).toBe('BH Management');
    expect(d.community).toBe('Fountain Square Apartments');
    // Nothing anywhere still says Pensum.
    expect(JSON.stringify(d)).not.toMatch(/Pensum/);
    expect(r.json.moved.estimates).toBe(1);
  });

  test('jobs (by column and by blob), projects, invoices, payments and child clients all repoint', async () => {
    const r = await fold(SRC, KEEP);
    expect(r.status).toBe(200);
    expect(one("SELECT client_id FROM jobs WHERE id = 'j-col'").client_id).toBe(KEEP);
    expect(blob('jobs', 'j-blob').clientId).toBe(KEEP);
    expect(one("SELECT client_id FROM projects WHERE id = 'p-src'").client_id).toBe(KEEP);
    expect(one("SELECT client_id FROM invoices WHERE id = 'inv-src'").client_id).toBe(KEEP);
    expect(one("SELECT client_id FROM payments WHERE id = 'pay-src'").client_id).toBe(KEEP);
    expect(one("SELECT parent_client_id FROM clients WHERE id = 'c-kid'").parent_client_id).toBe(KEEP);
    // The displayed client name on both jobs follows the survivor's `name`,
    // which is what confirmLinkJobClient writes.
    expect(blob('jobs', 'j-col').client).toBe('BH - Fountain Square Apartments');
    expect(blob('jobs', 'j-blob').client).toBe('BH - Fountain Square Apartments');
    // Two jobs were reached two different ways; that is TWO jobs moved.
    expect(r.json.moved).toEqual({ leads: 1, estimates: 1, jobs: 2, projects: 1, invoices: 1, payments: 1, children: 1 });
  });

  test('everything filed against the client moves too, and same-named folders fold', async () => {
    const r = await fold(SRC, KEEP);
    expect(r.status).toBe(200);
    for (const t of merge.POLYMORPHIC) {
      expect([t, one('SELECT entity_id FROM ' + t + ' WHERE id = ?', 'poly-' + t).entity_id]).toEqual([t, KEEP]);
    }
    // "documents" folded into "Documents": its attachment moved into the
    // survivor's folder and the emptied folder is gone. "Photos" just moved.
    expect(exists('file_folders', 'f-src-docs')).toBe(0);
    expect(one("SELECT folder_id FROM attachments WHERE id = 'poly-attachments'").folder_id).toBe('f-keep-docs');
    expect(one("SELECT entity_id FROM file_folders WHERE id = 'f-src-photos'").entity_id).toBe(KEEP);
    // The sub's grant SURVIVES the fold and points at the survivor's folder.
    // Without the repoint, folder_id would still name the deleted f-src-docs
    // here — and in Postgres, where the column cascades, the grant row itself
    // would be gone and the sub would have lost the files silently.
    const grant = one("SELECT * FROM attachment_folder_grants WHERE id = 'g-src-docs'");
    expect(grant).toBeTruthy();
    expect(grant.folder_id).toBe('f-keep-docs');
    expect(grant.entity_id).toBe(KEEP);
  });

  test('the source row is gone and the survivor is still there', async () => {
    const r = await fold(SRC, KEEP);
    expect(r.status).toBe(200);
    expect(exists('clients', SRC)).toBe(0);
    expect(exists('clients', KEEP)).toBe(1);
  });

  test('blank fields are filled from the source; fields that already had a value are not', async () => {
    const r = await fold(SRC, KEEP);
    expect(r.status).toBe(200);
    const keep = one('SELECT * FROM clients WHERE id = ?', KEEP);
    // Blank on the survivor, set on the source -> filled.
    expect(keep.gate_code).toBe('#4410');
    expect(keep.phone).toBe('813-555-0100');
    // Already had a value -> untouched, even though the source disagreed.
    expect(keep.city).toBe('Tampa');
    expect(keep.notes).toBe('keep these notes');
    expect(keep.name).toBe('BH - Fountain Square Apartments');
    // NOT filled, however blank: name / company_name / community_name /
    // short_name are what the FOLDED row was CALLED, not data the survivor was
    // missing. Copying one here is the same defect the estimate reframe exists
    // to cure, one table over — and worse, because the directory renders the
    // survivor as name + " — " + company_name and the estimate editor freezes
    // company_name/short_name onto every FUTURE estimate, so the folded name
    // would re-seed itself onto fresh proposals for ever.
    expect(keep.company_name).toBeFalsy();
    expect(keep.short_name).toBeFalsy();
    expect(keep.community_name).toBe('Fountain Square Apartments');
    expect(r.json.filled.sort()).toEqual(['gate_code', 'phone']);
    expect(r.json.filled).not.toContain('city');
    expect(r.json.filled).not.toContain('notes');
    // "Nothing anywhere still says Pensum" asserted on the CLIENT ROW, which
    // is where the estimate assertion above stopped short of looking.
    expect(JSON.stringify(keep)).not.toMatch(/Pensum/);
  });
});

// ── the folders, which are the one thing that cannot simply be UPDATEd ─────
describe('the folders the source has filed', () => {
  test('a client with more folders than any fixed cap still leaves NOTHING behind', async () => {
    // The loop resolves exactly ONE folder per pass, so its bound has to be the
    // row count. While it was the constant 200, folder 201 onward stayed filed
    // against the source — and execution fell straight through to the DELETE of
    // the client, orphaning them. Orphans manufactured by the module written to
    // prevent orphans, with nothing in the response saying so.
    for (let i = 0; i < 205; i++) {
      run("INSERT INTO file_folders (id, entity_type, entity_id, parent_id, name, path, organization_id)"
        + " VALUES (?, 'client', ?, NULL, ?, ?, 1)", 'f-bulk-' + i, SRC, 'Bulk ' + i, '/Bulk ' + i);
    }
    const r = await fold(SRC, KEEP);
    expect(r.status).toBe(200);
    // Not one row still names the client that was just deleted. The org arm is
    // on purpose: f-shadow is another tenant's row carrying our source id, and
    // it is neither moved nor counted.
    expect(one("SELECT COUNT(*) AS n FROM file_folders WHERE entity_type = 'client'"
      + " AND entity_id = ? AND organization_id = 1", SRC).n).toBe(0);
    expect(one("SELECT COUNT(*) AS n FROM file_folders WHERE entity_type = 'client'"
      + " AND entity_id = ? AND organization_id = 1", KEEP).n).toBe(207);
    expect(one("SELECT entity_id, organization_id FROM file_folders WHERE id = 'f-shadow'"))
      .toEqual({ entity_id: SRC, organization_id: OTHER });
    expect(exists('clients', SRC)).toBe(0);
  });

  test('a folder tree that loops is refused, and NOTHING the merge had already done survives', async () => {
    // The only way the loop can still stop with work left: every remaining
    // source folder is parented by another of them, so there is no root to
    // resolve first. Falling through to the DELETE would strand these rows on a
    // dead client id — and their attachments have already been repointed into
    // the survivor by then, so the files would be filed nowhere.
    run("INSERT INTO file_folders (id, entity_type, entity_id, parent_id, name, path, organization_id) VALUES ('f-a', 'client', ?, 'f-c', 'A', '/A', 1)", SRC);
    run("INSERT INTO file_folders (id, entity_type, entity_id, parent_id, name, path, organization_id) VALUES ('f-b', 'client', ?, 'f-a', 'B', '/B', 1)", SRC);
    run("INSERT INTO file_folders (id, entity_type, entity_id, parent_id, name, path, organization_id) VALUES ('f-c', 'client', ?, 'f-b', 'C', '/C', 1)", SRC);
    const r = await fold(SRC, KEEP);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/folder tree is malformed/);
    // The refusal is a ROLLBACK, so every earlier write is undone — including
    // the folder the loop HAD already folded away before it got stuck.
    expect(exists('clients', SRC)).toBe(1);
    expect(one("SELECT client_id FROM leads WHERE id = 'l-src'").client_id).toBe(SRC);
    expect(blob('estimates', 'e-src').client).toBe('Pensum');
    expect(one('SELECT gate_code FROM clients WHERE id = ?', KEEP).gate_code).toBeNull();
    expect(one("SELECT COUNT(*) AS n FROM file_folders WHERE entity_type = 'client'"
      + " AND entity_id = ? AND organization_id = 1", SRC).n).toBe(5);
  });

  test('the sub"s grant is repointed BEFORE the emptied folder is deleted', () => {
    // test/helpers/db-schema.js derives the tables from server/db.js but emits
    // NO foreign keys, so ON DELETE CASCADE does not exist in the harness and no
    // behavioural test in this file can reproduce it. The ORDER of the two
    // statements is the thing that is readable, and the order is the whole fix:
    // attachment_folder_grants.folder_id cascades, so a DELETE that runs first
    // destroys the sub's grant ROW rather than just its pointer.
    const code = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'client-merge.js'), 'utf8');
    const repoint = code.indexOf('UPDATE attachment_folder_grants SET folder_id');
    const del = code.indexOf('DELETE FROM file_folders');
    expect(repoint).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(-1);
    expect(repoint).toBeLessThan(del);
  });
});

// ── the refusals ───────────────────────────────────────────────────────────
describe('what it refuses, and what it leaves alone when it does', () => {
  test('a client cannot be merged into itself', async () => {
    const r = await fold(SRC, SRC);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/into itself/);
    expect(exists('clients', SRC)).toBe(1);
    expect(one("SELECT client_id FROM leads WHERE id = 'l-src'").client_id).toBe(SRC);
  });

  test('another organization"s client cannot be named as the source, and nothing moves', async () => {
    const r = await fold(OTHER_C, KEEP);
    expect(r.status).toBe(404);
    expect(exists('clients', OTHER_C)).toBe(1);
    expect(one("SELECT client_id FROM leads WHERE id = 'l-other'").client_id).toBe(OTHER_C);
    expect(one("SELECT parent_client_id FROM clients WHERE id = 'c-kid'").parent_client_id).toBe(SRC);
  });

  test('another organization"s client cannot be named as the survivor either', async () => {
    const r = await fold(SRC, OTHER_C);
    expect(r.status).toBe(404);
    expect(exists('clients', SRC)).toBe(1);
    expect(one("SELECT client_id FROM leads WHERE id = 'l-src'").client_id).toBe(SRC);
    expect(one("SELECT client_id FROM projects WHERE id = 'p-src'").client_id).toBe(SRC);
  });

  test('a merge by this organization never reaches another tenant"s estimate naming the same id', async () => {
    const r = await fold(SRC, KEEP);
    expect(r.status).toBe(200);
    const other = blob('estimates', 'e-other');
    expect(other.client_id).toBe(SRC);
    expect(other.client).toBe('Pensum');
  });

  test('NOT ONE of another tenant"s rows naming our source id is touched', async () => {
    // One assertion per repointed store. Each of these is a row that the SAME
    // statement would match if its tenant predicate were removed, so this is
    // the test that makes every one of those predicates load-bearing.
    const r = await fold(SRC, KEEP);
    expect(r.status).toBe(200);
    expect(one("SELECT client_id FROM leads WHERE id = 'l-shadow'").client_id).toBe(SRC);
    expect(one("SELECT client_id FROM projects WHERE id = 'p-shadow'").client_id).toBe(SRC);
    expect(one("SELECT client_id FROM invoices WHERE id = 'inv-shadow'").client_id).toBe(SRC);
    expect(one("SELECT client_id FROM payments WHERE id = 'pay-shadow'").client_id).toBe(SRC);
    expect(one("SELECT client_id FROM jobs WHERE id = 'j-shadow'").client_id).toBe(SRC);
    expect(blob('jobs', 'j-shadow')).toMatchObject({ clientId: SRC, client: 'Pensum - Fountain Square Apartments' });
    expect(one("SELECT parent_client_id FROM clients WHERE id = 'c-shadow-kid'").parent_client_id).toBe(SRC);
    expect(one("SELECT entity_id, organization_id FROM file_folders WHERE id = 'f-shadow'"))
      .toEqual({ entity_id: SRC, organization_id: OTHER });
    for (const t of merge.POLYMORPHIC) {
      // job_reports and ai_sessions have no organization_id to predicate on,
      // so their rows are scoped by the entity pair alone and DO move. That is
      // the documented gap (TENANT_LESS), stated here rather than hidden: a
      // row of another tenant can only carry this entity_id if that tenant
      // wrote our client's id into it.
      const expected = merge.TENANT_LESS.includes(t) ? KEEP : SRC;
      expect([t, one('SELECT entity_id FROM ' + t + ' WHERE id = ?', 'shadow-' + t).entity_id]).toEqual([t, expected]);
    }
  });

  test('merging a client into its own descendant is refused rather than looping the tree', async () => {
    // BH(parent) -> BH Fountain Square(keep). Folding the PARENT into the
    // child would repoint the child onto itself through any deeper chain.
    run("UPDATE clients SET parent_client_id = ? WHERE id = 'c-kid'", KEEP);
    const r = await fold(PARENT, KEEP);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/parent of the survivor/);
    expect(exists('clients', PARENT)).toBe(1);
    expect(one('SELECT parent_client_id FROM clients WHERE id = ?', KEEP).parent_client_id).toBe(PARENT);
  });

  test('two different Buildertrend contacts are refused rather than silently losing one', async () => {
    run("UPDATE clients SET bt_contact_id = '99999999' WHERE id = ?", SRC);
    const r = await fold(SRC, KEEP);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Buildertrend/);
    expect(exists('clients', SRC)).toBe(1);
    expect(one('SELECT bt_contact_id FROM clients WHERE id = ?', KEEP).bt_contact_id).toBe('40029614');
  });

  test('the Buildertrend link moves when only the folded row has one', async () => {
    run("UPDATE clients SET bt_contact_id = NULL WHERE id = ?", KEEP);
    run("UPDATE clients SET bt_contact_id = '99999999' WHERE id = ?", SRC);
    const r = await fold(SRC, KEEP);
    expect(r.status).toBe(200);
    expect(one('SELECT bt_contact_id FROM clients WHERE id = ?', KEEP).bt_contact_id).toBe('99999999');
    expect(r.json.filled).toContain('bt_contact_id');
  });

  test('a viewer cannot merge', async () => {
    const r = await fold(SRC, KEEP, VIEWER);
    expect(r.status).toBe(403);
    expect(exists('clients', SRC)).toBe(1);
  });

  test('a missing id is refused before anything runs', async () => {
    const r = await mergeReq({ sourceId: SRC });
    expect(r.status).toBe(400);
    expect(exists('clients', SRC)).toBe(1);
  });
});

// ── all of it, or none of it ───────────────────────────────────────────────
describe('the transaction', () => {
  test('a failure part-way through applies NOTHING — driven by a real failure, not read off the source', async () => {
    // Break the LAST statement of the merge: the delete of the source. By
    // then the fill, every repoint and every blob rewrite have already run,
    // so this is the strongest possible version of "part-way".
    const realConnect = engine.pool.connect;
    engine.pool.connect = async () => {
      const c = await realConnect();
      const inner = c.query;
      c.query = async (sql, params) => {
        if (/DELETE\s+FROM\s+clients\b/i.test(String(sql))) throw new Error('connection reset by peer');
        return inner(sql, params);
      };
      return c;
    };
    let r;
    try {
      r = await fold(SRC, KEEP);
    } finally {
      engine.pool.connect = realConnect;
    }
    expect(r.status).toBe(500);

    // Every single thing the merge had already done is gone.
    expect(exists('clients', SRC)).toBe(1);
    expect(one("SELECT client_id FROM leads WHERE id = 'l-src'").client_id).toBe(SRC);
    expect(one("SELECT client_id FROM projects WHERE id = 'p-src'").client_id).toBe(SRC);
    expect(one("SELECT client_id FROM invoices WHERE id = 'inv-src'").client_id).toBe(SRC);
    expect(one("SELECT client_id FROM payments WHERE id = 'pay-src'").client_id).toBe(SRC);
    expect(one("SELECT client_id FROM jobs WHERE id = 'j-col'").client_id).toBe(SRC);
    expect(one("SELECT parent_client_id FROM clients WHERE id = 'c-kid'").parent_client_id).toBe(SRC);
    expect(blob('estimates', 'e-src').client_id).toBe(SRC);
    expect(blob('estimates', 'e-src').client).toBe('Pensum');
    // The blank-fill is the first write of all, so it is the one a broken
    // rollback would leave behind.
    expect(one('SELECT gate_code FROM clients WHERE id = ?', KEEP).gate_code).toBeNull();
    expect(one("SELECT entity_id FROM tasks WHERE id = 'poly-tasks'").entity_id).toBe(SRC);
    expect(exists('file_folders', 'f-src-docs')).toBe(1);
  });
});
