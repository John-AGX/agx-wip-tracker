// DELETING A SUB MUST NOT ORPHAN A POINTER AT IT.
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────
// server/routes/sub-routes.js probed ONE table before deleting:
//
//     SELECT 1 FROM job_subs WHERE sub_id = $1 LIMIT 1
//
// and job_subs is the ONLY one of the four that Postgres already defends:
//
//     server/db.js:1833  job_subs.sub_id            REFERENCES subs(id) ON DELETE RESTRICT
//     server/db.js:845   job_purchase_orders.sub_id TEXT   -- no REFERENCES
//     server/db.js:880   job_vendor_bills.sub_id    TEXT   -- no REFERENCES
//     server/db.js:2481  receipts.sub_id            TEXT   -- no REFERENCES
//
// So the guard duplicated the database and covered nothing. Deleting a sub that
// carried a purchase order, a vendor bill or a receipt left those rows pointing
// at an id that no longer resolves, with no error raised in either layer.
//
// ── WHY THE ORPHAN IS INVISIBLE, WHICH IS WHY THIS IS A TEST AND NOT A NOTE ─
// receipt-routes.js:110 attachSubNames() sets `sub_name` only when the sub row
// still exists. A receipt pointing at a deleted sub therefore renders "—" in
// the Cost Inbox table and in the view modal — the SAME thing "no sub linked"
// renders — and drops out of the Sub/Vendor filter, which matches on
// `r.sub_name`. Nothing anywhere says a pointer broke. That is the
// never-silently-empty failure class, already live.
//
// ── HOW THIS IS PROVED ────────────────────────────────────────────────────
// Against a REAL SQL ENGINE holding the REAL SCHEMA, not a mock. The tables
// come from test/helpers/db-schema.js, which parses server/db.js — so a fixture
// here cannot declare a `sub_id` production does not have, and cannot miss one
// it does. The router is the real router, driven over real HTTP with a real
// signed token through the real capability gate.
//
// The property is never "the response said 409". It is:
//
//     after the call, every pointer row still resolves to a live sub.
//
// A guard that answered 409 and deleted anyway would pass the status assertion
// and fail this one.

const express = require('express');
const http = require('http');

const TWO = require('./helpers/two-org');

let mockEngine;

// The mockEngine is built before the mock is installed, and `../server/db` is
// mocked to hand the ROUTER that same mockEngine as its pool. `pool.connect()` is
// present because other routes in this module use it; the delete path does not.
jest.mock('../server/db', () => ({
  pool: {
    query: (sql, params) => mockEngine.pool.query(sql, params),
    connect: async () => ({
      query: (sql, params) => mockEngine.pool.query(sql, params),
      release: () => {},
    }),
  },
}));

jest.mock('../server/email', () => ({ sendEmail: async () => ({}), sendForEvent: async () => ({}) }));
jest.mock('../server/services/file-folders', () => ({
  ensureFolderChain: async () => ({ id: 'folder_1' }),
}));

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const subRoutes = require('../server/routes/sub-routes');

const ORG_A = TWO.ORG_A;
let server;
let baseUrl;

// ── the world ─────────────────────────────────────────────────────────────
// One sub per scenario, each named for the ONE pointer that holds it, so a
// failure message says which table the guard forgot. The generic two-org seed
// already put a row in all four pointer tables, but their sub_id values are
// free text ('A-receipts-sub_id'), so they cannot collide with these ids —
// which is itself worth having: it means a guard that matched everything
// would refuse the clean case and be caught by the first test.
const SUBS = {
  clean: 'sub_nothing_points_here',
  receipt: 'sub_has_a_receipt',
  po: 'sub_has_a_po',
  bill: 'sub_has_a_bill',
  assignment: 'sub_has_an_assignment',
  both: 'sub_has_a_receipt_and_a_bill',
};

