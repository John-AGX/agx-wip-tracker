// THE THREE-WAY CONVERT (Phase 2) — what a lead becomes, executed through the
// real router.
//
// John, 2026-09-19: "we need to make the convert to screen to WO, Service
// ticket or JOB more robust as well." Until this shipped there was exactly one
// door — POST /api/jobs/convert — so a won pursuit that was really a two-day
// service call had to be born as a JOB, or as a ticket raised by hand with
// nothing tying it back to the lead it came from.
//
// What is asserted here:
//   * a convert must SAY what it is making; silence is a refusal, not a
//     default, because the whole point of the screen is that somebody chose;
//   * the lead's client and address carry over, and a lead with a city but no
//     street does not make a ticket the office cannot save again;
//   * a service ticket arrives priced and SCOPED from its estimate, and the
//     scope is read from the same groups the price is;
//   * a lead converts ONCE — already a job, or already a ticket, is a 409 that
//     names what it became;
//   * an estimate is sold once, to a job OR to a ticket, and the two doors
//     agree about it;
//   * the ticket is born a draft and ISSUED, so it comes out numbered;
//   * the lead comes out sold and stamped with what it became;
//   * every refusal after BEGIN leaves NOTHING behind — no ticket, no sold
//     lead, no locked estimate.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const convert = require('../server/services/service-ticket-convert');
const fields = require('../server/services/service-ticket-fields');

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

// Two included groups and one excluded one. The proposal total is 8,250 + 1,100
// — the excluded "Best" package is priced but not sold — so the scope the
// convert carries must be the two included ones and never the third.
const ESTIMATE = {
  alternates: [
    { id: 'a1', name: 'Base', scope: 'Replace the stair treads on Building 4.' },
    { id: 'a2', name: 'Handrail', scope: 'Re-anchor the handrail.' },
    { id: 'a3', name: 'Best', scope: 'Repaint every stairwell.', excludeFromTotal: true },
  ],
  lines: [
    { description: 'Stair treads', alternateId: 'a1', qty: 1, unitCost: 8250, markup: 0 },
    { description: 'Handrail', alternateId: 'a2', qty: 1, unitCost: 1100, markup: 0 },
    { description: 'Repaint', alternateId: 'a3', qty: 1, unitCost: 40000, markup: 0 },
  ],
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
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1);
    INSERT INTO clients (id, name, organization_id) VALUES ('cl_1', 'Latitude 28', 1);

    INSERT INTO leads (id, title, client_id, street_address, city, state, zip, status, organization_id)
      VALUES ('l1', 'Building 4 stair treads', 'cl_1', '2900 Palm Bay Rd', 'Palm Bay', 'FL', '32905', 'new', 1);
    -- A lead with a city and no street: the address must travel as a set or
    -- not at all, or the ticket it makes cannot be saved again.
    INSERT INTO leads (id, title, city, state, status, organization_id)
      VALUES ('l_partial', 'Gate motor down', 'Melbourne', 'FL', 'new', 1);
    INSERT INTO leads (id, title, status, organization_id) VALUES
      ('l_plain', 'Roof leak', 'new', 1),
      ('l_second', 'Another one', 'new', 1);
    INSERT INTO leads (id, title, status, organization_id, job_id) VALUES
      ('l_sold_job', 'Already a job', 'sold', 1, 'j1');
    INSERT INTO leads (id, title, status, organization_id) VALUES ('l_rival', 'Theirs', 'new', 2);

    INSERT INTO estimates (id, owner_id, data, organization_id) VALUES
      ('est_1', 10, '${JSON.stringify(ESTIMATE)}', 1),
      ('est_b', 50, '${JSON.stringify(ESTIMATE)}', 2),
      ('est_sold', 10, '${JSON.stringify(Object.assign({ job_id: 'j1' }, ESTIMATE))}', 1),
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

const convertLead = (body, as) => drive('post', '/convert', { as: as || WIDE, body });
const row = (id) => eng.all('SELECT * FROM service_tickets WHERE id = ?', id)[0];
const lead = (id) => eng.all('SELECT * FROM leads WHERE id = ?', id)[0];
const estimate = (id) => eng.all('SELECT * FROM estimates WHERE id = ?', id)[0];
const tickets = () => eng.all('SELECT id FROM service_tickets').length;
const answer = (r) => [r.statusCode, r.body && r.body.error, r.body && r.body.field];

// ── the derivations, with no database in them ───────────────────────────

