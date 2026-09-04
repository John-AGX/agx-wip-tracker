// The tenant boundary on ESTIMATE and INVOICE writes.
//
// THE DEFECT THIS FILE EXISTS FOR
// `PUT /api/estimates/bulk/save` read the row it was about to write with
// `SELECT updated_at FROM estimates WHERE id = $1 FOR UPDATE` — no tenant
// predicate and, worse, no tenant COLUMN in the projection, so the branch
// below it could not have checked the tenant even if it had wanted to. Both
// version branches were gated on `base`, so a request carrying a FOREIGN
// estimate id with NO baseVersions entry fell through every guard to
// `INSERT INTO estimates … ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
// which finds the foreign row BY PRIMARY KEY and replaces its whole blob.
// organization_id is (correctly) absent from the SET list, so the victim org
// KEEPS the row and simply sees its contents become someone else's. The caller
// was handed a version and told ok:true.
//
// The `is_locked` gate did not save a sold estimate either: `lockedIds` is
// built org-scoped, so another tenant's SOLD estimate is not in the set and
// the lock branch never fires for it.
//
// This is the same defect commit aebad8a8 fixed on `PUT /api/jobs/bulk/save`
// ("A job in another tenant is no longer a job you can overwrite"). The
// estimates handler's own header says it "Mirrors /api/jobs/bulk/save"; the
// fix was never mirrored with it. See test/job-org-boundary.test.js.
//
// The same shape was open on AR: `recomputeInvoicePaid()` read and wrote
// `invoices … WHERE id = $1` with no tenant predicate, reached from
// `POST /api/payments` with an `applications[].invoice_id` taken straight off
// the request body and never checked against the caller's org.
//
// WHY THERE IS A REAL SQL ENGINE UNDER THIS
// The property is "NOTHING CHANGED", and that is a property of the WHERE
// clause, which is the one thing a hand-written fake pool cannot be trusted
// to evaluate. So the statements the routes actually emit are handed to
// node:sqlite (test/helpers/pg-sqlite.js) and the victim row is BYTE-DIFFED
// before and after. The router is mounted for real, on real express, behind
// real requireAuth / requireCapability / requireOrgId, driven over real HTTP
// with a real JWT — because "refused before anything is written" is a
// property of the middleware chain as much as of the handler.
//
// THE PROPERTIES (each asserted over a MATRIX of callers and rows, not on one
// hand-picked case):
//   P1  a write lands if and only if the caller owns the row, or the row is
//       legacy NULL-org. For every other pairing the row is byte-identical
//       afterwards.
//   P2  a refused cross-tenant write is REPORTED as a conflict naming the row.
//       Never a silent skip — a silent skip re-baselines the row on the client
//       as though it had been written, which is how "immutable" becomes
//       "dropped edit" (the comment at estimate-routes.js:286 says exactly
//       this about the locked case; it is honoured here for the tenant case).
//   P3  a locked (SOLD) estimate is immutable to EVERY caller, its own org
//       included.
//   P4  legacy NULL-org rows still save. Tightening to `organization_id = $n`
//       would orphan them silently; the tolerance arm at estimate-routes.js:51
//       is the policy and it is preserved.
//   P5  the refusal must not answer a question the caller could not otherwise
//       ask: a foreign row and an absent row must be INDISTINGUISHABLE on the
//       wire. Before the fix this endpoint was a batched existence +
//       last-modified oracle over every tenant's estimates (5000 ids a call).
//   P6  AR: a payment in org A cannot move `amount_paid` / `status` /
//       `paid_at` on an invoice in org B.

'use strict';

const express = require('express');
const http = require('http');

const { createPgSqlite } = require('./helpers/pg-sqlite');