async function seedWorld() {
  for (const id of Object.values(SUBS)) {
    await mockEngine.pool.query('INSERT INTO subs (id, organization_id, name, status) VALUES ($1,$2,$3,$4)',
      [id, ORG_A, 'Vendor ' + id, 'active']);
  }
  // A receipt with money and a cost code on it — the row the orphan hides in.
  await mockEngine.pool.query(
    'INSERT INTO receipts (id, organization_id, sub_id, vendor, amount, cost_code, status, entity_type, entity_id)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    ['rcpt_guard_1', ORG_A, SUBS.receipt, 'HOME DEPOT #0242', 412.66, 'materials', 'processed', 'job', 'jobs-A-0']);
  await mockEngine.pool.query(
    'INSERT INTO receipts (id, organization_id, sub_id, vendor, amount, cost_code, status)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7)',
    ['rcpt_guard_2', ORG_A, SUBS.both, 'WHITE CAP', 88.10, 'materials', 'processed']);
  await mockEngine.pool.query(
    'INSERT INTO job_purchase_orders (id, job_id, organization_id, sub_id, status, po_number)'
    + ' VALUES ($1,$2,$3,$4,$5,$6)',
    ['po_guard_1', 'jobs-A-0', ORG_A, SUBS.po, 'issued', 'PO-1001']);
  await mockEngine.pool.query(
    'INSERT INTO job_vendor_bills (id, job_id, organization_id, sub_id, status, amount)'
    + ' VALUES ($1,$2,$3,$4,$5,$6)',
    ['bill_guard_1', 'jobs-A-0', ORG_A, SUBS.bill, 'open', 2904.00]);
  await mockEngine.pool.query(
    'INSERT INTO job_vendor_bills (id, job_id, organization_id, sub_id, status, amount)'
    + ' VALUES ($1,$2,$3,$4,$5,$6)',
    ['bill_guard_2', 'jobs-A-0', ORG_A, SUBS.both, 'open', 51.25]);
  await mockEngine.pool.query(
    'INSERT INTO job_subs (id, job_id, sub_id, organization_id) VALUES ($1,$2,$3,$4)',
    ['jsub_guard_1', 'jobs-A-0', SUBS.assignment, ORG_A]);
}

beforeAll(async () => {
  mockEngine = TWO.buildEngine({
    overlay: {
      // The caller's role. The generic seed gives roles free-text names and an
      // empty capability array, which would 403 every call in this file.
      roles: [{ name: 'admin', label: 'Admin', capabilities: JSON.stringify(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY']) }],
    },
  });
  await seedWorld();
  setRolePool({ query: (sql, params) => mockEngine.pool.query(sql, params) });
  await refreshRoleCache();

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/subs', subRoutes);
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      done();
    });
  });
});

afterAll((done) => {
  server.close(() => { mockEngine.close(); done(); });
});

function token(over) {
  return signToken(Object.assign(
    { id: 101, email: 'a@a.test', role: 'admin', name: 'A', organization_id: ORG_A }, over || {}));
}

async function del(id, over) {
  const res = await fetch(baseUrl + '/api/subs/' + id, {
    method: 'DELETE',
    headers: { authorization: 'Bearer ' + token(over), connection: 'close' },
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body };
}

function subExists(id) {
  return mockEngine.all('SELECT id FROM subs WHERE id = ?', id).length === 1;
}

// THE PROPERTY, stated once and reused: no row in any of the four pointer
// tables names a sub id that has no row in `subs`. Derived from the same four
// tables the guard covers, so a table added to the guard without being added
// here is not silently unproved — it fails the coverage test at the bottom.
function orphanedPointers() {
  const out = [];
  for (const t of ['job_subs', 'job_purchase_orders', 'job_vendor_bills', 'receipts']) {
    const rows = mockEngine.all(
      'SELECT id, sub_id FROM ' + t + " WHERE sub_id IS NOT NULL AND sub_id <> ''"
      + ' AND sub_id NOT IN (SELECT id FROM subs)');
    rows.forEach((r) => out.push(t + '.' + r.id + ' -> ' + r.sub_id));
  }
  return out;
}

// The generic two-org seed plants a row in each pointer table whose sub_id is
// free text pointing at nothing. Those are seed artefacts, not defects, so the
// property is measured as a DELTA against the world before any call is made.
let seedOrphans;
beforeAll(() => { seedOrphans = orphanedPointers(); });

function newOrphans() {
  const before = new Set(seedOrphans);
  return orphanedPointers().filter((o) => !before.has(o));
}

describe('a sub nothing points at still deletes', () => {
  test('DELETE succeeds and the row is gone', async () => {
    // Guards fail in two directions. A guard that refused everything would make
    // every assertion below pass while breaking the feature.
    const r = await del(SUBS.clean);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, deleted: 1 });
    expect(subExists(SUBS.clean)).toBe(false);
    expect(newOrphans()).toEqual([]);
  });
});