describe('what carries over, decided without a query', () => {
  test('only the two words are a convert; anything else is not', () => {
    expect(convert.convertKind('work_order')).toBe('work_order');
    expect(convert.convertKind('  Service_Ticket ')).toBe('service_ticket');
    expect(convert.convertKind('job')).toBeNull();
    expect(convert.convertKind('')).toBeNull();
    expect(convert.convertKind(undefined)).toBeNull();
  });

  test('the scope is the INCLUDED groups, named only when there is more than one', () => {
    expect(convert.estimateScope(ESTIMATE))
      .toBe('Base\nReplace the stair treads on Building 4.\n\nHandrail\nRe-anchor the handrail.');
    // One included group: its name would be noise above its own text.
    expect(convert.estimateScope({ alternates: [{ id: 'a', name: 'Base', scope: 'Just this.' }] }))
      .toBe('Just this.');
    // The pre-alternates shape, which survives on estimates nobody has opened
    // since the editor started migrating it.
    expect(convert.estimateScope({ scopeOfWork: 'Legacy text' })).toBe('Legacy text');
    expect(convert.estimateScope({ alternates: [{ id: 'a', scope: '' }], scopeOfWork: 'Legacy text' }))
      .toBe('Legacy text');
    expect(convert.estimateScope('not json at all')).toBe('');
  });

  test('an excluded group is never carried, however much it is priced at', () => {
    expect(convert.estimateScope(ESTIMATE)).not.toMatch(/Repaint every stairwell/);
  });

  test('the address travels as a set or not at all', () => {
    const whole = convert.ticketFromLead({
      title: 'T', client_id: 'cl_1', street_address: '1 Main', city: 'Palm Bay', state: 'FL', zip: '32905',
    });
    expect(whole).toEqual({
      title: 'T', client_id: 'cl_1', street_address: '1 Main', city: 'Palm Bay', state: 'FL', zip: '32905',
    });
    const partial = convert.ticketFromLead({ title: 'T', city: 'Melbourne', state: 'FL' });
    expect([partial.street_address, partial.city, partial.state, partial.zip])
      .toEqual([null, null, null, null]);
    // And what it produces is a row the field checker will accept.
    expect(fields.ticketAddressProblem(partial)).toBeNull();
  });

  test('a title given on the screen beats the lead’s own', () => {
    expect(convert.ticketFromLead({ title: 'Lead title' }, { title: 'What we called it' }).title)
      .toBe('What we called it');
    expect(convert.ticketFromLead({ title: 'Lead title' }, { title: '   ' }).title).toBe('Lead title');
  });
});

// ── the convert says what it is making ──────────────────────────────────

describe('a convert names the record it is making', () => {
  test('no kind is a refusal, not a default', async () => {
    expect(answer(await convertLead({ lead_id: 'l_plain' })))
      .toEqual([400, convert.KIND_REQUIRED, 'kind']);
    expect(answer(await convertLead({ lead_id: 'l_plain', kind: 'job' })))
      .toEqual([400, convert.KIND_REQUIRED, 'kind']);
    expect(tickets()).toBe(0);
  });

  test('and it needs a lead to convert', async () => {
    expect(answer(await convertLead({ kind: 'work_order' })))
      .toEqual([400, 'A convert needs the lead it is converting.', 'lead_id']);
  });
});

// ── a work order ────────────────────────────────────────────────────────

