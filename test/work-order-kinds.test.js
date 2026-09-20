// WORK ORDER vs SERVICE TICKET (Phase 2) — the two kinds, the contract price
// and the numbers, EXECUTED through the real router.
//
// John, 2026-09-19: "work orders are mainly for urgent issues, a go and do
// this, it's approved type of call. We need to bill based on work performed and
// materials and mark-up after the job is done. Service tickets are for our
// smaller service jobs 10k and below, these would already have a contract price
// and estimate to work from."
//
// So one record carries both, and ONE column decides behaviour:
//   bill_as 'time_materials'  a WORK ORDER    -> WO-####, no price up front
//   bill_as 'contract'        a SERVICE TICKET -> ST-####, a contract price
//   bill_as 'none'            every ticket that predates them, unchanged
// ticket_kind is only the word on the screen, so the two can never disagree.
//
// What is asserted here:
//   * a create that says nothing stays exactly what it was (bill_as 'none');
//   * a service ticket must arrive priced — typed, or from its estimate, and
//     the estimate's number is the one the proposal shows;
//   * a price cannot be put on a work order, and turning a service ticket back
//     into one drops the contract rather than leaving money behind;
//   * a client and an estimate must belong to the caller's organization, and
//     another tenant's answers exactly as an absent one does;
//   * a draft carries no number; being issued mints one; re-kinding renumbers
//     into the other series and never reuses a number;
//   * THE CREW NEVER SEES THE PRICE — publicTicket projects by inclusion, and
//     contract_amount is not in it.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const numbers = require('../server/services/ticket-numbers');
const fields = require('../server/services/service-ticket-fields');
const svc = require('../server/services/service-tickets');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks', 'attachments',
  'clients', 'estimates',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares',
  'service_ticket_revisions', 'service_ticket_participants', 'service_ticket_flags',
];

const WIDE = 10;
const RIVAL = 50;
const USERS = {
  [WIDE]: { role: 'st_wide', org: 1 },
  [RIVAL]: { role: 'st_wide', org: 2 },
};

// An estimate whose proposal total is 8,250.00 — one line, no fees, no tax.
const ESTIMATE = {
  lines: [{ description: 'Stair treads', qty: 1, unitCost: 8250, markup: 0 }],
  sections: [],
};

let eng;
let auth;
let db;
let ticketRouter;

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM tasks; DELETE FROM attachments;
    DELETE FROM clients; DELETE FROM estimates;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_participants;
    DELETE FROM service_ticket_flags;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('st_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])});
    INSERT INTO users (id, name, email, role, organization_id, active, sub_id) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'st_wide', 1, 1, NULL),
      (50, 'Rival Ray', 'r@rival.test', 'st_wide', 2, 1, NULL);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1), ('j9', 50, '{}', 2);
    INSERT INTO leads (id, title, organization_id) VALUES ('l1', 'Maple St', 1);
    INSERT INTO clients (id, name, organization_id) VALUES ('cl_1', 'Latitude 28', 1), ('cl_b', 'Rival client', 2);
    INSERT INTO estimates (id, owner_id, data, organization_id) VALUES
      ('est_1', 10, '${JSON.stringify(ESTIMATE)}', 1),
      ('est_b', 50, '${JSON.stringify(ESTIMATE)}', 2),
      ('est_empty', 10, '{"lines":[]}', 1);
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'fields', 'data', 'tags'],
  });
  db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  ticketRouter = require('../server/routes/service-ticket-routes');
});

beforeEach(() => seed());

