// The tenant boundary on PAYMENTS, and the regression that closing it shipped.
//
// WHAT THIS FILE IS FOR
// Commit a21563bb closed a real cross-tenant write on AR: an org-A payment
// could move `amount_paid` / `status` / `paid_at` on an org-B invoice, in
// either direction, answering 200. The guard it added asked one question of
// every invoice id on a payment's `applications[]` — "is this one the
// caller's?" — and refused the request when the answer was no.
//
// That question folds together two facts that are not the same fact:
//   FOREIGN  a row exists and belongs to another tenant.
//   ABSENT   no row exists in any tenant.
// and the conflation shipped a REGRESSION. `PUT /payments/:id` falls back to
// the payment's STORED applications[] when the body omits them, so a payment
// whose history names a DELETED invoice could no longer have its DATE or its
// NOTE changed: refused 404 over an id the caller never sent. Worse, it was a
// deadlock — removing the dead application requires a PUT that SUPPLIES
// applications, and that request was refused for the same reason. Measured
// across the two builds: pre-fix 200 and applied, post-fix 404 and refused.
//
// THE PROPERTIES, stated as properties rather than as cases:
//   P1  For ANY caller and ANY row: a payment write lands only where the
//       caller owns the payment, or the payment is legacy NULL-org. Every
//       other pairing leaves the row byte-identical.
//   P2  An application naming a FOREIGN invoice is refused, visibly, naming
//       the id — never a 200 with the application quietly dropped.
//   P3  An ABSENT id is TOLERATED where absence is legitimate: when it was
//       carried forward out of the row's own stored history rather than
//       supplied by this request. Editing an unrelated field must land.
//   P4  Legacy NULL-org rows still work, on both the payment and the invoice.
//   P5  Foreign and absent are INDISTINGUISHABLE on the wire wherever a
//       refusal is issued, so this does not become an existence oracle over
//       other tenants' invoices.
//   P6  A refused write moves no money anywhere — asserted on the invoice
//       rows, not on the response.
//
// EVIDENCE STANDARD. The real router, on real express, behind real
// requireAuth / requireCapability / requireOrgId, driven over real HTTP with a
// real JWT, against the repo's SQLite-backed engine (test/helpers/pg-sqlite.js)
// so the WHERE clauses are evaluated rather than mocked. Every assertion reads
// the DATABASE after the call, never the response body: a 200 that wrote
// nothing and a 200 that wrote are identical from the response alone.

'use strict';

const express = require('express');
const http = require('http');

const { createPgSqlite } = require('./helpers/pg-sqlite');

const SCHEMA = `
  CREATE TABLE organizations (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT, organization_id INTEGER);
  CREATE TABLE roles (name TEXT PRIMARY KEY, label TEXT, capabilities TEXT);
  CREATE TABLE jobs (id TEXT PRIMARY KEY, organization_id INTEGER, data TEXT);
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

// ONE engine for the file, created before the router is required.
// invoice-routes.js destructures `pool` at module load and holds that object
// for the life of the process, so a per-test engine would leave the route
// writing to one database while the assertions read another — every write
// would look refused and this file would report a green boundary on a database
// nobody wrote to. Rows are cleared between tests instead.
//
// `data` must decode as a PARSED OBJECT, the way the pg driver hands back
// jsonb: recomputeInvoicePaid reads `r.data.applications` off a payments row,
// and as raw text that silently reads as "no applications" — every money
// assertion here would then pass for the wrong reason.
const engine = createPgSqlite(SCHEMA, { jsonColumns: ['data'] });
globalThis.__P86_PAY_ENGINE__ = engine;

jest.mock('../server/db', () => ({ pool: globalThis.__P86_PAY_ENGINE__.pool }));

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const invoiceRoutes = require('../server/routes/invoice-routes');

let server, baseUrl;

const ORG_A = 1;
const ORG_B = 2;

function seed() {
  engine.db.exec(`
    DELETE FROM invoices; DELETE FROM payments; DELETE FROM jobs;
    DELETE FROM users; DELETE FROM roles; DELETE FROM organizations;
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