describe('a lead becomes a work order', () => {
  test('numbered, open, billed after, and carrying the lead’s client and address', async () => {
    const r = await convertLead({ lead_id: 'l1', kind: 'work_order' });
    expect(r.statusCode).toBe(200);
    const t = row(r.body.ticket.id);
    expect(t.title).toBe('Building 4 stair treads');
    expect([t.bill_as, t.ticket_kind]).toEqual(['time_materials', 'work_order']);
    expect(t.status).toBe('open');
    expect(t.ticket_number).toBe('WO-0001');
    expect(t.lead_id).toBe('l1');
    expect(t.job_id).toBeNull();
    expect(t.client_id).toBe('cl_1');
    expect([t.street_address, t.city, t.state, t.zip])
      .toEqual(['2900 Palm Bay Rd', 'Palm Bay', 'FL', '32905']);
    // Billed from what was done: no price, on either column.
    expect(t.contract_amount == null).toBe(true);
    expect(t.estimate_id == null).toBe(true);
  });

  test('the lead comes out sold and says what it became', async () => {
    const r = await convertLead({ lead_id: 'l1', kind: 'work_order' });
    const l = lead('l1');
    expect(l.status).toBe('sold');
    expect(l.service_ticket_id).toBe(r.body.ticket.id);
    expect(l.converted_at).toBeTruthy();
    expect(l.job_id == null).toBe(true);
  });

  test('a lead with a city but no street makes a ticket with no address at all', async () => {
    const r = await convertLead({ lead_id: 'l_partial', kind: 'work_order' });
    expect(r.statusCode).toBe(200);
    const t = row(r.body.ticket.id);
    expect([t.street_address, t.city, t.state, t.zip]).toEqual([null, null, null, null]);
  });

  test('the screen may correct the title and the address on the way through', async () => {
    const r = await convertLead({
      lead_id: 'l1', kind: 'work_order', title: 'Bldg 4 treads — urgent',
      street_address: '2901 Palm Bay Rd', priority: 'urgent',
    });
    const t = row(r.body.ticket.id);
    expect(t.title).toBe('Bldg 4 treads — urgent');
    expect(t.street_address).toBe('2901 Palm Bay Rd');
    expect(t.priority).toBe('urgent');
  });
});

// ── a service ticket ────────────────────────────────────────────────────

describe('a lead becomes a service ticket', () => {
  test('priced and scoped from its estimate, in its own number series', async () => {
    const r = await convertLead({ lead_id: 'l1', kind: 'service_ticket', estimate_id: 'est_1' });
    expect(r.statusCode).toBe(200);
    const t = row(r.body.ticket.id);
    expect([t.bill_as, t.ticket_kind]).toEqual(['contract', 'service_ticket']);
    expect(t.ticket_number).toBe('ST-0001');
    expect(Number(t.contract_amount)).toBe(9350);
    expect(t.contract_source).toBe('estimate');
    expect(t.estimate_id).toBe('est_1');
    expect(t.scope_proposed)
      .toBe('Base\nReplace the stair treads on Building 4.\n\nHandrail\nRe-anchor the handrail.');
  });

  test('the scope the screen wrote is the one that is kept', async () => {
    const r = await convertLead({
      lead_id: 'l1', kind: 'service_ticket', estimate_id: 'est_1', scope_proposed: 'What we actually agreed.',
    });
    expect(row(r.body.ticket.id).scope_proposed).toBe('What we actually agreed.');
  });

  test('a price typed on the screen beats the estimate it came from', async () => {
    const r = await convertLead({
      lead_id: 'l1', kind: 'service_ticket', estimate_id: 'est_1', contract_amount: '9,000.00',
    });
    const t = row(r.body.ticket.id);
    expect(Number(t.contract_amount)).toBe(9000);
    expect(t.contract_source).toBe('typed');
  });

  test('with neither an estimate nor a price it is refused, and nothing is written', async () => {
    expect(answer(await convertLead({ lead_id: 'l1', kind: 'service_ticket' })))
      .toEqual([400, fields.CONTRACT_NEEDS_PRICE, 'contract_amount']);
    expect(tickets()).toBe(0);
    expect(lead('l1').status).toBe('new');
  });

  test('the estimate is marked sold and names the ticket it was sold on', async () => {
    const r = await convertLead({ lead_id: 'l1', kind: 'service_ticket', estimate_id: 'est_1' });
    const e = estimate('est_1');
    const blob = convert.estimateBlob(e.data);
    expect(blob.service_ticket_id).toBe(r.body.ticket.id);
    expect(blob.status).toBe('sold');
    expect(String(e.is_locked)).toMatch(/^(1|true)$/);
  });

  test('a work order never carries a price or an estimate, even when one is offered', async () => {
    expect(answer(await convertLead({ lead_id: 'l1', kind: 'work_order', contract_amount: '500' })))
      .toEqual([400, fields.CONTRACT_ONLY_REFUSAL, 'contract_amount']);
    expect(answer(await convertLead({ lead_id: 'l1', kind: 'work_order', estimate_id: 'est_1' })))
      .toEqual([400, fields.CONTRACT_ONLY_REFUSAL, 'estimate_id']);
    expect(tickets()).toBe(0);
  });
});

// ── a lead converts once ────────────────────────────────────────────────