// Postgres DDL reduced to what sqlite needs. Column NAMES and NULLability are
// what the statements under test bind against; the money columns keep their
// meaning. Types are sqlite's because sqlite is dynamically typed — that is a
// property of the engine, not a loosening of the assertions, which are all on
// WHICH ROWS a statement touched.
const SCHEMA = `
  CREATE TABLE organizations (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT, organization_id INTEGER);
  CREATE TABLE roles (name TEXT PRIMARY KEY, label TEXT, capabilities TEXT);
  CREATE TABLE jobs (id TEXT PRIMARY KEY, organization_id INTEGER, data TEXT);
  CREATE TABLE estimates (
    id TEXT PRIMARY KEY,
    owner_id INTEGER,
    data TEXT NOT NULL,
    organization_id INTEGER,
    market_id INTEGER,
    is_locked INTEGER NOT NULL DEFAULT 0,
    approval_status TEXT,
    approved_at TEXT,
    signature TEXT,
    sent_at TEXT,
    sent_count INTEGER NOT NULL DEFAULT 0,
    geocode_lat REAL, geocode_lng REAL, geocode_status TEXT,
    geocode_at TEXT, geocode_addr TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE invoices (
    id TEXT PRIMARY KEY,
    organization_id INTEGER,
    owner_id INTEGER,
    job_id TEXT, client_id TEXT, pay_application_id TEXT,
    invoice_number TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    issue_date TEXT, due_date TEXT, terms TEXT,
    subtotal REAL NOT NULL DEFAULT 0,
    tax_pct REAL NOT NULL DEFAULT 0,
    tax_amount REAL NOT NULL DEFAULT 0,
    retainage_amount REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    amount_paid REAL NOT NULL DEFAULT 0,
    data TEXT NOT NULL DEFAULT '{}',
    sent_at TEXT, paid_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    organization_id INTEGER,
    owner_id INTEGER,
    client_id TEXT,
    payment_date TEXT,
    amount REAL NOT NULL DEFAULT 0,
    method TEXT, reference TEXT,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;

// ONE engine for the whole file, created before the routers are required.
// It cannot be swapped per-test: `estimate-routes.js` does
// `const { pool } = require('../db')` at module load, so it captures whatever
// object the mock returns THEN and holds it for the life of the process. A
// per-test `createPgSqlite` would leave the route writing to the first engine
// while the assertions read the second — every write would look refused, and
// this file would report a green tenant boundary on a database nobody wrote
// to. Rows are cleared between tests instead.
// `data` decodes as a parsed object, the way the pg driver hands back jsonb —
// recomputeInvoicePaid reads `r.data.applications` off a payments row, and as
// raw text that silently reads as "no applications", i.e. every money
// assertion below would pass because nothing was ever summed.
const engine = createPgSqlite(SCHEMA, { jsonColumns: ['data'] });

jest.mock('../server/db', () => ({ pool: globalThis.__P86_EST_ENGINE__.pool }));

// Markets is the OPERATING dimension, never the tenant. Stubbed to a fixed
// answer so that if a "fix" ever tried to derive tenancy from it, the org
// assertions below could not pass by accident.
jest.mock('../server/services/markets', () => ({
  loadMarketMap: async () => ({ byName: {} }),
  resolveMarketId: () => null
}));

// No network from a unit test. The bulk save fires geocoding after COMMIT.
// It returns REAL-LOOKING coords and records every call, because the geocode
// pass is itself a write path onto five columns of whatever row the id names —
// a stub that returned null would make the refusal untestable by making the
// write a no-op for the wrong reason.
globalThis.__P86_GEOCODE_CALLS__ = [];
jest.mock('../server/geocoder', () => ({
  geocodeAddress: async (addr) => {
    globalThis.__P86_GEOCODE_CALLS__.push(addr);
    return { lat: 28.5383, lng: -81.3792 };
  }
}));

globalThis.__P86_EST_ENGINE__ = engine;

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const estimateRoutes = require('../server/routes/estimate-routes');
const invoiceRoutes = require('../server/routes/invoice-routes');

let server, baseUrl;

const ORG_A = 1;
const ORG_B = 2;

// The victim blob. Every assertion below diffs against THIS, verbatim.
const VICTIM_BLOB = {
  name: 'Victim Org-B Estimate',
  total: 250000,
  lines: [{ id: 'l1', description: 'Structural steel', qty: 4, unitCost: 12500 }],
  alternates: [{ id: 'alt1', name: 'Base Bid' }]
};
const ATTACK_BLOB = { name: 'OVERWRITTEN BY ORG A', total: 1, lines: [], alternates: [] };

function seed() {
  engine.db.exec(`
    DELETE FROM estimates; DELETE FROM invoices; DELETE FROM payments;
    DELETE FROM jobs; DELETE FROM users; DELETE FROM roles; DELETE FROM organizations;
    INSERT INTO organizations (id, name) VALUES (1, 'Org A'), (2, 'Org B');
    INSERT INTO users (id, email, role, organization_id) VALUES
      (10, 'a@a.a', 'admin', 1), (20, 'b@b.b', 'admin', 2);
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ESTIMATES_EDIT","ESTIMATES_VIEW","FINANCIALS_VIEW"]'),
      ('field_crew', 'Field Crew', '["ESTIMATES_EDIT","ESTIMATES_VIEW"]');
  `);
  setRolePool(engine.pool);
  return refreshRoleCache();
}

function insertEstimate(id, orgId, blob, opts) {
  const o = opts || {};
  engine.db.prepare(
    `INSERT INTO estimates (id, owner_id, data, organization_id, is_locked,
                            approval_status, signature, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, o.ownerId == null ? 20 : o.ownerId, JSON.stringify(blob),
        orgId == null ? null : orgId, o.locked ? 1 : 0,
        o.approvalStatus || null, o.signature || null,
        o.updatedAt || '2026-01-01 00:00:00');
}