function seedInvoice(id, orgId, opts) {
  const o = opts || {};
  engine.db.prepare(
    `INSERT INTO invoices (id, organization_id, owner_id, status, total, amount_paid, paid_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, orgId == null ? null : orgId, 20, o.status || 'sent',
        o.total == null ? 50000 : o.total, o.paid || 0,
        o.paidAt || null, '2026-01-01 00:00:00');
}

function seedPayment(id, orgId, apps, opts) {
  const o = opts || {};
  engine.db.prepare(
    `INSERT INTO payments (id, organization_id, owner_id, client_id, payment_date, amount, method, reference, data, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, orgId == null ? null : orgId, 10, o.clientId || 'c1',
        o.date || '2026-03-01', o.amount == null ? 100 : o.amount,
        o.method || 'check', o.reference || 'REF-1',
        JSON.stringify({ applications: apps || [], notes: o.notes || 'original note' }),
        '2026-01-01 00:00:00');
}

// The WHOLE row as text, in a stable column order — "nothing changed" has to
// mean every column, not just the one the test happens to look at.
function snapshotInvoice(id) {
  return JSON.stringify(engine.db.prepare(
    `SELECT id, organization_id, status, total, amount_paid, paid_at, updated_at
       FROM invoices WHERE id = ?`).all(id));
}
function snapshotPayment(id) {
  return JSON.stringify(engine.db.prepare(
    `SELECT id, organization_id, owner_id, client_id, payment_date, amount,
            method, reference, data, updated_at
       FROM payments WHERE id = ?`).all(id));
}
function paymentData(id) {
  const r = engine.db.prepare('SELECT data FROM payments WHERE id = ?').all(id);
  return r.length ? JSON.parse(r[0].data) : null;
}

function tokenFor(user) {
  return signToken(Object.assign(
    { id: 10, email: 'a@a.a', role: 'admin', name: 'A', organization_id: ORG_A }, user));
}

async function call(method, path, user, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tokenFor(user) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body: json };
}

const A_ADMIN = { id: 10, role: 'admin', organization_id: ORG_A };
const A_CREW = { id: 11, role: 'field_crew', organization_id: ORG_A };

