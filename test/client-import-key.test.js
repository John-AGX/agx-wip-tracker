// POST /api/clients/import — WHAT IDENTIFIES A CLIENT.
//
// WHY THIS FILE EXISTS
// The bulk import decided insert-vs-update with one line:
//
//     for (const r of existing.rows) byName.set(String(r.name).trim().toLowerCase(), r.id);
//
// A name was being used as an identity. It is not one, and production proves
// it: 384 live clients contain NINE pairs that are the same property held
// twice. Eight are "Manager - Property" against the bare "Property", with the
// Buildertrend contact id on exactly one side of each pair and null on the
// other — the same contact imported under two naming conventions, and the name
// key could not tell. The ninth is "Sentry  Management - Largo" against
// "Sentry Management - Largo": .trim() trims the ENDS and never collapses what
// is INSIDE, so one extra keystroke minted a whole separate client.
//
// So every assertion here reads the DATABASE ROW, and the counting ones read
// the row COUNT before and after. The old code returned a perfectly cheerful
// { inserted: 1, errors: [] } for every duplicate it made; a test that trusts
// the response body would have passed on the day this bug shipped.
//
// The case that must NOT break while the duplicate class is closed has its own
// tests too: one manager's email address legitimately serves several different
// properties in this data, so an email match may never silently fold two of
// them into one.
//
// Real express router, requireAuth / requireCapability / requireOrgId, a JWT,
// and the pg-sqlite engine with every table derived from server/db.js.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema, tableNames } = require('./helpers/db-schema');

const engine = createPgSqlite(
  sqliteSchema(tableNames(), { pk: { organizations: 'id', users: 'id', roles: 'name', clients: 'id' } }),
  { jsonColumns: ['data'] }
);
globalThis.__P86_CLIENT_IMPORT_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_CLIENT_IMPORT_ENGINE__.pool }));

const { EDITABLE_FIELDS } = require('../server/services/client-merge');
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const clientRoutes = require('../server/routes/client-routes');

const AGX = 1;
const OTHER = 2;
const ADMIN = { id: 10, email: 'admin@agx.test', name: 'Ana Ruiz', role: 'admin', organization_id: AGX };
const OTHER_ADMIN = { id: 20, email: 'admin@other.test', name: 'Oscar Other', role: 'admin', organization_id: OTHER };

// The production rows, with the names and the id they really have.
const BH = 'c-bh';                // "BH - Fountain Square Apartments", bt id 40029614
const SENTRY = 'c-sentry';        // "Sentry Management - Largo", no bt id
const CASTILIAN = 'c-castilian';  // "Greystar - Castilian Apartments", the shared Greystar mailbox
const BORDEAUX = 'c-bordeaux';    // "Bordeaux Condominiums", a 1:1 email
const NA = 'c-na';                // an Email column holding "n/a", which is not an address
const OTHER_C = 'c-other';        // SAME name, SAME email, SAME bt id — different organisation

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
const importRows = (rows, user) => req('POST', '/api/clients/import', user || ADMIN, { rows });

const one = (sql, ...params) => engine.db.prepare(sql).get(...params);
const all = (sql, ...params) => engine.db.prepare(sql).all(...params);
const run = (sql, ...params) => engine.db.prepare(sql).run(...params);

const client = (id) => one('SELECT * FROM clients WHERE id = ?', id);
const count = () => one('SELECT COUNT(*) AS n FROM clients').n;
const countIn = (org) => one('SELECT COUNT(*) AS n FROM clients WHERE organization_id = ?', org).n;
const named = (name) => all('SELECT * FROM clients WHERE name = ?', name);