// The whole row, as text, in a stable column order — so "nothing changed"
// means every column, not just `data`. approval_status / signature / is_locked
// survive the upsert too, which is what makes a signed, sold estimate keep
// rendering as signed while its contents are someone else's.
function snapshotEstimate(id) {
  const r = engine.db.prepare(
    `SELECT id, owner_id, data, organization_id, market_id, is_locked,
            approval_status, signature, sent_at, sent_count, updated_at,
            geocode_lat, geocode_lng, geocode_status, geocode_at, geocode_addr
       FROM estimates WHERE id = ?`
  ).all(id);
  return JSON.stringify(r);
}

function snapshotInvoice(id) {
  const r = engine.db.prepare(
    `SELECT id, organization_id, status, total, amount_paid, paid_at, updated_at
       FROM invoices WHERE id = ?`
  ).all(id);
  return JSON.stringify(r);
}

function tokenFor(user) {
  return signToken(Object.assign(
    { id: 10, email: 'a@a.a', role: 'admin', name: 'A', organization_id: ORG_A },
    user));
}

async function call(method, path, user, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tokenFor(user) },
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body: json };
}

function bulkSave(user, estimates, baseVersions) {
  return call('PUT', '/api/estimates/bulk/save', user, {
    estimates, estimateLines: [], estimateAlternates: [], baseVersions: baseVersions || {}
  });
}

function conflictFor(body, id) {
  const list = (body && Array.isArray(body.conflicts)) ? body.conflicts : [];
  return list.find((c) => c && c.id === id) || null;
}

beforeAll((done) => {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/estimates', estimateRoutes);
  app.use('/api', invoiceRoutes);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = 'http://127.0.0.1:' + server.address().port;
    done();
  });
});

afterAll((done) => { server.close(() => done()); });

beforeEach(() => { globalThis.__P86_GEOCODE_CALLS__ = []; return seed(); });