beforeAll((done) => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', invoiceRoutes);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = 'http://127.0.0.1:' + server.address().port;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => seed());

// ── PATH P1 — PUT /api/payments/:id, the regression ────────────────────────
describe('PATH P1 — PUT /payments/:id: an id the caller never sent cannot block the edit', () => {
  // The exact shape a21563bb broke, and the reason the two facts are split.
  test('a note edit lands on a payment whose history names a DELETED invoice', async () => {
    seedPayment('pay-1', ORG_A, [{ invoice_id: 'inv-deleted', amount: 100 }]);
    // inv-deleted is seeded nowhere: ABSENT, not foreign.
    const res = await call('PUT', '/api/payments/pay-1', A_ADMIN, {
      payment_date: '2026-03-01', amount: 100, method: 'check',
      reference: 'REF-1', notes: 'corrected note'
    });
    expect(res.status).toBe(200);
    // Read the DATABASE. A 200 proves nothing on its own.
    const d = paymentData('pay-1');
    expect(d.notes).toBe('corrected note');
    // …and the stored application was carried forward verbatim, not scrubbed.
    // Silently rewriting someone's money record to make a guard pass is a
    // worse answer than leaving it visible.
    expect(d.applications).toEqual([{ invoice_id: 'inv-deleted', amount: 100 }]);
  });

  test('a date edit lands too — the tolerance is not special-cased to notes', async () => {
    seedPayment('pay-2', ORG_A, [{ invoice_id: 'inv-gone', amount: 250 }]);
    const res = await call('PUT', '/api/payments/pay-2', A_ADMIN, {
      payment_date: '2026-04-15', amount: 250, method: 'ach', reference: 'R2'
    });
    expect(res.status).toBe(200);
    const row = engine.db.prepare('SELECT payment_date d, method m FROM payments WHERE id = ?').all('pay-2')[0];
    expect(row.d).toBe('2026-04-15');
    expect(row.m).toBe('ach');
  });

  test('the deadlock is gone: the dead application can now be cleared explicitly', async () => {
    // `applications: []` is a SUPPLIED value, not an omission, so it is
    // validated — and an empty set has nothing to refuse.
    seedPayment('pay-3', ORG_A, [{ invoice_id: 'inv-gone', amount: 250 }]);
    const res = await call('PUT', '/api/payments/pay-3', A_ADMIN, {
      payment_date: '2026-04-15', amount: 250, applications: []
    });
    expect(res.status).toBe(200);
    expect(paymentData('pay-3').applications).toEqual([]);
  });

  test('a carried-forward FOREIGN id also does not block an unrelated edit, and moves no money', async () => {
    // A legacy payment can carry a pointer written before the guard existed.
    // Tolerating it is safe rather than lucky: recomputeInvoicePaid carries
    // the org predicate on BOTH its statements, so a foreign id matches no row.
    seedInvoice('inv-b', ORG_B, { status: 'sent', paid: 0 });
    seedPayment('pay-4', ORG_A, [{ invoice_id: 'inv-b', amount: 50000 }]);
    const before = snapshotInvoice('inv-b');
    const res = await call('PUT', '/api/payments/pay-4', A_ADMIN, {
      payment_date: '2026-05-01', amount: 50000, notes: 'edited'
    });
    expect(res.status).toBe(200);
    expect(paymentData('pay-4').notes).toBe('edited');
    // P6 — the victim invoice is byte-identical.
    expect(snapshotInvoice('inv-b')).toBe(before);
  });
});

// ── PATH P2 — the refusals that must stay ──────────────────────────────────
describe('PATH P2 — a SUPPLIED id is an assertion and is checked', () => {
  test('PUT supplying a FOREIGN invoice is refused, names it, and moves nothing', async () => {
    seedInvoice('inv-victim', ORG_B, { status: 'sent', paid: 0 });
    seedPayment('pay-5', ORG_A, []);
    const beforeInv = snapshotInvoice('inv-victim');
    const beforePay = snapshotPayment('pay-5');
    const res = await call('PUT', '/api/payments/pay-5', A_ADMIN, {
      payment_date: '2026-05-01', amount: 50000,
      applications: [{ invoice_id: 'inv-victim', amount: 50000 }]
    });
    expect(res.status).toBe(404);
    expect(res.body.invoice_ids).toEqual(['inv-victim']);
    expect(snapshotInvoice('inv-victim')).toBe(beforeInv);
    // "Nothing was changed" has to be true of the payment as well.
    expect(snapshotPayment('pay-5')).toBe(beforePay);
  });

  test('POST naming a FOREIGN invoice records no payment and moves nothing', async () => {
    seedInvoice('inv-victim', ORG_B, { status: 'paid', paid: 50000, paidAt: '2026-02-02' });
    const before = snapshotInvoice('inv-victim');
    const res = await call('POST', '/api/payments', A_ADMIN, {
      payment_date: '2026-09-04', amount: 0, method: 'check',
      applications: [{ invoice_id: 'inv-victim', amount: 0 }]
    });
    expect(res.status).toBe(404);
    expect(snapshotInvoice('inv-victim')).toBe(before);
    expect(engine.count('SELECT id FROM payments')).toBe(0);
  });

  test('POST naming an ABSENT invoice is refused too — the decision, pinned', async () => {
    // DELIBERATE, and recorded here so it cannot drift back by accident.
    // Every id on a POST was typed by the caller a moment ago, so refusing is
    // visible and actionable, and recording an inert application against a
    // ghost is the same "cash looks applied, invoice stays open" failure the
    // foreign case refuses. Pre-a21563bb this recorded the payment with a dead
    // application; that is NOT restored.
    const res = await call('POST', '/api/payments', A_ADMIN, {
      payment_date: '2026-09-04', amount: 500,
      applications: [{ invoice_id: 'inv-never-existed', amount: 500 }]
    });
    expect(res.status).toBe(404);
    expect(engine.count('SELECT id FROM payments')).toBe(0);
  });

  // P5 — the oracle property. The split between foreign and absent drives
  // POLICY inside the server; it must not be readable from outside, or the
  // refusal answers "does invoice X exist in some other tenant?".
  test('P5 — foreign and absent are indistinguishable on the wire', async () => {
    seedInvoice('inv-foreign', ORG_B);
    const foreign = await call('POST', '/api/payments', A_ADMIN, {
      payment_date: '2026-09-04', amount: 1,
      applications: [{ invoice_id: 'inv-foreign', amount: 1 }]
    });
    const absent = await call('POST', '/api/payments', A_ADMIN, {
      payment_date: '2026-09-04', amount: 1,
      applications: [{ invoice_id: 'inv-absent', amount: 1 }]
    });
    expect(foreign.status).toBe(absent.status);
    // Same sentence, with only the id differing.
    expect(foreign.body.error.replace('inv-foreign', 'ID'))
      .toBe(absent.body.error.replace('inv-absent', 'ID'));
    expect(Object.keys(foreign.body).sort()).toEqual(Object.keys(absent.body).sort());
  });
});

// ── PATH P2b — the half of the deadlock that was still open ───────────────
// The tolerance a21563bb added applied only to the CARRIED-FORWARD set, i.e.
// to a body that OMITS applications. That is not the shape the client sends:
// js/api.js's payments.update posts the whole array back, dead ids included,
// because it round-trips what it loaded. So the deadlock survived on the only
// door a UI has — supply the array and the absent id is refused; omit it and
// the dead id can never be removed. Nothing calls payments.update yet, which
// is the only reason it was not a live incident, and is exactly what makes it
// a trap for whoever wires that button.
//
// The rule, stated once: REFUSE FOREIGN ALWAYS; refuse ABSENT only when the id
// is NOT already in the row's stored set.
describe('PATH P2b — an ABSENT id already ON the row survives being sent back', () => {
  test('supplying an already-stored ABSENT id lets the edit land', async () => {
    // The payment's history names an invoice that no longer exists anywhere —
    // the state PATH P5's delete test reaches legitimately, without touching
    // another tenant.
    seedPayment('pay-dl', ORG_A, [{ invoice_id: 'inv-gone', amount: 0 }]);
    const res = await call('PUT', '/api/payments/pay-dl', A_ADMIN, {
      payment_date: '2026-09-06', amount: 0, notes: 'note edited via the real client shape',
      applications: [{ invoice_id: 'inv-gone', amount: 0 }]
    });
    expect(res.status).toBe(200);
    expect(paymentData('pay-dl').notes).toBe('note edited via the real client shape');
  });

  test('…and the dead application can finally be REMOVED', async () => {
    // The other half of the deadlock: escaping the state at all. Before, the
    // request that drops the dead id was refused because it had to supply the
    // array that still contained it.
    seedPayment('pay-dl2', ORG_A, [{ invoice_id: 'inv-gone', amount: 0 }]);
    const res = await call('PUT', '/api/payments/pay-dl2', A_ADMIN, {
      payment_date: '2026-09-06', amount: 0, applications: []
    });
    expect(res.status).toBe(200);
    expect(paymentData('pay-dl2').applications).toEqual([]);
  });

  test('an ABSENT id the caller INVENTS is still refused', async () => {
    // The tolerance is for ids the row already carries, never for new ones.
    // A silently inert application against a ghost is the "cash looks applied,
    // invoice stays open" failure the whole guard exists for.
    seedPayment('pay-dl3', ORG_A, [{ invoice_id: 'inv-gone', amount: 0 }]);
    const before = snapshotPayment('pay-dl3');
    const res = await call('PUT', '/api/payments/pay-dl3', A_ADMIN, {
      payment_date: '2026-09-06', amount: 10,
      applications: [{ invoice_id: 'inv-gone', amount: 0 }, { invoice_id: 'inv-invented', amount: 10 }]
    });
    expect(res.status).toBe(404);
    expect(res.body.invoice_ids).toEqual(['inv-invented']);
    expect(snapshotPayment('pay-dl3')).toBe(before);
  });

  test('a FOREIGN id already ON the row is STILL refused — the tolerance is absence, not history', async () => {
    // The line that must not move. "Already stored" is not a laundering
    // mechanism: a row that exists and belongs to another tenant is never
    // applicable, however it got onto this payment.
    seedInvoice('inv-b-live', ORG_B, { status: 'sent', paid: 0 });
    seedPayment('pay-dl4', ORG_A, [{ invoice_id: 'inv-b-live', amount: 0 }]);
    const beforeInv = snapshotInvoice('inv-b-live');
    const beforePay = snapshotPayment('pay-dl4');
    const res = await call('PUT', '/api/payments/pay-dl4', A_ADMIN, {
      payment_date: '2026-09-06', amount: 999,
      applications: [{ invoice_id: 'inv-b-live', amount: 999 }]
    });
    expect(res.status).toBe(404);
    expect(res.body.invoice_ids).toEqual(['inv-b-live']);
    expect(snapshotInvoice('inv-b-live')).toBe(beforeInv);
    expect(snapshotPayment('pay-dl4')).toBe(beforePay);
  });

  test('the refusal still says the same thing for foreign and for invented-absent', async () => {
    // P5 again, on the new arm: the policy split must stay invisible.
    seedInvoice('inv-b-live2', ORG_B);
    seedPayment('pay-dl5', ORG_A, []);
    seedPayment('pay-dl6', ORG_A, []);
    const foreign = await call('PUT', '/api/payments/pay-dl5', A_ADMIN, {
      payment_date: '2026-09-06', amount: 1, applications: [{ invoice_id: 'inv-b-live2', amount: 1 }]
    });
    const absent = await call('PUT', '/api/payments/pay-dl6', A_ADMIN, {
      payment_date: '2026-09-06', amount: 1, applications: [{ invoice_id: 'inv-nowhere', amount: 1 }]
    });
    expect(foreign.status).toBe(absent.status);
    expect(foreign.body.error.replace('inv-b-live2', 'ID'))
      .toBe(absent.body.error.replace('inv-nowhere', 'ID'));
  });
});

// ── PATH P3 — the payment row's own tenancy, over a matrix ─────────────────
describe('PATH P3 — PUT / DELETE /payments/:id land only on the caller\'s own rows', () => {
  const CALLERS = [
    { label: 'org-A admin', user: A_ADMIN },
    { label: 'org-A field_crew', user: A_CREW },
  ];
  const ROWS = [
    { label: 'payment in the caller\'s own org', org: ORG_A, mustWrite: true },
    { label: 'payment in ANOTHER tenant', org: ORG_B, mustWrite: false },
    { label: 'legacy NULL-org payment', org: null, mustWrite: true },
  ];

  CALLERS.forEach((c) => ROWS.forEach((r) => {
    test(`PUT — ${c.label} × ${r.label}`, async () => {
      seedPayment('pay-m', r.org, []);
      const before = snapshotPayment('pay-m');
      const res = await call('PUT', '/api/payments/pay-m', c.user, {
        payment_date: '2026-12-31', amount: 999, method: 'wire', notes: 'touched'
      });
      const after = snapshotPayment('pay-m');
      if (r.mustWrite) {
        expect(res.status).toBe(200);
        expect(after).not.toBe(before);
        expect(paymentData('pay-m').notes).toBe('touched');
      } else {
        // Visibly refused, and byte-identical afterwards.
        expect(res.status).toBe(404);
        expect(after).toBe(before);
      }
    });

    test(`DELETE — ${c.label} × ${r.label}`, async () => {
      seedPayment('pay-d', r.org, []);
      const res = await call('DELETE', '/api/payments/pay-d', c.user, {});
      const left = engine.count("SELECT id FROM payments WHERE id = 'pay-d'");
      if (r.mustWrite) {
        expect(res.status).toBe(200);
        expect(left).toBe(0);
      } else {
        expect(res.status).toBe(404);
        expect(left).toBe(1);
      }
    });
  }));
});

// ── PATH P4 — the controls ─────────────────────────────────────────────────
// A boundary test that only ever asserts refusal passes just as well against a
// route that refuses everything. These say the door still opens.
describe('PATH P4 — the money still moves where it is supposed to', () => {
  test('an org-A payment settles an org-A invoice', async () => {
    seedInvoice('inv-ours', ORG_A);
    const res = await call('POST', '/api/payments', A_ADMIN, {
      payment_date: '2026-09-04', amount: 50000, method: 'check',
      applications: [{ invoice_id: 'inv-ours', amount: 50000 }]
    });
    expect(res.status).toBe(200);
    const row = engine.db.prepare('SELECT status s, amount_paid p FROM invoices WHERE id = ?').all('inv-ours')[0];
    expect(row.s).toBe('paid');
    expect(Number(row.p)).toBe(50000);
  });

  test('a legacy NULL-org invoice still settles — the tolerance arm is preserved', async () => {
    seedInvoice('inv-legacy', null);
    const res = await call('POST', '/api/payments', A_ADMIN, {
      payment_date: '2026-09-04', amount: 50000, method: 'check',
      applications: [{ invoice_id: 'inv-legacy', amount: 50000 }]
    });
    expect(res.status).toBe(200);
    expect(engine.db.prepare('SELECT status s FROM invoices WHERE id = ?').all('inv-legacy')[0].s).toBe('paid');
  });

  test('re-applying a payment across its own invoices still recomputes both', async () => {
    seedInvoice('inv-x', ORG_A, { total: 100 });
    seedInvoice('inv-y', ORG_A, { total: 100 });
    const create = await call('POST', '/api/payments', A_ADMIN, {
      payment_date: '2026-09-04', amount: 100,
      applications: [{ invoice_id: 'inv-x', amount: 100 }]
    });
    expect(create.status).toBe(200);
    const payId = create.body.payment.id;
    expect(engine.db.prepare('SELECT status s FROM invoices WHERE id = ?').all('inv-x')[0].s).toBe('paid');
    // Move the whole application from x to y.
    const res = await call('PUT', '/api/payments/' + payId, A_ADMIN, {
      payment_date: '2026-09-04', amount: 100,
      applications: [{ invoice_id: 'inv-y', amount: 100 }]
    });
    expect(res.status).toBe(200);
    // BOTH ends recomputed: x released, y settled.
    expect(engine.db.prepare('SELECT status s, amount_paid p FROM invoices WHERE id = ?').all('inv-x')[0].s).toBe('sent');
    expect(Number(engine.db.prepare('SELECT amount_paid p FROM invoices WHERE id = ?').all('inv-x')[0].p)).toBe(0);
    expect(engine.db.prepare('SELECT status s FROM invoices WHERE id = ?').all('inv-y')[0].s).toBe('paid');
  });
});

// ── PATH P5 — orphaning, which is what makes P1 reachable at all ───────────
describe('PATH P5 — an application can still be orphaned, by a route that is not the one blamed', () => {
  // The sweep that commissioned this work named services/job-financials.js
  // deleteInvoice as the orphan source, on the grounds that it blocks status
  // 'paid' but not amount_paid > 0. READ AT THE LINE: it blocks BOTH (the
  // amount_paid check sits immediately above the status check), and so does
  // DELETE /invoices/:id. That specific claim is REFUTED.
  //
  // Orphaning is reachable anyway, and this is the path: an application for
  // ZERO leaves amount_paid at 0, which passes both delete guards while the
  // payment still names the invoice. That is what produces the stored-but-
  // dangling application PATH P1 is about, so it is executed here rather than
  // assumed — a regression test whose premise is only hypothetical is a test
  // that can quietly stop testing anything.
  test('a zero-amount application leaves the invoice deletable, and the pointer dangles', async () => {
    seedInvoice('inv-z', ORG_A, { total: 100 });
    const create = await call('POST', '/api/payments', A_ADMIN, {
      payment_date: '2026-09-04', amount: 0,
      applications: [{ invoice_id: 'inv-z', amount: 0 }]
    });
    expect(create.status).toBe(200);
    const payId = create.body.payment.id;
    expect(Number(engine.db.prepare('SELECT amount_paid p FROM invoices WHERE id = ?').all('inv-z')[0].p)).toBe(0);

    // Both delete guards pass, because amount_paid is 0 and status is not paid.
    const del = await call('DELETE', '/api/invoices/inv-z', A_ADMIN, {});
    expect(del.status).toBe(200);
    expect(engine.count("SELECT id FROM invoices WHERE id = 'inv-z'")).toBe(0);

    // The payment now names an invoice that does not exist — ABSENT, and
    // reached without touching another tenant. Editing it must still work.
    expect(paymentData(payId).applications).toEqual([{ invoice_id: 'inv-z', amount: 0 }]);
    const edit = await call('PUT', '/api/payments/' + payId, A_ADMIN, {
      payment_date: '2026-09-05', amount: 0, notes: 'reconciled'
    });
    expect(edit.status).toBe(200);
    expect(paymentData(payId).notes).toBe('reconciled');
  });

  test('an invoice WITH money applied still refuses to be deleted', async () => {
    // The control for the refutation above: the guard the sweep thought was
    // missing is present and works.
    seedInvoice('inv-paid', ORG_A, { total: 100 });
    const create = await call('POST', '/api/payments', A_ADMIN, {
      payment_date: '2026-09-04', amount: 100,
      applications: [{ invoice_id: 'inv-paid', amount: 100 }]
    });
    expect(create.status).toBe(200);
    const del = await call('DELETE', '/api/invoices/inv-paid', A_ADMIN, {});
    expect(del.status).toBe(409);
    expect(engine.count("SELECT id FROM invoices WHERE id = 'inv-paid'")).toBe(1);
  });
});