function seed() {
  for (const t of ['clients', 'users', 'roles', 'organizations']) run('DELETE FROM ' + t);
  engine.db.exec(`
    INSERT INTO organizations (id, slug, name) VALUES (1, 'agx', 'AGX Central Florida'), (2, 'other', 'Other Builders');
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ESTIMATES_VIEW","ESTIMATES_EDIT"]');
    INSERT INTO users (id, email, password_hash, name, role, organization_id, active) VALUES
      (10, 'admin@agx.test', 'x', 'Ana Ruiz', 'admin', 1, 1),
      (20, 'admin@other.test', 'x', 'Oscar Other', 'admin', 2, 1);
  `);

  run(`INSERT INTO clients (id, name, email, bt_contact_id, organization_id)
       VALUES (?, 'BH - Fountain Square Apartments', 'fountainsquare@bhmanagement.com', '40029614', 1)`, BH);
  run(`INSERT INTO clients (id, name, email, organization_id)
       VALUES (?, 'Sentry Management - Largo', 'largo@sentrymgmt.com', 1)`, SENTRY);
  // The Greystar regional manager's address. It is on this property AND, in
  // production, on others — so it is a MAILBOX, not an identity.
  run(`INSERT INTO clients (id, name, email, bt_contact_id, organization_id)
       VALUES (?, 'Greystar - Castilian Apartments', 'regional@greystar.com', 'C-1', 1)`, CASTILIAN);
  run(`INSERT INTO clients (id, name, email, organization_id)
       VALUES (?, 'Bordeaux Condominiums', 'bordeaux@cmpassocia.test', 1)`, BORDEAUX);
  run(`INSERT INTO clients (id, name, email, organization_id)
       VALUES (?, 'NA Holdings', 'n/a', 1)`, NA);

  // ── THE OTHER TENANT ──
  // Same name, same email, same Buildertrend id as rows above. Every rung has
  // something here to grab, so an unscoped index shows up as a wrong row
  // rather than as nothing at all.
  run(`INSERT INTO clients (id, name, email, bt_contact_id, organization_id)
       VALUES (?, 'Sentry Management - Largo', 'largo@sentrymgmt.com', '40029614', 2)`, OTHER_C);
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

// ── RUNG 0: the Buildertrend id ────────────────────────────────────────────
describe('rung 0 — the Buildertrend id outranks the name', () => {
  test('a row carrying a bt_contact_id UPDATES that client even when the name is completely different', async () => {
    // Eight of the nine live duplicates are exactly this: one Buildertrend
    // contact, imported once as "BH - Fountain Square Apartments" and once as
    // "Pensum - Fountain Square Apartments". Nothing about those two strings
    // can be matched, and nothing needs to be — the id says they are one row.
    const before = count();
    const res = await importRows([{
      name: 'Pensum - Fountain Square Apartments',
      bt_contact_id: '40029614',
      city: 'Tampa',
    }]);

    expect(res.status).toBe(200);
    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 1, 0]);
    expect(res.json.matchedBy).toEqual({ bt_contact_id: 1, email: 0, name: 0 });
    expect(count()).toBe(before);

    const row = client(BH);
    expect([row.name, row.city, row.bt_contact_id])
      .toEqual(['Pensum - Fountain Square Apartments', 'Tampa', '40029614']);
    // ...and no second client was minted under the new name.
    expect(named('Pensum - Fountain Square Apartments').map((c) => c.id)).toEqual([BH]);
  });

  test('when the bt id and the name point at DIFFERENT rows, the id wins and the name-match is untouched', async () => {
    const before = count();
    const res = await importRows([{
      name: 'Sentry Management - Largo',   // this name IS in the directory: c-sentry
      bt_contact_id: '40029614',           // ...but this id is c-bh's
      city: 'Largo',
    }]);

    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 1, 0]);
    expect(res.json.matchedBy.bt_contact_id).toBe(1);
    expect(res.json.matchedBy.name).toBe(0);
    expect(count()).toBe(before);

    expect([client(BH).name, client(BH).city]).toEqual(['Sentry Management - Largo', 'Largo']);
    // The row the NAME would have taken must be exactly as it was.
    expect([client(SENTRY).name, client(SENTRY).city]).toEqual(['Sentry Management - Largo', null]);
  });

  test('a free bt id is STAMPED onto the client the name matched, so rung 0 works on the next import', async () => {
    // This is the whole point of carrying the column: the first import links
    // the row, every later one matches on the id instead of the name.
    const res = await importRows([{ name: 'Sentry Management - Largo', bt_contact_id: '50001' }]);
    expect([res.json.inserted, res.json.updated]).toEqual([0, 1]);
    expect(client(SENTRY).bt_contact_id).toBe('50001');
    expect(res.json.errors).toEqual([]);

    const again = await importRows([{ name: 'Renamed In Buildertrend', bt_contact_id: '50001' }]);
    expect([again.json.inserted, again.json.updated]).toEqual([0, 1]);
    expect(client(SENTRY).name).toBe('Renamed In Buildertrend');
  });

  test('a rename on rung 0 is visible to the rows AFTER it in the same file', async () => {
    // The ladder's index is built once, so a rung-0 match that RENAMES a
    // client leaves the index holding the old name. A later row carrying the
    // NEW name must land on that same client — if the index is not kept
    // current, the import renames a row and then immediately mints a twin of
    // it, in one request, with a cheerful { inserted: 1, errors: [] }.
    const before = count();
    const res = await importRows([
      { name: 'Pensum - Fountain Square Apartments', bt_contact_id: '40029614' },
      { name: 'Pensum - Fountain Square Apartments', city: 'Tampa' },
    ]);

    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 2, 0]);
    expect(count()).toBe(before);
    expect(client(BH).city).toBe('Tampa');
    expect(named('Pensum - Fountain Square Apartments').map((c) => c.id)).toEqual([BH]);
  });

  test('an id already linked to ANOTHER client is refused and reported, and the link is not moved', async () => {
    // uq_clients_org_bt_contact_id is UNIQUE (organization_id, bt_contact_id),
    // so re-pointing is not merely wrong, it is a constraint violation inside
    // the import's single transaction.
    const res = await importRows([{
      name: 'Greystar - Castilian Apartments',  // matches CASTILIAN by name
      bt_contact_id: 'C-9',                     // free, but CASTILIAN already holds C-1
      city: 'Brandon',
    }]);
    expect(client(CASTILIAN).bt_contact_id).toBe('C-1');
    expect(client(CASTILIAN).city).toBe('Brandon');          // the rest of the row still imported
    expect(res.json.errors.map((e) => e.reason)).toEqual(['bt_id_conflict']);
    expect(res.json.errors[0].error).toContain('C-1');
    expect(res.json.errors[0].error).toContain('C-9');
  });
});

// ── RUNG 2: the normalized name ────────────────────────────────────────────
describe('rung 2 — the name key sees inside the string', () => {
  test('a name differing ONLY by internal whitespace UPDATES rather than INSERTS', async () => {
    // The ninth live duplicate, exactly. No email on the row, so rung 1 cannot
    // rescue it and rung 2 has to do the work on its own.
    const before = count();
    const res = await importRows([{ name: 'Sentry  Management - Largo', phone: '727-555-0101' }]);

    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 1, 0]);
    expect(res.json.matchedBy).toEqual({ bt_contact_id: 0, email: 0, name: 1 });
    expect(count()).toBe(before);
    expect(client(SENTRY).phone).toBe('727-555-0101');
    // Only one row bears either spelling.
    expect(all("SELECT id FROM clients WHERE name LIKE 'Sentry%Largo' AND organization_id = 1").map((c) => c.id))
      .toEqual([SENTRY]);
  });

  test('a name differing only by the DASH GLYPH updates rather than inserts', async () => {
    // Buildertrend writes a plain hyphen; Excel autocorrect and a paste out of
    // a PDF both hand back an en dash. Same separator, same property.
    const before = count();
    const res = await importRows([{ name: 'Greystar – Castilian Apartments', city: 'Tampa' }]);
    expect([res.json.inserted, res.json.updated]).toEqual([0, 1]);
    expect(count()).toBe(before);
    expect(client(CASTILIAN).city).toBe('Tampa');
  });

  test('two genuinely different properties are NOT folded by the name key', async () => {
    // The fold stops at whitespace and dashes for a reason. These two differ
    // by authored content and must stay two rows.
    const before = count();
    const res = await importRows([
      { name: 'Greystar - Castilian Apartments II' },
      { name: 'Greystar - Castilian Apartment' },
    ]);
    expect(res.json.inserted).toBe(2);
    expect(count()).toBe(before + 2);
  });
});