// ── P1 + P2 — the matrix ────────────────────────────────────────────────────
// The property is stated over CALLERS × ROWS × BASE-PRESENCE, not over one
// hand-picked request, because the defect lived in exactly one cell of it
// (foreign row, no base) and any test written against a single case would have
// been chosen to hit or to miss it.
describe('PATH E1 — PUT /api/estimates/bulk/save: a write lands only where the caller owns the row', () => {
  const CALLERS = [
    { label: 'org-A admin',      user: { id: 10, role: 'admin',      organization_id: ORG_A } },
    { label: 'org-A field_crew', user: { id: 11, role: 'field_crew', organization_id: ORG_A } },
  ];
  const ROWS = [
    { label: 'row in the caller\'s own org', org: ORG_A, mustWrite: true },
    { label: 'row in ANOTHER tenant',        org: ORG_B, mustWrite: false },
    { label: 'legacy NULL-org row',          org: null,  mustWrite: true },
  ];
  const BASES = [
    { label: 'no base (the client is CREATING / has never loaded it)', base: null,   expectWriteWhenOwned: true },
    { label: 'a matching base',                                        base: 'match', expectWriteWhenOwned: true },
    { label: 'a stale base',                                           base: 'stale', expectWriteWhenOwned: false },
  ];

  CALLERS.forEach((c) => ROWS.forEach((r) => BASES.forEach((b) => {
    const name = `${c.label} · ${r.label} · ${b.label}`;
    test(name, async () => {
      const ID = 'est-target';
      insertEstimate(ID, r.org, VICTIM_BLOB, { updatedAt: '2026-01-01 00:00:00' });
      const before = snapshotEstimate(ID);

      let bv = {};
      if (b.base === 'match') {
        const ts = engine.db.prepare('SELECT updated_at u FROM estimates WHERE id = ?').all(ID)[0].u;
        bv[ID] = new Date(ts).toISOString();
      } else if (b.base === 'stale') {
        bv[ID] = new Date('2020-01-01T00:00:00Z').toISOString();
      }

      const res = await bulkSave(c.user, [{ id: ID, ...ATTACK_BLOB }], bv);
      expect(res.status).toBe(200);
      const after = snapshotEstimate(ID);

      const shouldWrite = r.mustWrite && b.expectWriteWhenOwned;
      if (shouldWrite) {
        // P1 (positive half): the legitimate path is NOT collateral damage.
        expect(after).not.toBe(before);
        expect(JSON.parse(JSON.parse(after)[0].data).name).toBe('OVERWRITTEN BY ORG A');
        expect(res.body.versions && res.body.versions[ID]).toBeTruthy();
        expect(conflictFor(res.body, ID)).toBeNull();
      } else {
        // P1: byte-identical. Every column, not just `data`.
        expect(after).toBe(before);
        // P2: and REPORTED — never a silent skip.
        const conflict = conflictFor(res.body, ID);
        expect(conflict).not.toBeNull();
        expect(res.body.versions || {}).not.toHaveProperty(ID);
      }
    });
  })));
});

// ── P2 — the refusal has to be legible, and it has to be the RIGHT word ─────
describe('PATH E2 — a cross-tenant refusal is reported as not_in_org, not as deleted', () => {
  test('a foreign row with a base is not called "deleted" — nothing of the caller\'s was lost', async () => {
    const ID = 'est-foreign';
    insertEstimate(ID, ORG_B, VICTIM_BLOB);
    const before = snapshotEstimate(ID);
    const res = await bulkSave({ organization_id: ORG_A },
      [{ id: ID, ...ATTACK_BLOB }], { [ID]: new Date('2020-01-01T00:00:00Z').toISOString() });
    expect(snapshotEstimate(ID)).toBe(before);
    const c = conflictFor(res.body, ID);
    expect(c).not.toBeNull();
    // 'deleted' means "the row you loaded is gone and your edit is
    // unrecoverable" and the client escalates it to a data-loss modal. This
    // row is alive and untouched in another tenant; saying 'deleted' would be
    // a lie that costs the user a panic.
    expect(c.reason).toBe('not_in_org');
    expect(c.reason).not.toBe('deleted');
  });
});

// ── P3 — locked is locked, for everyone ────────────────────────────────────
describe('PATH E3 — a SOLD (is_locked) estimate is immutable to every caller', () => {
  [
    { label: 'its own org', callerOrg: ORG_A, rowOrg: ORG_A, expectReason: 'locked' },
    { label: 'another tenant', callerOrg: ORG_A, rowOrg: ORG_B, expectReason: 'not_in_org' },
    { label: 'a legacy NULL-org sold estimate', callerOrg: ORG_A, rowOrg: null, expectReason: 'locked' },
  ].forEach((cse) => {
    test(`locked estimate, caller from ${cse.label} — unchanged and reported`, async () => {
      const ID = 'est-sold';
      insertEstimate(ID, cse.rowOrg, VICTIM_BLOB, {
        locked: true, approvalStatus: 'approved', signature: '{"by":"client"}'
      });
      const before = snapshotEstimate(ID);
      const res = await bulkSave({ organization_id: cse.callerOrg }, [{ id: ID, ...ATTACK_BLOB }], {});
      expect(res.status).toBe(200);
      expect(snapshotEstimate(ID)).toBe(before);
      const c = conflictFor(res.body, ID);
      expect(c).not.toBeNull();
      expect(c.reason).toBe(cse.expectReason);
      expect(res.body.versions || {}).not.toHaveProperty(ID);
    });
  });
});