afterAll(async () => {
  db.pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

// ── the drive ───────────────────────────────────────────────────────────
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.set = () => res;
  return res;
}

function tokenFor(uid) {
  const u = USERS[uid];
  return auth.signToken({ id: uid, email: uid + '@t.test', name: 'U' + uid, role: u.role, organization_id: u.org });
}

async function drive(method, routePath, opts) {
  const o = opts || {};
  const layer = ticketRouter.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error('route not declared: ' + method + ' ' + routePath);
  const res = fakeRes();
  const req = {
    method: method.toUpperCase(),
    params: o.params || {},
    query: o.query || {},
    body: o.body || {},
    cookies: {},
    headers: o.as ? { authorization: 'Bearer ' + tokenFor(o.as) } : {},
    protocol: 'https',
    get: () => 'project86.test',
  };
  for (const h of layer.route.stack.map((s) => s.handle)) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const create = (body, as) => drive('post', '/', { as: as || WIDE, body });
const patch = (id, body, as) => drive('patch', '/:id', { as: as || WIDE, params: { id }, body });
const move = (id, body, as) => drive('post', '/:id/status', { as: as || WIDE, params: { id }, body });
const row = (id) => eng.all('SELECT * FROM service_tickets WHERE id = ?', id)[0];
const answer = (r) => [r.statusCode, r.body && r.body.error, r.body && r.body.field];

// ── the words and the series (no database) ──────────────────────────────

describe('the series follows how it bills, not what it is called', () => {
  test('a contract is ST, everything else is WO', () => {
    expect(numbers.prefixFor('contract')).toBe('ST');
    expect(numbers.prefixFor('time_materials')).toBe('WO');
    expect(numbers.prefixFor('none')).toBe('WO');
    expect(numbers.prefixFor(undefined)).toBe('WO');
  });

  test('numbers are padded to four and never truncated past it', () => {
    expect(numbers.formatNumber('WO', 42)).toBe('WO-0042');
    expect(numbers.formatNumber('ST', 7)).toBe('ST-0007');
    expect(numbers.formatNumber('WO', 12345)).toBe('WO-12345');
  });

  test('a draft carries no number; every other status does', () => {
    expect(numbers.statusWantsNumber('draft')).toBe(false);
    for (const s of ['open', 'scheduled', 'in_progress', 'work_complete', 'approved', 'closed', 'cancelled']) {
      expect(numbers.statusWantsNumber(s)).toBe(true);
    }
  });
});

// ── what a create may say ───────────────────────────────────────────────

describe('creating each kind', () => {
  test('saying nothing keeps the shape every existing ticket has', async () => {
    const r = await create({ job_id: 'j1', title: 'Urgent stair' });
    expect(r.statusCode).toBe(200);
    const t = row(r.body.ticket.id);
    expect(t.bill_as).toBe('none');
    expect(t.ticket_kind).toBe('work_order');
    expect(t.contract_amount == null).toBe(true);
    expect(t.ticket_number == null).toBe(true);   // a draft is not issued yet
  });

  test('a work order: billed after, no price anywhere on it', async () => {
    const r = await create({ job_id: 'j1', title: 'Rail down', kind: 'work_order' });
    expect(r.statusCode).toBe(200);
    const t = row(r.body.ticket.id);
    expect([t.bill_as, t.ticket_kind]).toEqual(['time_materials', 'work_order']);
    expect(t.contract_amount == null).toBe(true);
  });

  test('a service ticket takes the price typed in, punctuation and all', async () => {
    const r = await create({
      job_id: 'j1', title: 'Cluster 8 paint', kind: 'service_ticket', contract_amount: '$8,250.00',
    });
    expect(r.statusCode).toBe(200);
    const t = row(r.body.ticket.id);
    expect([t.bill_as, t.ticket_kind]).toEqual(['contract', 'service_ticket']);
    expect(Number(t.contract_amount)).toBe(8250);
    expect(t.contract_source).toBe('typed');
  });

  test('or the price its estimate shows, and remembers where it came from', async () => {
    const r = await create({
      job_id: 'j1', title: 'Cluster 8 paint', kind: 'service_ticket', estimate_id: 'est_1', client_id: 'cl_1',
    });
    expect(r.statusCode).toBe(200);
    const t = row(r.body.ticket.id);
    expect(Number(t.contract_amount)).toBe(8250);
    expect(t.contract_source).toBe('estimate');
    expect(t.estimate_id).toBe('est_1');
    expect(t.client_id).toBe('cl_1');
  });

  test('a typed price beats the estimate it was taken from', async () => {
    const r = await create({
      job_id: 'j1', title: 'Cluster 8', kind: 'service_ticket', estimate_id: 'est_1', contract_amount: '9000',
    });
    expect(Number(row(r.body.ticket.id).contract_amount)).toBe(9000);
    expect(row(r.body.ticket.id).contract_source).toBe('typed');
  });

  test('a service ticket with no price at all is refused, and nothing is written', async () => {
    const before = eng.all('SELECT id FROM service_tickets').length;
    const r = await create({ job_id: 'j1', title: 'Unpriced', kind: 'service_ticket' });
    expect(answer(r)).toEqual([400, fields.CONTRACT_NEEDS_PRICE, 'contract_amount']);
    expect(eng.all('SELECT id FROM service_tickets').length).toBe(before);
  });

  test('a price on a work order is refused by name', async () => {
    const r = await create({ job_id: 'j1', title: 'Rail', kind: 'work_order', contract_amount: '500' });
    expect(answer(r)).toEqual([400, fields.CONTRACT_ONLY_REFUSAL, 'contract_amount']);
  });

  test('a negative price, and a word that is neither kind, are refused', async () => {
    expect(answer(await create({ job_id: 'j1', title: 'x', kind: 'service_ticket', contract_amount: '-1' })))
      .toEqual([400, fields.AMOUNT_REFUSAL, 'contract_amount']);
    expect(answer(await create({ job_id: 'j1', title: 'x', kind: 'job' })))
      .toEqual([400, fields.KIND_REFUSAL, 'kind']);
  });

  test('an estimate with no price to take is refused rather than priced at zero', async () => {
    const r = await create({ job_id: 'j1', title: 'x', kind: 'service_ticket', estimate_id: 'est_empty' });
    expect(r.statusCode).toBe(400);
    expect(r.body.field).toBe('estimate_id');
  });
});

// ── another tenant's client or estimate ─────────────────────────────────

describe('a client and an estimate belong to the caller organization', () => {
  test("another tenant's estimate answers exactly as an absent one does", async () => {
    const foreign = await create({ job_id: 'j1', title: 'x', kind: 'service_ticket', estimate_id: 'est_b' });
    const absent = await create({ job_id: 'j1', title: 'x', kind: 'service_ticket', estimate_id: 'est_nope' });
    expect(answer(foreign)).toEqual(answer(absent));
    expect(foreign.statusCode).toBe(404);
  });

  test("another tenant's client answers exactly as an absent one does", async () => {
    const foreign = await create({
      job_id: 'j1', title: 'x', kind: 'service_ticket', contract_amount: '100', client_id: 'cl_b',
    });
    const absent = await create({
      job_id: 'j1', title: 'x', kind: 'service_ticket', contract_amount: '100', client_id: 'cl_nope',
    });
    expect(answer(foreign)).toEqual(answer(absent));
    expect(foreign.statusCode).toBe(404);
  });

  test("and no row is written when either is refused", async () => {
    const before = eng.all('SELECT id FROM service_tickets').length;
    await create({ job_id: 'j1', title: 'x', kind: 'service_ticket', estimate_id: 'est_b' });
    expect(eng.all('SELECT id FROM service_tickets').length).toBe(before);
  });
});

// ── numbers ─────────────────────────────────────────────────────────────

describe('numbers are minted when a ticket is issued', () => {
  test('a draft has none; issuing it mints the first WO in the series', async () => {
    const made = await create({ job_id: 'j1', title: 'Rail down', kind: 'work_order' });
    const id = made.body.ticket.id;
    expect(row(id).ticket_number == null).toBe(true);

    const moved = await move(id, { status: 'open' });
    expect(moved.statusCode).toBe(200);
    expect(row(id).ticket_number).toBe('WO-0001');
  });

  test('a service ticket is issued into its own series, counted separately', async () => {
    const wo = await create({ job_id: 'j1', title: 'Rail', kind: 'work_order' });
    await move(wo.body.ticket.id, { status: 'open' });
    const st = await create({ job_id: 'j1', title: 'Paint', kind: 'service_ticket', contract_amount: '8250' });
    await move(st.body.ticket.id, { status: 'open' });
    expect(row(wo.body.ticket.id).ticket_number).toBe('WO-0001');
    expect(row(st.body.ticket.id).ticket_number).toBe('ST-0001');
  });

  test('each new ticket takes the next number, and a number is never reused', async () => {
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const made = await create({ job_id: 'j1', title: 'WO ' + i, kind: 'work_order' });
      await move(made.body.ticket.id, { status: 'open' });
      seen.push(row(made.body.ticket.id).ticket_number);
    }
    expect(seen).toEqual(['WO-0001', 'WO-0002', 'WO-0003']);
  });

  test('a second move does not mint a second number', async () => {
    const made = await create({ job_id: 'j1', title: 'Rail', kind: 'work_order' });
    const id = made.body.ticket.id;
    await move(id, { status: 'open' });
    const first = row(id).ticket_number;
    await move(id, { status: 'scheduled' });
    expect(row(id).ticket_number).toBe(first);
  });
});

// ── changing your mind ──────────────────────────────────────────────────

describe('a ticket that turns out to be the other kind', () => {
  async function issuedWorkOrder() {
    const made = await create({ job_id: 'j1', title: 'Rail down', kind: 'work_order' });
    await move(made.body.ticket.id, { status: 'open' });
    return made.body.ticket.id;
  }

  test('work order to service ticket: priced, renumbered into ST, and stamped', async () => {
    const id = await issuedWorkOrder();
    expect(row(id).ticket_number).toBe('WO-0001');

    const r = await patch(id, { kind: 'service_ticket', contract_amount: '8250' });
    expect(r.statusCode).toBe(200);
    const t = row(id);
    expect([t.bill_as, t.ticket_kind]).toEqual(['contract', 'service_ticket']);
    expect(Number(t.contract_amount)).toBe(8250);
    expect(t.ticket_number).toBe('ST-0001');
    expect(t.kind_changed_at != null).toBe(true);
  });

  test('and back again drops the contract rather than leaving money on it', async () => {
    const id = await issuedWorkOrder();
    await patch(id, { kind: 'service_ticket', contract_amount: '8250' });
    const r = await patch(id, { kind: 'work_order' });
    expect(r.statusCode).toBe(200);
    const t = row(id);
    expect([t.bill_as, t.ticket_kind]).toEqual(['time_materials', 'work_order']);
    expect(t.contract_amount == null).toBe(true);
    expect(t.contract_source == null).toBe(true);
    expect(t.ticket_number).toBe('WO-0002');   // the next free WO, never the old one back
  });

  test('a draft that changes kind is not given a number early', async () => {
    const made = await create({ job_id: 'j1', title: 'Rail', kind: 'work_order' });
    const id = made.body.ticket.id;
    await patch(id, { kind: 'service_ticket', contract_amount: '100' });
    expect(row(id).ticket_number == null).toBe(true);
    await move(id, { status: 'open' });
    expect(row(id).ticket_number).toBe('ST-0001');
  });

  test('a save that says nothing about the kind leaves all of it alone', async () => {
    const id = await issuedWorkOrder();
    await patch(id, { kind: 'service_ticket', contract_amount: '8250' });
    const before = row(id);
    const r = await patch(id, { title: 'Renamed' });
    expect(r.statusCode).toBe(200);
    const after = row(id);
    expect(after.title).toBe('Renamed');
    expect([after.bill_as, after.ticket_kind, after.ticket_number]).toEqual(
      [before.bill_as, before.ticket_kind, before.ticket_number]);
    expect(Number(after.contract_amount)).toBe(Number(before.contract_amount));
  });
});

// ── the crew never sees the price ───────────────────────────────────────

describe('no price reaches a crew link', () => {
  test('publicTicket projects by inclusion: a money key it is handed does not come back', () => {
    const shown = svc.publicTicket({
      id: 'st_x', title: 'Cluster 8', status: 'open',
      contract_amount: '8250.00', contract_source: 'typed', estimate_id: 'est_1',
      client_id: 'cl_1', bill_as: 'contract', ticket_kind: 'service_ticket',
    }, { scope: 'respond' });
    for (const key of ['contract_amount', 'contract_source', 'estimate_id', 'client_id', 'bill_as', 'ticket_kind']) {
      expect(Object.prototype.hasOwnProperty.call(shown, key)).toBe(false);
    }
    expect(JSON.stringify(shown)).not.toContain('8250');
  });

  test('a priced service ticket hands a crew link none of it', async () => {
    const made = await create({
      job_id: 'j1', title: 'Cluster 8', kind: 'service_ticket', contract_amount: '8250', client_id: 'cl_1',
    });
    const stored = row(made.body.ticket.id);
    const shown = svc.publicTicket(stored, { scope: 'respond' });
    expect(JSON.stringify(shown)).not.toContain('8250');
    for (const key of ['contract_amount', 'contract_source', 'estimate_id', 'client_id', 'bill_as', 'ticket_kind']) {
      expect(Object.prototype.hasOwnProperty.call(shown, key)).toBe(false);
    }
  });

  test('MUTANT: add the price to the crew projection and the crew link carries it', () => {
    const stored = { id: 'st_x', title: 'Cluster 8', contract_amount: '8250.00' };
    const leaky = Object.keys(svc.publicTicket(stored, { scope: 'respond' })).concat(['contract_amount']);
    const shown = {};
    for (const k of leaky) if (Object.prototype.hasOwnProperty.call(stored, k)) shown[k] = stored[k];
    expect(JSON.stringify(shown)).toContain('8250');
  });
});