describe('each of the four pointers refuses the delete, by itself', () => {
  // Per-table, never a rate. Three of these four were unguarded, and a summary
  // number cannot say which.
  const cases = [
    ['receipts', SUBS.receipt, 'receipt'],
    ['job_purchase_orders', SUBS.po, 'purchase order'],
    ['job_vendor_bills', SUBS.bill, 'vendor bill'],
    ['job_subs', SUBS.assignment, 'job assignment'],
  ];

  test.each(cases)('%s holds the sub: nothing orphaned, sub survives, 409', async (table, subId, label) => {
    const r = await del(subId);

    // THE DEFECT FIRST, so the failure message names it. Asserting the status
    // ahead of this made the pre-fix run say "expected 409, received 200",
    // which is a fact about an HTTP code; the fact worth reporting is that a
    // row carrying money now points at an id nothing resolves.
    expect(newOrphans()).toEqual([]);
    // The sub is STILL THERE. This is the assertion a guard that answered 409
    // and deleted anyway would fail.
    expect(subExists(subId)).toBe(true);
    expect(r.status).toBe(409);
    // And the refusal NAMES what is holding it. "Assigned to one or more jobs"
    // sent someone to unassign a job that was never the reason.
    expect(String(r.body && r.body.error)).toContain(label);
    expect(r.body.in_use).toEqual([{ label: label, n: 1 }]);
  });
});

describe('the refusal is legible when more than one thing holds it', () => {
  test('a sub with a receipt AND a bill names both', async () => {
    const r = await del(SUBS.both);
    expect(r.status).toBe(409);
    expect(subExists(SUBS.both)).toBe(true);
    const labels = (r.body.in_use || []).map((h) => h.label).sort();
    expect(labels).toEqual(['receipt', 'vendor bill']);
    expect(String(r.body.error)).toMatch(/1 vendor bill/);
    expect(String(r.body.error)).toMatch(/1 receipt/);
    // It says what to do instead, and the alternative is real: `status` is a
    // column on subs and 'closed' is what the old message already recommended.
    expect(String(r.body.error)).toMatch(/closed/);
  });
});

describe('the tenant boundary is unchanged by the widening', () => {
  test("another org's sub answers 404 and is not deleted", async () => {
    // Absent and foreign are deliberately indistinguishable — see notYours().
    const foreign = TWO.idFor('subs', 'B');
    const r = await del(foreign);
    expect(r.status).toBe(404);
    expect(subExists(foreign)).toBe(true);
  });

  test('a sub id that does not exist at all answers the same 404', async () => {
    const r = await del('sub_no_such_row');
    expect(r.status).toBe(404);
  });

  test('the ownership proof runs BEFORE the in-use probe', async () => {
    // Otherwise 409-vs-404 on a foreign id is a cross-tenant existence oracle:
    // "does org B's sub have work?" answered without any read of org B.
    const foreign = TWO.idFor('subs', 'B');
    const r = await del(foreign);
    expect(r.status).not.toBe(409);
  });
});

describe('the guard covers every loose pointer the schema declares', () => {
  test('no table in server/db.js has an unguarded sub_id money pointer', () => {
    // DERIVED, not typed. If someone adds `sub_id` to a new table, this names
    // it rather than letting the guard silently fall behind the schema — the
    // exact way this defect was born.
    const { tableColumns } = require('./helpers/db-schema');
    const { tables } = tableColumns();
    const withSubId = [];
    for (const [t, cols] of tables) {
      if (cols.has('sub_id')) withSubId.push(t);
    }
    expect(withSubId.sort()).toEqual([
      // guarded by the delete probe:
      'job_purchase_orders', 'job_subs', 'job_vendor_bills', 'receipts',
      // NOT guarded, and named rather than filtered:
      //   sub_certificates / sub_invites / attachment_folder_grants / users
      //     all carry REFERENCES subs(id) ON DELETE CASCADE — the database
      //     removes them, so there is no pointer left to dangle. (users.sub_id
      //     cascading means deleting a sub deletes its portal login; that is a
      //     product question, not an orphan, and it is unchanged here.)
      //   task_shares.sub_id is loose but is PROVENANCE, not money: the token
      //     is the access and the share keeps working. Blocking a delete on an
      //     expired share link would be a new refusal, not a fixed one.
      'attachment_folder_grants', 'sub_certificates', 'sub_invites', 'task_shares', 'users',
    ].sort());
  });

  test('the probe reads all four tables in one statement', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'sub-routes.js'), 'utf8');
    const block = src.slice(src.indexOf('const SUB_POINTERS'), src.indexOf('function plural('));
    for (const t of ['job_subs', 'job_purchase_orders', 'job_vendor_bills', 'receipts']) {
      expect(block).toContain(t);
    }
  });
});