// ── RUNG 1, AND THE REFUSAL IT PAYS FOR ────────────────────────────────────
describe('rung 1 — an email is an identity only when it is a one-to-one one', () => {
  test('a 1:1 email whose names agree apart from punctuation UPDATES on rung 1', async () => {
    const before = count();
    const res = await importRows([{ name: 'Bordeaux Condominiums.', email: 'bordeaux@cmpassocia.test', city: 'Orlando' }]);

    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 1, 0]);
    expect(res.json.matchedBy).toEqual({ bt_contact_id: 0, email: 1, name: 0 });
    expect(count()).toBe(before);
    expect([client(BORDEAUX).name, client(BORDEAUX).city]).toEqual(['Bordeaux Condominiums.', 'Orlando']);
  });

  test('an email held by TWO existing clients matches NEITHER, even when one of the names agrees', async () => {
    // The already-duplicated state, which is what 384 live clients are in
    // today: the address sits on both halves of a pair. Taking whichever row
    // the SELECT happened to return first would write a coin toss into the
    // database — and it would be the WRONG half half the time. Rung 1 requires
    // a one-to-one address, so this falls through to the refusal instead, and
    // the user is told to merge.
    run("INSERT INTO clients (id, name, email, organization_id) VALUES ('c-bord2', 'CMP Associa - Bordeaux Condominiums', 'bordeaux@cmpassocia.test', 1)");
    const before = count();
    const res = await importRows([{ name: 'Bordeaux Condominiums.', email: 'bordeaux@cmpassocia.test', city: 'Orlando' }]);

    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 0, 1]);
    expect(res.json.matchedBy).toEqual({ bt_contact_id: 0, email: 0, name: 0 });
    expect(count()).toBe(before);
    expect(client(BORDEAUX).city).toBeNull();
    expect(client('c-bord2').city).toBeNull();
    // ...and the report names BOTH of the clients it could have been.
    expect(res.json.errors[0].reason).toBe('possible_duplicate');
    expect(res.json.errors[0].error).toContain('Bordeaux Condominiums');
    expect(res.json.errors[0].error).toContain('CMP Associa - Bordeaux Condominiums');
  });

  test('a row matching an existing client by email under a DIFFERENT name is REFUSED, reported, and inserts nothing', async () => {
    // "CMP Associa - Bordeaux Condominiums" <-> "Bordeaux Condominiums", and
    // seven more of that shape. The importer is looking straight at the second
    // half of a duplicate pair and must not make it.
    const before = count();
    const res = await importRows([{
      name: 'Fountain Square Apartments',
      email: 'fountainsquare@bhmanagement.com',
      city: 'Tampa',
    }]);

    expect(res.status).toBe(200);
    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 0, 1]);
    expect(count()).toBe(before);
    expect(named('Fountain Square Apartments')).toEqual([]);
    // ...and the client it collided with was not quietly updated instead.
    expect([client(BH).name, client(BH).city]).toEqual(['BH - Fountain Square Apartments', null]);

    // The report names BOTH sides and why, in the errors[] shape the handler
    // already uses and js/clients.js already renders.
    expect(res.json.errors.length).toBe(1);
    const e = res.json.errors[0];
    expect([e.row, e.name, e.reason, e.rung, e.matchedId, e.matchedName])
      .toEqual([0, 'Fountain Square Apartments', 'possible_duplicate', 'email', BH, 'BH - Fountain Square Apartments']);
    expect(e.error).toContain('Fountain Square Apartments');
    expect(e.error).toContain('BH - Fountain Square Apartments');
    expect(e.error).toContain('fountainsquare@bhmanagement.com');
  });

  test('a SECOND property sharing one manager"s email is created, not folded into the first', async () => {
    // THE CASE THAT MUST NOT BREAK. One Greystar regional address legitimately
    // serves several properties in this data. The sheet itself says so — two
    // differently named rows carry it — so the address is a mailbox, and
    // neither the rung nor the refusal may believe it.
    const before = count();
    const res = await importRows([
      { name: 'Greystar - Castilian Apartments', email: 'regional@greystar.com', city: 'Tampa' },
      { name: 'Greystar - Edge at Brandon', email: 'regional@greystar.com', city: 'Brandon' },
    ]);

    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([1, 1, 0]);
    expect(res.json.errors).toEqual([]);
    expect(count()).toBe(before + 1);

    // The first property kept its own name and got its own update...
    expect([client(CASTILIAN).name, client(CASTILIAN).city]).toEqual(['Greystar - Castilian Apartments', 'Tampa']);
    // ...and the second is a SEPARATE row, not a rename of the first.
    const edge = named('Greystar - Edge at Brandon');
    expect(edge.length).toBe(1);
    expect([edge[0].id !== CASTILIAN, edge[0].city, edge[0].email]).toEqual([true, 'Brandon', 'regional@greystar.com']);
  });

  test('an existing client already holding the shared address does not refuse the OTHER property either', async () => {
    // Same shape, but only the new property is in the file. The existing
    // Castilian row already carries the mailbox, so a naive "email is taken"
    // refusal would block a perfectly good new property for ever.
    const before = count();
    const res = await importRows([
      { name: 'Greystar - Edge at Brandon', email: 'regional@greystar.com' },
      { name: 'Greystar - Castilian Apartments', email: 'regional@greystar.com' },
    ]);
    expect([res.json.inserted, res.json.skipped]).toEqual([1, 0]);
    expect(count()).toBe(before + 1);
  });

  test('a malformed Email cell is not a key, so it can neither match nor refuse', async () => {
    // "n/a" in an Email column would otherwise be one identity shared by every
    // row that has no email — the widest possible wrong merge.
    const before = count();
    const res = await importRows([{ name: 'Totally Unrelated Property', email: 'n/a' }]);
    expect([res.json.inserted, res.json.skipped]).toEqual([1, 0]);
    expect(count()).toBe(before + 1);
    expect(client(NA).name).toBe('NA Holdings');
  });
});

// ── THE PARENT-COMPANY STUB ────────────────────────────────────────────────
describe('the parent-company stub loop keys the same way the rows do', () => {
  test('a company differing only by internal whitespace does not get a second stub', async () => {
    const res = await importRows([
      { name: 'Acme - Alpha', company_name: 'Acme Realty' },
      { name: 'Acme - Beta', company_name: 'Acme  Realty' },
    ]);

    expect(res.json.parentsCreated).toBe(1);
    const stubs = all("SELECT * FROM clients WHERE company_name = 'Acme Realty' AND name LIKE 'Acme%Realty' AND organization_id = 1");
    expect(stubs.length).toBe(1);

    // ...and BOTH properties hang off that one stub, which is the point: two
    // stubs meant half a firm's properties under one parent and half under
    // another, which no rollup can add back together.
    const alpha = named('Acme - Alpha')[0];
    const beta = named('Acme - Beta')[0];
    expect([alpha.parent_client_id, beta.parent_client_id]).toEqual([stubs[0].id, stubs[0].id]);
  });

  test('an existing client IS reused as the parent when the company name differs only by spacing', async () => {
    run("INSERT INTO clients (id, name, company_name, organization_id) VALUES ('c-firm', 'Acme Realty', 'Acme Realty', 1)");
    const res = await importRows([{ name: 'Acme - Gamma', company_name: 'Acme   Realty' }]);
    expect(res.json.parentsCreated).toBe(0);
    expect(named('Acme - Gamma')[0].parent_client_id).toBe('c-firm');
  });

  test('a stub is never matched by a property row"s email', async () => {
    // A stub is keyed by NAME ONLY and must be: the sheet carries no address
    // for the FIRM, so the only email in sight belongs to the property
    // contact. Binding the parent to it would make one property the parent of
    // its own siblings.
    const res = await importRows([
      { name: 'Bordeaux Condominiums', email: 'bordeaux@cmpassocia.test', company_name: 'CMP Associa' },
    ]);
    expect(res.json.parentsCreated).toBe(1);
    const firm = named('CMP Associa');
    expect(firm.length).toBe(1);
    expect(firm[0].id).not.toBe(BORDEAUX);
    expect(client(BORDEAUX).parent_client_id).toBe(firm[0].id);
  });
});