describe('a lead becomes one thing, once', () => {
  test('a lead that is already a job is refused, and the job is named', async () => {
    const r = await convertLead({ lead_id: 'l_sold_job', kind: 'work_order' });
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toBe(convert.ALREADY_A_JOB);
    expect(r.body.job_id).toBe('j1');
    expect(tickets()).toBe(0);
  });

  test('and a second convert of the same lead is refused, naming the first ticket', async () => {
    const first = await convertLead({ lead_id: 'l1', kind: 'work_order' });
    expect(first.statusCode).toBe(200);
    const second = await convertLead({ lead_id: 'l1', kind: 'service_ticket', contract_amount: '100' });
    expect(second.statusCode).toBe(409);
    expect(second.body.error).toBe(convert.ALREADY_A_TICKET);
    expect(second.body.ticket_id).toBe(first.body.ticket.id);
    expect(tickets()).toBe(1);
  });
});

// ── an estimate is sold once ────────────────────────────────────────────

describe('an estimate is sold once, and the two doors agree about it', () => {
  test('an estimate already sold to a job cannot be sold to a ticket', async () => {
    const r = await convertLead({ lead_id: 'l1', kind: 'service_ticket', estimate_id: 'est_sold' });
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toBe(convert.ESTIMATE_SOLD_TO_JOB);
    expect(r.body.job_id).toBe('j1');
    expect(tickets()).toBe(0);
    expect(lead('l1').status).toBe('new');
  });

  test('and one already sold to a ticket cannot be sold to a second one', async () => {
    const first = await convertLead({ lead_id: 'l1', kind: 'service_ticket', estimate_id: 'est_1' });
    expect(first.statusCode).toBe(200);
    const second = await convertLead({ lead_id: 'l_second', kind: 'service_ticket', estimate_id: 'est_1' });
    expect(second.statusCode).toBe(409);
    expect(second.body.error).toBe(convert.ESTIMATE_SOLD_TO_TICKET);
    expect(second.body.ticket_id).toBe(first.body.ticket.id);
    expect(tickets()).toBe(1);
    expect(lead('l_second').status).toBe('new');
  });

  test('an estimate with no price to take is refused rather than sold at zero', async () => {
    const r = await convertLead({ lead_id: 'l1', kind: 'service_ticket', estimate_id: 'est_empty' });
    expect(r.statusCode).toBe(400);
    expect(r.body.field).toBe('estimate_id');
    expect(tickets()).toBe(0);
    // The estimate it refused is not left locked.
    expect(String(estimate('est_empty').is_locked || '')).not.toMatch(/^(1|true)$/);
  });
});

// ── another tenant ──────────────────────────────────────────────────────

describe('a foreign lead or estimate answers exactly as an absent one', () => {
  test("another tenant's lead is 'Lead not found', the same as a bogus id", async () => {
    const foreign = await convertLead({ lead_id: 'l_rival', kind: 'work_order' });
    const absent = await convertLead({ lead_id: 'l_nope', kind: 'work_order' });
    expect(answer(foreign)).toEqual(answer(absent));
    expect(foreign.statusCode).toBe(404);
    expect(tickets()).toBe(0);
  });

  test("another tenant's estimate answers exactly as an absent one does", async () => {
    const foreign = await convertLead({ lead_id: 'l1', kind: 'service_ticket', estimate_id: 'est_b' });
    const absent = await convertLead({ lead_id: 'l1', kind: 'service_ticket', estimate_id: 'est_nope' });
    expect(answer(foreign)).toEqual(answer(absent));
    expect(foreign.statusCode).toBe(404);
    expect(tickets()).toBe(0);
    expect(lead('l1').status).toBe('new');
  });

  test('and a caller from the other organization gets the same answer for our lead', async () => {
    const r = await convertLead({ lead_id: 'l1', kind: 'work_order' }, RIVAL);
    expect(r.statusCode).toBe(404);
    expect(tickets()).toBe(0);
  });
});

// ── the numbers keep going ──────────────────────────────────────────────

describe('converted tickets take the next number in their own series', () => {
  test('two work orders and a service ticket number independently', async () => {
    const a = await convertLead({ lead_id: 'l1', kind: 'work_order' });
    const b = await convertLead({ lead_id: 'l_plain', kind: 'work_order' });
    const c = await convertLead({ lead_id: 'l_second', kind: 'service_ticket', contract_amount: '2500' });
    expect(row(a.body.ticket.id).ticket_number).toBe('WO-0001');
    expect(row(b.body.ticket.id).ticket_number).toBe('WO-0002');
    expect(row(c.body.ticket.id).ticket_number).toBe('ST-0001');
  });
});
