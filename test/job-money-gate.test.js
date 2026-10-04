/* WHO MAY APPROVE A VENDOR BILL.
 *
 * Until 1.92, POST /api/bills/:id/status was gated on ESTIMATES_EDIT and
 * nothing else — no ownership check, no threshold, no separation of duties.
 * ESTIMATES_EDIT is held by the builtin field_crew role, whose own description
 * reads "Estimates and Cost Inbox only. NO JOBS, NO FINANCIALS." So the field
 * crew could approve a vendor bill for payment, mark it paid, or void it, on
 * any job in the organisation — and edit the amount first, because the same
 * capability opens all three doors.
 *
 * Nothing caught it because NOTHING IN THIS REPOSITORY PINS WHICH CAPABILITY
 * GATES WHICH ROUTE. That is the gap this file closes for the money doors: the
 * capability matrix is asserted from the seeded roles and from the route source,
 * so widening a gate has to come through here and say so.
 *
 * Two properties are asserted, and they are different:
 *
 *   THE RULE — a status move needs JOBS_EDIT_ANY, or you own the job. Driven
 *   through the real Express handler with real role rows, not by reading source.
 *
 *   THE SHAPE — the gate can only ever REMOVE access: requireCapability
 *   (ESTIMATES_EDIT) is still the outer door, so no role that was locked out
 *   yesterday is admitted today. A fix that accidentally GRANTS is the one
 *   failure mode worse than the bug.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
// liveLines: a needle that a commented-out line does NOT satisfy.
const { liveLines } = require('./helpers/live-line');

let tables;

jest.mock('../server/db', () => ({
  pool: { query: async (sql, params) => mockRunQuery(sql, params) },
}));
jest.mock('../server/email', () => ({
  isEnabled: () => true,
  sendEmail: async () => ({ ok: true }),
  sendForEvent: async () => ({ skipped: true }),
}));
jest.mock('../server/push', () => ({ sendPush: async () => ({ sent: 0 }) }));

function rowsOf(n) { return tables[n] || []; }
function orgOk(row, orgId) { return row.organization_id == null || String(row.organization_id) === String(orgId); }

function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];

  // The role cache the auth helper reads capabilities from.
  if (/FROM roles/.test(text)) return { rows: rowsOf('roles') };

  if (/^SELECT b\.status, b\.job_id, j\.owner_id, ja\.access_level FROM job_vendor_bills b JOIN jobs j/.test(text)) {
    const b = rowsOf('bills').find((x) => String(x.id) === String(p[0]));
    if (!b) return { rows: [], rowCount: 0 };
    const j = rowsOf('jobs').find((x) => String(x.id) === String(b.job_id));
    if (!j || !orgOk(j, p[1])) return { rows: [], rowCount: 0 };
    // The LEFT JOIN on job_access, served OFF THE STATEMENT: $3 is the caller,
    // and a job they hold no grant on yields NULL, exactly as Postgres would.
    //
    // The user predicate is read from the SQL rather than applied on this
    // mock's own authority. Applying it regardless made "the join loses its
    // user predicate" invisible — a mutation that would let ANYBODY'S grant on
    // a job admit ANY caller. Same discipline as the org terms in
    // money-notices.test.js.
    const byUser = /ja\.user_id = \$3/.test(text);
    const g = rowsOf('grants').find((x) => String(x.job_id) === String(b.job_id)
      && (!byUser || Number(x.user_id) === Number(p[2])));
    return { rows: [{ status: b.status, job_id: b.job_id, owner_id: j.owner_id,
      access_level: g ? g.access_level : null }], rowCount: 1 };
  }
  if (/^UPDATE job_vendor_bills SET status = \$1/.test(text)) {
    const b = rowsOf('bills').find((x) => String(x.id) === String(p[3]));
    if (!b) return { rows: [], rowCount: 0 };
    b.status = p[0];
    b.approved_by = b.approved_by == null && (p[0] === 'approved' || p[0] === 'paid') ? p[1] : b.approved_by;
    return { rows: [Object.assign({}, b)], rowCount: 1 };
  }
  if (/^SELECT po\.status, po\.data,/.test(text) && /FROM job_purchase_orders po/.test(text)) {
    const po = rowsOf('pos').find((x) => String(x.id) === String(p[0]));
    if (!po) return { rows: [], rowCount: 0 };
    const j = rowsOf('jobs').find((x) => String(x.id) === String(po.job_id));
    if (!j || !orgOk(j, p[1])) return { rows: [], rowCount: 0 };
    const byUser = /ja\.user_id = \$3/.test(text);
    const g = rowsOf('grants').find((x) => String(x.job_id) === String(po.job_id)
      && (!byUser || Number(x.user_id) === Number(p[2])));
    return { rows: [{ status: po.status, data: po.data, job_number: null, job_title: null,
      owner_id: j.owner_id, access_level: g ? g.access_level : null }], rowCount: 1 };
  }
  if (/^UPDATE job_purchase_orders SET/.test(text)) {
    const po = rowsOf('pos').find((x) => String(x.id) === String(p[p.length - 1]))
      || rowsOf('pos')[0];
    if (!po) return { rows: [], rowCount: 0 };
    const moved = (p || []).find((v) => ['draft', 'issued', 'approved', 'work_complete', 'closed'].includes(v));
    if (moved) po.status = moved;
    return { rows: [Object.assign({}, po)], rowCount: 1 };
  }
  if (/^SELECT id, owner_id, data FROM jobs WHERE id = \$1/.test(text)) {
    const j = rowsOf('jobs').find((x) => String(x.id) === String(p[0]));
    if (!j || !orgOk(j, p[1])) return { rows: [] };
    return { rows: [j] };
  }
  return { rows: [], rowCount: 0 };
}

// ── roles, exactly as server/db.js seeds them ──────────────────────────────
// Read from db.js rather than retyped, so a change to the seed shows up here.
const DB = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');

function seededCaps(roleName) {
  const i = DB.indexOf("name: '" + roleName + "',");
  expect(i).toBeGreaterThan(-1);
  const seg = DB.slice(i, i + 1200);
  const m = seg.match(/capabilities:\s*\[([\s\S]*?)\]/);
  expect(m).toBeTruthy();
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

const ROLE_NAMES = ['system_admin', 'admin', 'corporate', 'pm', 'field_crew', 'sub'];

function freshTables() {
  return {
    roles: ROLE_NAMES.map((n) => ({ name: n, capabilities: seededCaps(n) })),
    jobs: [{ id: 'job_1', owner_id: 11, organization_id: 1, data: { jobNumber: 'S2100', title: 'Citi Lakes' } }],
    bills: [{ id: 'bill_1', job_id: 'job_1', owner_id: 10, organization_id: 1, status: 'open', amount: 15440 }],
    // Job Sharing grants. Empty by default; the tests that need one add it.
    grants: [],
    pos: [{ id: 'po_1', job_id: 'job_1', organization_id: 1, status: 'draft',
      po_number: '0014', data: { title: 'Balcony work', total: 5050 } }],
  };
}

// A user of each role. 11 is the job's owner; everybody else is not.
const USER = (role, id) => ({ id: id, email: role + '@agx.test', role: role, name: role, organization_id: 1 });

// The real auth stack, driven the way test/money-notices.test.js drives it:
// a REAL signed token and the REAL role cache, so the capabilities under test
// are the ones the seed actually grants rather than ones this file asserts.
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const { pool } = require('../server/db');

let server;
let base;

beforeAll(async () => {
  tables = freshTables();
  setRolePool(pool);
  await refreshRoleCache();
  const app = express();
  app.use(express.json());
  app.use('/api', require('../server/routes/bill-routes'));
  app.use('/api', require('../server/routes/purchase-order-routes'));
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; done(); });
  });
});

afterAll((done) => { if (server) server.close(() => done()); else done(); });

beforeEach(async () => {
  tables = freshTables();
  await refreshRoleCache();
});

async function setStatus(user, status, billId) {
  const res = await fetch(base + '/api/bills/' + (billId || 'bill_1') + '/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signToken(user) },
    body: JSON.stringify({ status: status }),
  });
  let body = {};
  try { body = await res.json(); } catch (_) {}
  return { status: res.status, body: body };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SEED IS WHERE THE PROBLEM WAS VISIBLE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the capability matrix, read from the seed', () => {
  test('field_crew holds ESTIMATES_EDIT and NOT JOBS_EDIT_ANY — the whole reason for this file', () => {
    const crew = seededCaps('field_crew');
    expect(crew).toContain('ESTIMATES_EDIT');
    expect(crew).not.toContain('JOBS_EDIT_ANY');
    expect(crew).not.toContain('FINANCIALS_VIEW');
  });

  test('its description says what it is for, and the capability used to disagree', () => {
    const i = DB.indexOf("name: 'field_crew',");
    const seg = DB.slice(i, i + 400);
    expect(seg).toContain('No jobs, no financials');
  });

  test('a PM has JOBS_EDIT_OWN, not JOBS_EDIT_ANY — so ownership is the question for them', () => {
    const pm = seededCaps('pm');
    expect(pm).toContain('JOBS_EDIT_OWN');
    expect(pm).not.toContain('JOBS_EDIT_ANY');
    expect(pm).toContain('ESTIMATES_EDIT');
  });

  test('admin and system_admin hold JOBS_EDIT_ANY', () => {
    for (const r of ['admin', 'system_admin']) {
      expect([r, seededCaps(r).includes('JOBS_EDIT_ANY')]).toEqual([r, true]);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE RULE, THROUGH THE REAL HANDLER
 * ══════════════════════════════════════════════════════════════════════════*/