// ── TENANCY ────────────────────────────────────────────────────────────────
describe('the ladder is org-scoped on every rung', () => {
  test('another organisation"s client is never matched, updated or counted', async () => {
    const beforeOther = countIn(OTHER);
    const res = await importRows([
      { name: 'Sentry Management - Largo', city: 'Largo' },                       // rung 2 hits both orgs' names
      { name: 'A Wholly New Property', email: 'largo@sentrymgmt.com' },           // rung 1 / refusal sees both orgs' emails
    ]);

    // The AGX row was updated; the other tenant's identically named row was not.
    expect(client(SENTRY).city).toBe('Largo');
    expect([client(OTHER_C).name, client(OTHER_C).city, client(OTHER_C).organization_id])
      .toEqual(['Sentry Management - Largo', null, OTHER]);
    expect(countIn(OTHER)).toBe(beforeOther);

    // The second row refused against OUR Sentry (same email), not theirs.
    expect(res.json.skipped).toBe(1);
    expect(res.json.errors[0].matchedId).toBe(SENTRY);
  });

  test('a bt id held by another organisation is invisible to us, and ours to them', async () => {
    // '40029614' is on c-bh (org 1) and on c-other (org 2). Org 2's import must
    // land on ITS row and leave org 1's alone.
    const res = await importRows([{ name: 'Their Fountain Square', bt_contact_id: '40029614' }], OTHER_ADMIN);
    expect([res.json.inserted, res.json.updated]).toEqual([0, 1]);
    expect(client(OTHER_C).name).toBe('Their Fountain Square');
    expect(client(BH).name).toBe('BH - Fountain Square Apartments');
  });
});

// ── THE TWO PATHS bt_contact_id TRAVELS, KEPT APART ────────────────────────
describe('bt_contact_id is an import column, never a hand-edited one', () => {
  test('it is NOT in EDITABLE_FIELDS, which is both the PUT allowlist and the merge"s fill list', () => {
    expect(EDITABLE_FIELDS.includes('bt_contact_id')).toBe(false);
  });

  test('a PUT carrying bt_contact_id cannot set or change it', async () => {
    const before = client(SENTRY).bt_contact_id;
    const res = await req('PUT', '/api/clients/' + SENTRY, ADMIN, { city: 'Largo', bt_contact_id: '99999' });
    expect(res.status).toBe(200);
    expect(client(SENTRY).city).toBe('Largo');          // the edit landed...
    expect(client(SENTRY).bt_contact_id).toBe(before);  // ...and the identity did not move
  });

  test('a POST creating a client cannot set one either', async () => {
    const res = await req('POST', '/api/clients', ADMIN, { name: 'Hand Typed', bt_contact_id: '88888' });
    expect(res.status).toBe(200);
    expect(client(res.json.id).bt_contact_id).toBeNull();
  });

  test('the import path DOES let one through — the same body, the other door', async () => {
    const res = await importRows([{ name: 'Sentry Management - Largo', bt_contact_id: '99999' }]);
    expect(res.json.updated).toBe(1);
    expect(client(SENTRY).bt_contact_id).toBe('99999');
  });
});

// ── THE SHEET THE MAPPING IS BUILT FOR ─────────────────────────────────────
// The header map is evaluated, not grepped: a source-shaped assertion that
// only proves a string is present would pass on a mapping that had been
// commented out or spelled wrong. Hoisted to module scope because the
// row-index regression at the foot of this file drives the real router
// through this same map, the way parseBTWorkbook does.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'clients.js'), 'utf8');
const MAP_AT = SRC.indexOf('var BT_HEADER_MAP = {');
// eslint-disable-next-line no-eval
const MAP = eval('(' + SRC.slice(SRC.indexOf('{', MAP_AT), SRC.indexOf('\r\n  };', MAP_AT)) + '\r\n})');
const normalizeHeader = (h) => String(h || '').replace(/\*/g, '').trim().toLowerCase();

describe('js/clients.js maps a NAMED Buildertrend id column, and is inert on the sheet that exists', () => {

  // The real header row of the "Client Contacts" export AGX has today, read
  // off the sheet itself. There is no id column in it, and none may be faked.
  const REAL_HEADERS = ['Name', 'Activation Status', 'Phone', 'Cell', 'Address', 'City', 'State', 'Zip',
    'Jobs', 'Lead Opportunities', 'Email', 'First Name', 'Last Name', '*Gate Code/Addtl Notes*',
    'Additional POCs*', 'CM Direct Phone*', 'CM Email*', 'Community Manager/CAM*', 'Community Name*',
    'Company Name*', 'Maintenance Manager*', 'Market*', 'MM Direct Phone*', 'MM Email*',
    'Property Address*', 'Property Phone*', 'Website*'];
  test('a bare "ID" column is NOT a Buildertrend identity', () => {
    // In a re-exported, CSV-round-tripped or hand-built sheet, a column
    // headed simply "ID" is overwhelmingly a row index. Mapping it stamps
    // 1, 2, 3 onto clients.bt_contact_id as genuine identities, and the next
    // import of the same sheet in a different row order matches on rung 0 -
    // which nothing downstream can outrank - and re-points every client,
    // with errors[] empty and no undo. The STANDARD is pinned here rather
    // than the mapping, so re-adding it under any spelling has to come past
    // this test first.
    expect(MAP.id).toBeUndefined();
    expect(MAP['client id']).toBeUndefined();
    expect(MAP['#']).toBeUndefined();
    // Only the headers that NAME the Buildertrend record are mapped.
    expect(MAP['contact id']).toBe('bt_contact_id');
    expect(MAP['buildertrend id']).toBe('bt_contact_id');
  });

  test('the sheet that exists today produces NO bt_contact_id — the rung is inert, not faked', () => {
    const mapped = REAL_HEADERS.map(normalizeHeader).map((h) => MAP[h]).filter(Boolean);
    expect(mapped.includes('bt_contact_id')).toBe(false);
    // ...and the map is still doing its real job on that sheet.
    expect(mapped).toContain('name');
    expect(mapped).toContain('email');
    expect(mapped).toContain('company_name');
  });

  test('the browser"s editable-field list does not carry bt_contact_id either', () => {
    const editable = SRC.slice(SRC.indexOf('var EDITABLE_FIELDS = ['));
    expect(editable.slice(0, editable.indexOf('];')).includes('bt_contact_id')).toBe(false);
  });
});