// ── P4 — the legacy population must not be orphaned ────────────────────────
describe('PATH E4 — legacy NULL-org estimates still save, and are not silently claimed', () => {
  test('a NULL-org estimate saves, and its organization_id is NOT rewritten by the save', async () => {
    const ID = 'est-legacy';
    insertEstimate(ID, null, VICTIM_BLOB);
    const res = await bulkSave({ organization_id: ORG_A },
      [{ id: ID, name: 'legit edit', total: 9 }], {});
    expect(res.status).toBe(200);
    expect(conflictFor(res.body, ID)).toBeNull();
    const row = engine.db.prepare('SELECT organization_id o, data d FROM estimates WHERE id = ?').all(ID)[0];
    expect(JSON.parse(row.d).name).toBe('legit edit');
    // A routine bulk save must not perform a TENANT MOVE. organization_id is
    // deliberately absent from the DO UPDATE SET list; the claim, if it is
    // ever made, belongs to the evidence-based backfill in db.js, not here.
    expect(row.o).toBeNull();
  });
});

// ── P5 — the oracle ────────────────────────────────────────────────────────
describe('PATH E5 — the endpoint does not answer questions about other tenants', () => {
  test('a live foreign row and a row that does not exist are indistinguishable on the wire', async () => {
    insertEstimate('est-alive-elsewhere', ORG_B, VICTIM_BLOB, { updatedAt: '2026-07-04 12:34:56' });
    const stale = new Date('2020-01-01T00:00:00Z').toISOString();
    const res = await bulkSave({ organization_id: ORG_A }, [
      { id: 'est-alive-elsewhere', ...ATTACK_BLOB },
      { id: 'est-does-not-exist-anywhere', ...ATTACK_BLOB }
    ], { 'est-alive-elsewhere': stale, 'est-does-not-exist-anywhere': stale });

    const foreign = conflictFor(res.body, 'est-alive-elsewhere');
    const absent = conflictFor(res.body, 'est-does-not-exist-anywhere');
    expect(foreign).not.toBeNull();
    expect(absent).not.toBeNull();
    // Before the fix the foreign id answered 'stale' AND handed back the
    // victim row's real updated_at, while the absent id answered 'deleted'
    // with null — a batched existence + last-modified oracle, 5000 ids a call
    // (the cap at estimate-routes.js:236), needing no write at all.
    expect(foreign.serverUpdatedAt).toBeNull();
    expect(foreign.reason).not.toBe('stale');
  });
});

// ── the create path the guard must not break ───────────────────────────────
describe('PATH E6 — creating a genuinely new estimate still works and is stamped', () => {
  test('an id the server has never seen inserts, with the caller\'s org on it', async () => {
    const res = await bulkSave({ organization_id: ORG_A },
      [{ id: 'est-brand-new', name: 'New', total: 5 }], {});
    expect(res.status).toBe(200);
    expect(conflictFor(res.body, 'est-brand-new')).toBeNull();
    const row = engine.db.prepare('SELECT organization_id o FROM estimates WHERE id = ?').all('est-brand-new')[0];
    expect(row).toBeTruthy();
    expect(row.o).toBe(ORG_A);
  });
});