describe('who may move a bill’s status', () => {
  test('FIELD CREW may not approve a bill for payment', async () => {
    const r = await setStatus(USER('field_crew', 20), 'approved');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('job_money_forbidden');
    expect(tables.bills[0].status).toBe('open');
  });

  test('field crew may not mark one paid, nor void one', async () => {
    for (const s of ['paid', 'void']) {
      const r = await setStatus(USER('field_crew', 20), s);
      expect([s, r.status]).toEqual([s, 403]);
    }
    expect(tables.bills[0].status).toBe('open');
  });

  test('an ADMIN may', async () => {
    const r = await setStatus(USER('admin', 30), 'approved');
    expect(r.status).toBe(200);
    expect(tables.bills[0].status).toBe('approved');
  });

  test('the PM WHO RUNS THE JOB may', async () => {
    const r = await setStatus(USER('pm', 11), 'approved');   // jobs.owner_id = 11
    expect(r.status).toBe(200);
    expect(tables.bills[0].status).toBe('approved');
  });

  test('a PM who runs a DIFFERENT job may not', async () => {
    const r = await setStatus(USER('pm', 12), 'approved');
    expect(r.status).toBe(403);
    expect(tables.bills[0].status).toBe('open');
  });

  test('a PM SHARED onto the job may — a grant is how the product says you run it', async () => {
    // The first draft of this gate tested jobs.owner_id alone and refused
    // these people. Job Sharing is shipped, job-routes canEdit admits an
    // 'edit' grant, and the owner-reassignment route documents adding a
    // share as the way a PM keeps running a job after ownership moves. They
    // could not have self-remedied either: reassignment is admin-only.
    tables.grants.push({ job_id: 'job_1', user_id: 12, access_level: 'edit' });
    const r = await setStatus(USER('pm', 12), 'approved');
    expect(r.status).toBe(200);
    expect(tables.bills[0].status).toBe('approved');
  });

  test('a VIEW grant is not enough — seeing a job is not running it', async () => {
    tables.grants.push({ job_id: 'job_1', user_id: 12, access_level: 'view' });
    const r = await setStatus(USER('pm', 12), 'approved');
    expect(r.status).toBe(403);
    expect(tables.bills[0].status).toBe('open');
  });

  test('SOMEBODY ELSE’S grant on this job does not admit me', async () => {
    // The join must be predicated on the caller. Without that, one share to
    // one person would open the job's bills to every PM in the company —
    // and it would look exactly like a working feature.
    tables.grants.push({ job_id: 'job_1', user_id: 13, access_level: 'edit' });
    const r = await setStatus(USER('pm', 12), 'approved');
    expect(r.status).toBe(403);
    expect(tables.bills[0].status).toBe('open');
  });

  test('a grant on ANOTHER job does not carry over', async () => {
    tables.grants.push({ job_id: 'job_other', user_id: 12, access_level: 'edit' });
    const r = await setStatus(USER('pm', 12), 'approved');
    expect(r.status).toBe(403);
  });

  test('an edit grant does NOT let the FIELD CREW in — two separate questions', async () => {
    // If a grant alone sufficed, sharing a job with a crew member — an
    // ordinary thing the office does so somebody can work on it — would hand
    // back bill approval on the one job that matters to them, and the hole
    // would reopen for exactly the role this gate closes.
    //
    // A grant answers WHICH JOBS. It does not answer MAY YOU EDIT JOBS AT
    // ALL, which is JOBS_EDIT_OWN — and field_crew holds no job capability
    // of any kind.
    tables.grants.push({ job_id: 'job_1', user_id: 20, access_level: 'edit' });
    const r = await setStatus(USER('field_crew', 20), 'approved');
    expect(r.status).toBe(403);
    expect(tables.bills[0].status).toBe('open');
  });

  test('entering the bill does not entitle you to approve it', async () => {
    // bills.owner_id = 10 — whoever keyed it in. That is NOT the test; the
    // job's manager is. One person entering and approving their own payable is
    // the separation this gate exists to create.
    const r = await setStatus(USER('field_crew', 10), 'approved');
    expect(r.status).toBe(403);
  });

  test('the refusal says who CAN, so the person reading it knows what to do', async () => {
    const r = await setStatus(USER('field_crew', 20), 'approved');
    expect(r.body.error).toMatch(/manager of this job|administrator/i);
  });

  test('a bill in another tenant is still a 404, not a 403 — the gate adds no oracle', async () => {
    tables.jobs.push({ id: 'job_x', owner_id: 90, organization_id: 2, data: {} });
    tables.bills.push({ id: 'bill_x', job_id: 'job_x', owner_id: 90, organization_id: 2, status: 'open' });
    const r = await setStatus(USER('admin', 30), 'approved', 'bill_x');
    expect(r.status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SAME RULE ON PURCHASE ORDERS
 *
 * POs carried the identical weak gate. Issuing one is not a lesser act than
 * approving it: leaving draft is what LOCKS the PO's price and freezes its
 * baseline, so the company is committed to a figure at that moment.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('who may move a purchase order’s status', () => {
  async function setPoStatus(user, status, poId) {
    const res = await fetch(base + '/api/purchase-orders/' + (poId || 'po_1') + '/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signToken(user) },
      body: JSON.stringify({ status: status }),
    });
    let body = {};
    try { body = await res.json(); } catch (_) {}
    return { status: res.status, body: body };
  }

  test('FIELD CREW may not issue a purchase order to a subcontractor', async () => {
    const r = await setPoStatus(USER('field_crew', 20), 'issued');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('job_money_forbidden');
    expect(tables.pos[0].status).toBe('draft');
  });

  test('an admin may', async () => {
    const r = await setPoStatus(USER('admin', 30), 'issued');
    expect(r.status).toBe(200);
    expect(tables.pos[0].status).toBe('issued');
  });

  test('the PM who runs the job may', async () => {
    const r = await setPoStatus(USER('pm', 11), 'issued');
    expect(r.status).toBe(200);
  });

  test('a PM shared onto the job may; a view grant is not enough', async () => {
    tables.grants.push({ job_id: 'job_1', user_id: 12, access_level: 'edit' });
    expect((await setPoStatus(USER('pm', 12), 'issued')).status).toBe(200);
    tables = freshTables();
    tables.grants.push({ job_id: 'job_1', user_id: 12, access_level: 'view' });
    expect((await setPoStatus(USER('pm', 12), 'issued')).status).toBe(403);
  });

  test('a share does not let the field crew in here either', async () => {
    tables.grants.push({ job_id: 'job_1', user_id: 20, access_level: 'edit' });
    const r = await setPoStatus(USER('field_crew', 20), 'issued');
    expect(r.status).toBe(403);
  });

  test('every transition is gated, not just approve — leaving draft locks the price', async () => {
    tables.pos[0].status = 'issued';
    for (const s of ['approved', 'draft']) {
      tables.grants.length = 0;
      const r = await setPoStatus(USER('field_crew', 20), s);
      expect([s, r.status]).toEqual([s, 403]);
    }
  });

  test('a PO in another tenant is a 404, not a 403', async () => {
    tables.jobs.push({ id: 'job_x', owner_id: 90, organization_id: 2, data: {} });
    tables.pos.push({ id: 'po_x', job_id: 'job_x', organization_id: 2, status: 'draft', data: {} });
    const r = await setPoStatus(USER('admin', 30), 'issued', 'po_x');
    expect(r.status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SHAPE: IT CAN ONLY REMOVE ACCESS
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the gate never grants', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'bill-routes.js'), 'utf8');
  const GATE = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'job-money-gate.js'), 'utf8');
  // Every money door that asks the shared rule. A new one belongs here.
  const DOORS = ['server/routes/bill-routes.js', 'server/routes/purchase-order-routes.js'];

  test('ESTIMATES_EDIT is still the outer door on EVERY money status route', () => {
    // Asserted per door, not just for bills. Mutation showed why: deleting the
    // outer capability from the PO route alone left this file green, because
    // the inner rule still refused field crew — so the suite proved the gate
    // and missed that the route had been opened to roles which previously
    // could not reach it at all.
    const ROUTES = [
      ['server/routes/bill-routes.js', "router.post('/bills/:id/status'"],
      ['server/routes/purchase-order-routes.js', "router.post('/purchase-orders/:id/status'"],
    ];
    for (const [file, decl] of ROUTES) {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      const i = src.indexOf(decl);
      expect([file, i > -1]).toEqual([file, true]);
      expect([file, src.slice(i, i + 220).includes("requireCapability('ESTIMATES_EDIT')")])
        .toEqual([file, true]);
    }
  });

  test('a role with no ESTIMATES_EDIT cannot reach the route at all', () => {
    // corporate and sub are both outside it, and the inner gate must not be
    // written in a way that would let either in if the outer one moved.
    for (const r of ['corporate', 'sub']) {
      expect([r, seededCaps(r).includes('ESTIMATES_EDIT')]).toEqual([r, false]);
    }
  });

  test("'corporate' is NOT named as privileged, unlike the change-order gate", () => {
    // change-order-routes treats corporate as privileged. Corporate is
    // "read-only across all jobs"; naming it here would hand a read-only role
    // settlement authority the day somebody adds ESTIMATES_EDIT to it.
    expect(GATE).toContain("user.role === 'admin'");
    expect(GATE).toContain("hasCapability(user, 'JOBS_EDIT_ANY')");
    expect(GATE).not.toMatch(/role === 'corporate'/);
  });

  test('the two questions are asked separately, so a job share cannot confer money authority', () => {
    // "may you edit jobs at all" and "is this one of yours" are distinct
    // conditions. Collapsing them to the grant alone reopens the hole for
    // field crew the moment anybody shares a job with them.
    expect(GATE).toContain("hasCapability(user, 'JOBS_EDIT_OWN')");
    expect(GATE).toContain("row.access_level === 'edit'");
    expect(GATE).toContain('row.owner_id === user.id');
  });

  test('the rule is a MODULE, and both money doors ask it rather than keeping a copy', () => {
    // Two copies of an authorisation rule drift, and the drift is silent:
    // nothing fails, one door just quietly becomes the lenient one. This is
    // the assertion that stops a third money door re-implementing it.
    for (const f of DOORS) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      expect([f, liveLines(src, "require('../services/job-money-gate')").length]).toEqual([f, 1]);
      expect([f, liveLines(src, 'gate.maySettleJobMoney(req.user, cur.rows[0])').length]).toEqual([f, 1]);
      expect([f, liveLines(src, 'gate.jobAccessJoin(').length]).toEqual([f, 1]);
      // and no door keeps its own copy of the logic
      expect([f, /canEditOwnJobs|access_level === 'edit'/.test(src)]).toEqual([f, false]);
    }
  });

  test('the join carries the caller predicate — one share must not open a job to everybody', () => {
    const g = require('../server/services/job-money-gate');
    expect(g.jobAccessJoin('b', 3)).toBe('LEFT JOIN job_access ja ON ja.job_id = b.job_id AND ja.user_id = $3');
    expect(g.jobAccessJoin('po', 3)).toContain('ja.user_id = $3');
    // and it refuses anything it cannot vouch for rather than interpolating it
    expect(() => g.jobAccessJoin('b; DROP TABLE users; --', 3)).toThrow();
    expect(() => g.jobAccessJoin('b', 0)).toThrow();
  });
  test('creating and editing a bill are NOT tightened — only the status move is', () => {
    for (const route of ["router.post('/jobs/:jobId/bills'", "router.put('/bills/:id'"]) {
      const i = SRC.indexOf(route);
      expect([route, i > -1]).toEqual([route, true]);
      expect(SRC.slice(i, i + 200)).toContain("requireCapability('ESTIMATES_EDIT')");
      // and no ownership gate crept into them
      expect(SRC.slice(i, i + 400)).not.toContain('maySettleJobMoney');
    }
  });

  test('the gate runs BEFORE the transition check, so a refusal cannot be probed for state', () => {
    const i = SRC.indexOf('maySettleJobMoney');
    const j = SRC.indexOf('Transition not allowed');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
  });
});