// == THE ROW-INDEX SHEET =====================================================
// The regression the class actually needs. A header-map assertion on its own
// would pass again the day someone re-adds the mapping for a good-sounding
// reason, so this drives the REAL router with a sheet whose only id column is
// headed "ID" and asserts on the DATABASE ROWS.
describe('a sheet whose id column is a row index cannot re-point a client', () => {
  // The browser's own mapping, applied the way parseBTWorkbook applies it:
  // BT_HEADER_MAP[normalizeHeader(h)], with every value String(v).trim()'d.
  const asSheet = (headers, rows) => rows.map((cells) => {
    const out = {};
    headers.forEach((h, i) => {
      const col = MAP[normalizeHeader(h)];
      if (col && cells[i] !== '' && cells[i] != null) out[col] = String(cells[i]).trim();
    });
    return out;
  });
  const seedThree = () => {
    run("INSERT INTO clients (id, name, organization_id) VALUES ('c-1', 'Alpha Apartments', 1)");
    run("INSERT INTO clients (id, name, organization_id) VALUES ('c-2', 'Beta Villas', 1)");
    run("INSERT INTO clients (id, name, organization_id) VALUES ('c-3', 'Gamma Court', 1)");
  };

  test('the same export re-sorted leaves every client under its own name', async () => {
    // PROBE 5: the second import reported matchedBy { bt_contact_id: 3 } and
    // left c-1 named "Gamma Court" and c-3 named "Alpha Apartments".
    seedThree();
    const before = count();
    const headers = ['ID', 'Name', 'City'];

    const first = await importRows(asSheet(headers, [
      [1, 'Alpha Apartments', 'Orlando'],
      [2, 'Beta Villas', 'Largo'],
      [3, 'Gamma Court', 'Tampa'],
    ]));
    expect(first.json.matchedBy.bt_contact_id).toBe(0);

    // The SAME sheet, re-sorted. The index column still reads 1, 2, 3.
    const second = await importRows(asSheet(headers, [
      [1, 'Gamma Court', 'Tampa'],
      [2, 'Beta Villas', 'Largo'],
      [3, 'Alpha Apartments', 'Orlando'],
    ]));
    expect(second.json.matchedBy.bt_contact_id).toBe(0);

    expect(count()).toBe(before);
    expect([client('c-1').name, client('c-2').name, client('c-3').name])
      .toEqual(['Alpha Apartments', 'Beta Villas', 'Gamma Court']);
    expect([client('c-1').city, client('c-3').city]).toEqual(['Orlando', 'Tampa']);
    // ...and no row index was ever mistaken for an identity.
    expect([client('c-1').bt_contact_id, client('c-3').bt_contact_id]).toEqual([null, null]);
  });

  test('a property added at the top of the sheet does not erase the one below it', async () => {
    // PROBE 9b: four rows produced three clients, 0 inserted, 4 "updated",
    // and "Beta Villas" was erased from the directory outright.
    seedThree();
    const before = count();
    const res = await importRows(asSheet(['ID', 'Name', 'City'], [
      [1, 'Delta Place', 'NEW'],
      [2, 'Alpha Apartments', 'Orlando'],
      [3, 'Beta Villas', 'Largo'],
      [4, 'Gamma Court', 'Tampa'],
    ]));

    expect([res.json.inserted, res.json.updated]).toEqual([1, 3]);
    expect(res.json.matchedBy.bt_contact_id).toBe(0);
    expect(count()).toBe(before + 1);
    expect(named('Beta Villas').length).toBe(1);
    expect(client('c-2').city).toBe('Largo');
  });
});