// ── the write path that lives PAST the guard ───────────────────────────────
// The tenant branch closes the transaction. The geocode pass runs AFTER the
// COMMIT, off the RAW REQUEST ARRAY, and writes five columns on whatever row
// each id names — including the ids the branch just refused. Its errors are
// swallowed by design, so it would have failed silently and forever.
describe('PATH E7 — a refused cross-tenant save does not geocode the victim either', () => {
  test('no geocode is attempted, and the victim\'s geocode columns are untouched', async () => {
    const ID = 'est-geo-victim';
    insertEstimate(ID, ORG_B, { name: 'Victim', propertyAddr: '100 Victim Way, Orlando FL' });
    const before = snapshotEstimate(ID);
    const mark = engine.log.length;
    const res = await bulkSave({ organization_id: ORG_A },
      [{ id: ID, name: 'mine', propertyAddr: '1 Attacker Rd, Tampa FL' }], {});
    expect(conflictFor(res.body, ID).reason).toBe('not_in_org');
    // Fire-and-forget: give the un-awaited promise chain room to land.
    await new Promise((r) => setTimeout(r, 60));
    expect(globalThis.__P86_GEOCODE_CALLS__).toEqual([]);
    expect(snapshotEstimate(ID)).toBe(before);
    // …and the geocode pass was NOT ENTERED for the refused id. This is the
    // stronger claim, and it is the one that separates the two layers: the
    // org predicate inside geocodeEstimate would keep the row unchanged even
    // if the loop still walked the refused ids, so "unchanged" alone cannot
    // tell a working filter from a broken one. "No statement was issued" can.
    const geocodeReads = engine.log.slice(mark)
      .filter((q) => /propertyAddr/i.test(q.sql));
    expect(geocodeReads).toEqual([]);
  });

  test('the caller\'s OWN estimate still geocodes (the control)', async () => {
    const ID = 'est-geo-mine';
    insertEstimate(ID, ORG_A, { name: 'Mine' });
    await bulkSave({ organization_id: ORG_A },
      [{ id: ID, name: 'Mine', propertyAddr: '200 Real St, Orlando FL' }], {});
    await new Promise((r) => setTimeout(r, 60));
    expect(globalThis.__P86_GEOCODE_CALLS__).toEqual(['200 Real St, Orlando FL']);
    const row = engine.db.prepare('SELECT geocode_status s FROM estimates WHERE id = ?').all(ID)[0];
    expect(row.s).toBe('ok');
  });
});

// ── P6 — AR ────────────────────────────────────────────────────────────────
describe('PATH I1 — POST /api/payments cannot move money on another tenant\'s invoice', () => {
  function seedInvoice(id, orgId) {
    engine.db.prepare(
      `INSERT INTO invoices (id, organization_id, owner_id, status, total, amount_paid, updated_at)
       VALUES (?, ?, ?, 'sent', 50000, 0, '2026-01-01 00:00:00')`
    ).run(id, orgId == null ? null : orgId, 20);
  }

  test('an org-A payment applied to an org-B invoice leaves that invoice byte-identical', async () => {
    seedInvoice('inv-victim', ORG_B);
    const before = snapshotInvoice('inv-victim');
    const res = await call('POST', '/api/payments', { organization_id: ORG_A }, {
      payment_date: '2026-09-04', amount: 50000, method: 'check',
      applications: [{ invoice_id: 'inv-victim', amount: 50000 }]
    });
    // P2 on the AR path: VISIBLY refused, naming the id. Not a 200 with the
    // application quietly dropped — that leaves the cash looking applied on
    // one screen and the invoice open on another.
    expect(res.status).toBe(404);
    expect(res.body.invoice_ids).toEqual(['inv-victim']);
    expect(snapshotInvoice('inv-victim')).toBe(before);
    // …and no orphan payment row was left behind in the caller's own org.
    expect(engine.count('SELECT id FROM payments')).toBe(0);
  });

  test('an org-A payment CAN still settle an org-A invoice (the control)', async () => {
    seedInvoice('inv-ours', ORG_A);
    const res = await call('POST', '/api/payments', { organization_id: ORG_A }, {
      payment_date: '2026-09-04', amount: 50000, method: 'check',
      applications: [{ invoice_id: 'inv-ours', amount: 50000 }]
    });
    expect(res.status).toBe(200);
    const row = engine.db.prepare('SELECT status s, amount_paid p FROM invoices WHERE id = ?').all('inv-ours')[0];
    expect(row.s).toBe('paid');
    expect(Number(row.p)).toBe(50000);
  });

  test('a legacy NULL-org invoice still settles (the tolerance arm is preserved)', async () => {
    seedInvoice('inv-legacy', null);
    const res = await call('POST', '/api/payments', { organization_id: ORG_A }, {
      payment_date: '2026-09-04', amount: 50000, method: 'check',
      applications: [{ invoice_id: 'inv-legacy', amount: 50000 }]
    });
    expect(res.status).toBe(200);
    const row = engine.db.prepare('SELECT status s, amount_paid p FROM invoices WHERE id = ?').all('inv-legacy')[0];
    expect(row.s).toBe('paid');
  });

  test('an org-A payment cannot knock a PAID org-B invoice back to sent', async () => {
    engine.db.prepare(
      `INSERT INTO invoices (id, organization_id, owner_id, status, total, amount_paid, paid_at, updated_at)
       VALUES (?, ?, ?, 'paid', 50000, 50000, '2026-02-02 00:00:00', '2026-02-02 00:00:00')`
    ).run('inv-paid-victim', ORG_B, 20);
    const before = snapshotInvoice('inv-paid-victim');
    const res = await call('POST', '/api/payments', { organization_id: ORG_A }, {
      payment_date: '2026-09-04', amount: 0, method: 'check',
      applications: [{ invoice_id: 'inv-paid-victim', amount: 0 }]
    });
    expect(res.status).toBe(404);
    expect(snapshotInvoice('inv-paid-victim')).toBe(before);
  });

  // PUT /payments/:id is the OTHER door onto the same applications[] array.
  // Closing only the create path would leave the update path open, which is
  // the shape of every one of these findings.
  test('PATH I2 — re-applying an existing org-A payment cannot reach an org-B invoice', async () => {
    seedInvoice('inv-victim2', ORG_B);
    seedInvoice('inv-mine', ORG_A);
    const before = snapshotInvoice('inv-victim2');
    const create = await call('POST', '/api/payments', { organization_id: ORG_A }, {
      payment_date: '2026-09-04', amount: 10, method: 'check',
      applications: [{ invoice_id: 'inv-mine', amount: 10 }]
    });
    expect(create.status).toBe(200);
    const payId = create.body.payment.id;
    const res = await call('PUT', '/api/payments/' + payId, { organization_id: ORG_A }, {
      payment_date: '2026-09-04', amount: 50000, method: 'check',
      applications: [{ invoice_id: 'inv-victim2', amount: 50000 }]
    });
    expect(res.status).toBe(404);
    expect(snapshotInvoice('inv-victim2')).toBe(before);
  });
});