// == RUNG 0 REFUSES WHAT IS NOT AN IDENTITY ==================================
describe('rung 0 refuses a placeholder, and refuses an id it sees twice in one file', () => {
  // Every word the route denies, plus the punctuation-only shapes. A guard
  // no test can defend is a line that quietly stops meaning anything.
  const PLACEHOLDERS = ['N/A', 'n/a', '-', '--', 'TBD', 'none', 'null', 'nil', 'na', 'NA',
    'unknown', 'pending', 'unassigned', '0', '00', '#', '...', '???', '  '];

  for (const ph of PLACEHOLDERS) {
    test('an Id column reading "' + ph + '" on every row keeps three properties three', async () => {
      // Three properties in, ONE client out, reported as a completely
      // successful import: row 1 inserted and was stamped with the
      // placeholder, and rows 2 and 3 rung-0 matched it and renamed it in
      // turn. The response body said inserted: 1, errors: [] - so the
      // assertion has to be on the ROW COUNT.
      const before = count();
      const res = await importRows([
        { name: 'Placeholder Alpha', bt_contact_id: ph, city: 'Tampa' },
        { name: 'Placeholder Beta', bt_contact_id: ph, city: 'Largo' },
        { name: 'Placeholder Gamma', bt_contact_id: ph, city: 'Orlando' },
      ]);
      expect(res.json.inserted).toBe(3);
      expect(res.json.matchedBy.bt_contact_id).toBe(0);
      expect(count()).toBe(before + 3);
      expect(all('SELECT id FROM clients WHERE bt_contact_id = ?', String(ph).trim()).length).toBe(0);
      expect([named('Placeholder Alpha')[0].city, named('Placeholder Gamma')[0].city])
        .toEqual(['Tampa', 'Orlando']);
    });
  }

  for (const ph of PLACEHOLDERS) {
    test('ONE row whose Id cell reads "' + ph + '" imports with no id stamped', async () => {
      // One row, so the repeated-in-file guard cannot be what saves it.
      // This is the placeholder test itself, on its own - and the stamp is
      // what has to be asserted, because a value rung 0 would refuse to
      // MATCH on must never be WRITTEN either.
      const before = count();
      const res = await importRows([{ name: 'Lone Placeholder Row', bt_contact_id: ph, city: 'Tampa' }]);
      expect([res.json.inserted, res.json.skipped]).toEqual([1, 0]);
      expect(count()).toBe(before + 1);
      expect(named('Lone Placeholder Row')[0].bt_contact_id).toBeNull();
      expect(res.json.errors).toEqual([]);
    });
  }

  test('a NUMERIC zero in the Id column is not an identity either', async () => {
    const before = count();
    const res = await importRows([
      { name: 'Zero Alpha', bt_contact_id: 0 },
      { name: 'Zero Beta', bt_contact_id: 0 },
    ]);
    expect(res.json.inserted).toBe(2);
    expect(count()).toBe(before + 2);
  });

  test('a placeholder on an EXISTING row is not matched or renamed by an unrelated property', async () => {
    run("INSERT INTO clients (id, name, bt_contact_id, organization_id) VALUES ('c-junkid', 'Junk Id Holdings', 'N/A', 1)");
    const before = count();
    const res = await importRows([{ name: 'Nothing To Do With It', bt_contact_id: 'N/A', city: 'Tampa' }]);
    expect(res.json.inserted).toBe(1);
    expect(count()).toBe(before + 1);
    expect([client('c-junkid').name, client('c-junkid').city]).toEqual(['Junk Id Holdings', null]);
  });

  test('a REAL id repeated on two rows of one file identifies neither, and BOTH rows still import', async () => {
    // No denylist can catch a well-formed value pasted down a column, so the
    // INCOMING side is counted instead - the way bt-match.js counts it.
    const before = count();
    const res = await importRows([
      { name: 'Repeated Alpha', bt_contact_id: '40031000', city: 'Tampa' },
      { name: 'Repeated Beta', bt_contact_id: '40031000', city: 'Largo' },
    ]);
    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([2, 0, 0]);
    expect(res.json.matchedBy.bt_contact_id).toBe(0);
    expect(count()).toBe(before + 2);
    // Neither client was stamped...
    expect(all("SELECT id FROM clients WHERE bt_contact_id = '40031000'").length).toBe(0);
    // ...and the withholding was REPORTED, not swallowed.
    expect(res.json.errors.map((e) => e.reason)).toEqual(['bt_id_repeated', 'bt_id_repeated']);
    expect(res.json.errors[0].error).toContain('40031000');
    expect([named('Repeated Alpha')[0].city, named('Repeated Beta')[0].city]).toEqual(['Tampa', 'Largo']);
  });

  test('the PROBE A shape: twelve correct rows with an "N/A" Id column update all twelve', async () => {
    for (let i = 1; i <= 12; i++) {
      run("INSERT INTO clients (id, name, organization_id) VALUES ('p-" + i + "', 'Property " + i + "', 1)");
    }
    const before = count();
    const rows = [];
    for (let i = 1; i <= 12; i++) rows.push({ name: 'Property ' + i, bt_contact_id: 'N/A', city: 'City ' + i });
    const res = await importRows(rows);

    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 12, 0]);
    expect(res.json.errors).toEqual([]);
    expect(count()).toBe(before);
    for (let i = 1; i <= 12; i++) {
      expect([client('p-' + i).name, client('p-' + i).city]).toEqual(['Property ' + i, 'City ' + i]);
    }
    // ...and no two of them ended up sharing a name.
    const names = all("SELECT name FROM clients WHERE id LIKE 'p-%'").map((r) => r.name);
    expect(new Set(names).size).toBe(12);
  });

  test('one bt id on TWO clients matches neither, because a NULL org never conflicts with a real one', async () => {
    // uq_clients_org_bt_contact_id is UNIQUE (organization_id, bt_contact_id)
    // WHERE bt_contact_id IS NOT NULL, and Postgres lets (NULL, '770001')
    // and (1, '770001') both exist - while the index read is scoped
    // (organization_id = $1 OR organization_id IS NULL) and returns both. So
    // rung 0 can genuinely be handed two clients, and a single-valued Map
    // would silently keep whichever the SELECT returned last.
    run("INSERT INTO clients (id, name, bt_contact_id, organization_id) VALUES ('b-org', 'Linked Under AGX', '770001', 1)");
    run("INSERT INTO clients (id, name, bt_contact_id) VALUES ('b-null', 'Linked Before Orgs Existed', '770001')");
    const before = count();
    const res = await importRows([{ name: 'Whichever One You Meant', bt_contact_id: '770001', city: 'Tampa' }]);

    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 0, 1]);
    expect(res.json.matchedBy.bt_contact_id).toBe(0);
    expect(count()).toBe(before);
    expect([client('b-org').name, client('b-org').city]).toEqual(['Linked Under AGX', null]);
    expect([client('b-null').name, client('b-null').city]).toEqual(['Linked Before Orgs Existed', null]);
    const e = res.json.errors[0];
    expect([e.reason, e.rung]).toEqual(['possible_duplicate', 'bt_contact_id']);
    expect(e.error).toContain('Linked Under AGX');
    expect(e.error).toContain('Linked Before Orgs Existed');
  });

  test('a genuine Buildertrend id still matches and still stamps', async () => {
    // The denylist may never grow into the real-id space: a format gate that
    // rejected a real id would silently re-inert this rung.
    const res = await importRows([
      { name: 'Pensum - Fountain Square Apartments', bt_contact_id: '40029614' },  // rung 0 onto c-bh
      { name: 'Sentry Management - Largo', bt_contact_id: '50001' },               // free id, stamped on rung 2's match
    ]);
    expect(res.json.matchedBy.bt_contact_id).toBe(1);
    expect(client(BH).name).toBe('Pensum - Fountain Square Apartments');
    expect(client(SENTRY).bt_contact_id).toBe('50001');
    expect(res.json.errors).toEqual([]);
  });
});

// == RUNG 2 REFUSES A KEY TWO CLIENTS SHARE ==================================
// The state production is in TODAY. importNameKey collapses internal
// whitespace and folds dash glyphs, so both halves of the ninth live pair now
// share ONE key - and a single-valued index would keep whichever row the
// unordered SELECT returned LAST and write the other half's data onto it.
describe('rung 2 refuses a collapsed key rather than guessing which half to write', () => {
  const SENTRY2 = 'c-sentry2';
  const insJunk = "INSERT INTO clients (id, name, email, organization_id) VALUES ('" + SENTRY2 + "', 'Sentry  Management - Largo', 'largo@sentrymgmt.com', 1)";
  const insGood = "INSERT INTO clients (id, name, email, organization_id) VALUES ('c-sentry', 'Sentry Management - Largo', 'largo@sentrymgmt.com', 1)";

  // SAME request, SAME data, opposite physical row order. This pair of cases
  // is the assertion that actually pins it closed: the single-order version
  // passes against the buggy code half the time.
  const ORDERS = [
    ['the real row first', () => { run(insJunk); }, [SENTRY, SENTRY2]],
    ['the junk row first', () => { run("DELETE FROM clients WHERE id = 'c-sentry'"); run(insJunk); run(insGood); }, [SENTRY2, SENTRY]],
  ];

  for (const [label, seedOrder, expectedOrder] of ORDERS) {
    test('both halves seeded, ' + label + ' - refused, and NEITHER row is touched', async () => {
      seedOrder();
      // The order really is different between the two cases, which is the
      // whole point - assert it rather than assume it.
      expect(all("SELECT id FROM clients WHERE name LIKE 'Sentry%Largo' AND organization_id = 1").map((r) => r.id))
        .toEqual(expectedOrder);
      const before = count();
      const res = await importRows([{ name: 'Sentry Management - Largo', phone: '727-999-9999', city: 'Largo' }]);

      expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 0, 1]);
      expect(res.json.matchedBy).toEqual({ bt_contact_id: 0, email: 0, name: 0 });
      expect(count()).toBe(before);
      // Byte-unchanged on BOTH halves. The old code renamed whichever one it
      // landed on to the incoming spelling, destroying the last thing that
      // told the pair apart and leaving two indistinguishable rows in the
      // merge picker.
      expect([client(SENTRY).name, client(SENTRY).phone, client(SENTRY).city])
        .toEqual(['Sentry Management - Largo', null, null]);
      expect([client(SENTRY2).name, client(SENTRY2).phone, client(SENTRY2).city])
        .toEqual(['Sentry  Management - Largo', null, null]);
      const e = res.json.errors[0];
      expect([e.reason, e.rung]).toEqual(['possible_duplicate', 'name']);
      expect(e.error).toContain('Sentry Management - Largo');
      expect(e.error).toContain('Sentry  Management - Largo');
    });
  }

  test('the refusal is NOT gated on an email - a pair with no address on either half is still refused', async () => {
    // The email refusal cannot cover this: it needs an ek. Without a name-side
    // refusal the row falls straight through to INSERT and mints a THIRD copy
    // of a property the directory already holds twice.
    run("DELETE FROM clients WHERE id = 'c-sentry'");
    run("INSERT INTO clients (id, name, organization_id) VALUES ('c-sentry', 'Sentry Management - Largo', 1)");
    run("INSERT INTO clients (id, name, organization_id) VALUES ('" + SENTRY2 + "', 'Sentry  Management - Largo', 1)");
    const before = count();
    const res = await importRows([{ name: 'Sentry Management - Largo', phone: '727-555-0101' }]);

    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 0, 1]);
    expect(count()).toBe(before);
    expect(res.json.errors[0].rung).toBe('name');
    expect([client(SENTRY).phone, client(SENTRY2).phone]).toEqual([null, null]);
  });

  test('a DASH-glyph pair is refused too, and neither row is renamed into the other spelling', async () => {
    const EN_DASH = String.fromCharCode(0x2013);
    run("INSERT INTO clients (id, name, organization_id) VALUES ('d-1', 'Greystar - Edge at Brandon', 1)");
    run("INSERT INTO clients (id, name, organization_id) VALUES ('d-2', 'Greystar " + EN_DASH + " Edge at Brandon', 1)");
    const before = count();
    const res = await importRows([{ name: 'Greystar - Edge at Brandon', city: 'Brandon' }]);

    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 0, 1]);
    expect(count()).toBe(before);
    expect([client('d-1').name, client('d-1').city]).toEqual(['Greystar - Edge at Brandon', null]);
    expect([client('d-2').name, client('d-2').city]).toEqual(['Greystar ' + EN_DASH + ' Edge at Brandon', null]);
  });

  test('an ambiguous company name leaves parent_client_id null rather than picking a half', async () => {
    // Binding half a firm's properties to one twin and half to the other
    // inverts the hierarchy the stub loop exists to build.
    run("INSERT INTO clients (id, name, organization_id) VALUES ('f-1', 'Acme Realty', 1)");
    run("INSERT INTO clients (id, name, organization_id) VALUES ('f-2', 'Acme  Realty', 1)");
    const res = await importRows([{ name: 'Acme - Delta', company_name: 'Acme Realty' }]);

    expect(res.json.parentsCreated).toBe(0);
    expect(named('Acme - Delta')[0].parent_client_id).toBeNull();
    expect(res.json.errors.map((e) => e.reason)).toEqual(['ambiguous_parent']);
  });

  test('a REFUSED row does not also report that it imported', async () => {
    // The ambiguous-firm note ends "This row imported with no parent
    // company". On a row that was refused, that is a lie - and a report
    // nobody can trust is what let nine duplicates accumulate unnoticed.
    run("INSERT INTO clients (id, name, organization_id) VALUES ('" + SENTRY2 + "', 'Sentry  Management - Largo', 1)");
    run("INSERT INTO clients (id, name, organization_id) VALUES ('f-1', 'Acme Realty', 1)");
    run("INSERT INTO clients (id, name, organization_id) VALUES ('f-2', 'Acme  Realty', 1)");
    const before = count();
    const res = await importRows([{ name: 'Sentry Management - Largo', company_name: 'Acme Realty', city: 'Largo' }]);

    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 0, 1]);
    expect(count()).toBe(before);
    expect(res.json.errors.map((e) => e.reason)).toEqual(['possible_duplicate']);
  });

  test('a one-to-one name still UPDATES - the refusal is for collisions only', async () => {
    const before = count();
    const res = await importRows([{ name: 'Sentry  Management - Largo', phone: '727-555-0101' }]);
    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 1, 0]);
    expect(count()).toBe(before);
    expect(client(SENTRY).phone).toBe('727-555-0101');
  });
});