// ── PATH I3 — the invoice doors themselves ─────────────────────────────────
// These were ALREADY guarded, by an org-scoped SELECT immediately above each
// write. What was missing was the predicate on the write itself, so the guard
// was one JS line deep — the exact pre-aebad8a8 shape. These tests hold the
// BEHAVIOUR so the second layer can be added without changing it, and so a
// future edit that removes the read guard is caught here rather than in
// production. They passed before the second layer and pass after it; that is
// stated rather than presented as proof of a defect.
describe('PATH I3 — per-invoice doors refuse another tenant\'s invoice and change nothing', () => {
  beforeEach(() => {
    engine.db.prepare(
      `INSERT INTO invoices (id, organization_id, owner_id, status, total, amount_paid, updated_at)
       VALUES ('inv-b', 2, 20, 'sent', 50000, 0, '2026-01-01 00:00:00')`
    ).run();
  });

  test('PUT /invoices/:id', async () => {
    const before = snapshotInvoice('inv-b');
    const res = await call('PUT', '/api/invoices/inv-b', { organization_id: ORG_A },
      { lines: [{ description: 'x', amount: 1 }], tax_pct: 0 });
    expect(res.status).toBe(404);
    expect(snapshotInvoice('inv-b')).toBe(before);
  });

  test('POST /invoices/:id/status', async () => {
    const before = snapshotInvoice('inv-b');
    const res = await call('POST', '/api/invoices/inv-b/status', { organization_id: ORG_A },
      { status: 'void' });
    expect(res.status).toBe(404);
    expect(snapshotInvoice('inv-b')).toBe(before);
  });

  test('DELETE /invoices/:id', async () => {
    const res = await call('DELETE', '/api/invoices/inv-b', { organization_id: ORG_A }, {});
    expect(res.status).toBe(404);
    expect(engine.count("SELECT id FROM invoices WHERE id = 'inv-b'")).toBe(1);
  });
});