// == RUNG 1 MAY NOT OUTRANK AN EXACT NAME ====================================
describe('rung 1 stands down when rung 2 has an exact answer on a different client', () => {
  test('the exactly-named client is the one updated, and no second row gains its name', async () => {
    // PROBE 4: the row that matched a client's name EXACTLY was never touched;
    // a different client was renamed onto that name instead, silently. The
    // change that exists to stop name duplicates minted one.
    run("UPDATE clients SET name = 'Bordeaux Condominiums.' WHERE id = '" + BORDEAUX + "'");
    run("INSERT INTO clients (id, name, organization_id) VALUES ('c-bexact', 'Bordeaux Condominiums', 1)");
    const before = count();
    const res = await importRows([{ name: 'Bordeaux Condominiums', email: 'bordeaux@cmpassocia.test', city: 'Orlando' }]);

    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 1, 0]);
    expect(res.json.matchedBy).toEqual({ bt_contact_id: 0, email: 0, name: 1 });
    expect(count()).toBe(before);
    expect([client('c-bexact').name, client('c-bexact').city]).toEqual(['Bordeaux Condominiums', 'Orlando']);
    // The approximately-named client keeps its own name and gets nothing...
    expect([client(BORDEAUX).name, client(BORDEAUX).city]).toEqual(['Bordeaux Condominiums.', null]);
    // ...so exactly ONE row bears the incoming name.
    expect(named('Bordeaux Condominiums').map((c) => c.id)).toEqual(['c-bexact']);
  });

  test('the hyphen-vs-space variant needs no typo and behaves the same way', async () => {
    // PROBE 10. The loose key folds '-' to a space, so this pair agrees on
    // rung 1 while differing on rung 2 - no misspelling required.
    run("INSERT INTO clients (id, name, email, organization_id) VALUES ('c-park1', 'Park-100 Center', 'park100@cmpassocia.test', 1)");
    run("INSERT INTO clients (id, name, organization_id) VALUES ('c-park2', 'Park 100 Center', 1)");
    const before = count();
    const res = await importRows([{ name: 'Park 100 Center', email: 'park100@cmpassocia.test', city: 'FOLDED' }]);

    expect(res.json.matchedBy).toEqual({ bt_contact_id: 0, email: 0, name: 1 });
    expect(count()).toBe(before);
    expect([client('c-park2').name, client('c-park2').city]).toEqual(['Park 100 Center', 'FOLDED']);
    expect([client('c-park1').name, client('c-park1').city]).toEqual(['Park-100 Center', null]);
    expect(named('Park 100 Center').map((c) => c.id)).toEqual(['c-park2']);
  });

  test('a Name cell of pure punctuation is not agreement, so a 1:1 email cannot hijack its client', async () => {
    // PROBE 8 was the corroboration test passing on '' === '': any two names
    // made only of punctuation "agree".
    run("INSERT INTO clients (id, name, email, organization_id) VALUES ('c-dash', '-', 'dash@cmpassocia.test', 1)");
    const before = count();
    const res = await importRows([{ name: '.', email: 'dash@cmpassocia.test', city: 'Hijacked' }]);

    expect([res.json.updated, res.json.skipped]).toEqual([0, 1]);
    expect(count()).toBe(before);
    expect([client('c-dash').name, client('c-dash').city]).toEqual(['-', null]);
    expect(res.json.errors[0].reason).toBe('possible_duplicate');
  });

  test('the legitimate rung-1 case still fires when no exact-name client is present', async () => {
    const res = await importRows([{ name: 'Bordeaux Condominiums.', email: 'bordeaux@cmpassocia.test', city: 'Orlando' }]);
    expect(res.json.matchedBy).toEqual({ bt_contact_id: 0, email: 1, name: 0 });
    expect([client(BORDEAUX).name, client(BORDEAUX).city]).toEqual(['Bordeaux Condominiums.', 'Orlando']);
  });
});

// == A RENAME RETIRES THE KEY IT RENAMED AWAY FROM ===========================
describe('a rename retires the old name key', () => {
  test('a later row carrying the OLD name is its own client, not a rename back', async () => {
    // The reverse of the forward-direction test: the index held BOTH keys, so
    // row 2 rung-2 matched the stale one, renamed the client straight back and
    // wrote its data over it. One row out of two, reported as "updated: 2".
    run("INSERT INTO clients (id, name, bt_contact_id, organization_id) VALUES ('r-1', 'Old Name LLC', '900', 1)");
    const before = count();
    const res = await importRows([
      { name: 'New Name LLC', bt_contact_id: '900' },   // rung 0 renames r-1
      { name: 'Old Name LLC', city: 'Tampa' },          // a DIFFERENT, new client
    ]);

    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([1, 1, 0]);
    expect(count()).toBe(before + 1);
    expect([client('r-1').name, client('r-1').city]).toEqual(['New Name LLC', null]);
    const fresh = named('Old Name LLC');
    expect(fresh.length).toBe(1);
    expect([fresh[0].id !== 'r-1', fresh[0].city]).toEqual([true, 'Tampa']);
  });

  test('retiring the old key does not evict a client that SHARES it', async () => {
    // The two-space / one-space pair again. Deleting the whole KEY would take
    // the other half's only index entry with it, and the next row would mint a
    // twin of a client sitting right there. Only the renamed id leaves.
    run("UPDATE clients SET name = 'Sentry  Management - Largo', bt_contact_id = '900' WHERE id = '" + SENTRY + "'");
    run("INSERT INTO clients (id, name, organization_id) VALUES ('c-sentry2', 'Sentry Management - Largo', 1)");
    const before = count();
    const res = await importRows([
      { name: 'Pensum - Largo', bt_contact_id: '900' },        // renames c-sentry away
      { name: 'Sentry Management - Largo', city: 'Largo' },    // must land on c-sentry2
    ]);

    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 2, 0]);
    expect(count()).toBe(before);
    expect(client(SENTRY).name).toBe('Pensum - Largo');
    expect([client('c-sentry2').name, client('c-sentry2').city]).toEqual(['Sentry Management - Largo', 'Largo']);
  });

  test('the forward direction still holds - a rename is visible to the rows after it', async () => {
    const before = count();
    const res = await importRows([
      { name: 'Pensum - Fountain Square Apartments', bt_contact_id: '40029614' },
      { name: 'Pensum - Fountain Square Apartments', city: 'Tampa' },
    ]);
    expect([res.json.inserted, res.json.updated, res.json.skipped]).toEqual([0, 2, 0]);
    expect(count()).toBe(before);
    expect(named('Pensum - Fountain Square Apartments').map((c) => c.id)).toEqual([BH]);
  });
});
