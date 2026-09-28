// BILLING A WORK ORDER (Phase 4) — EXECUTED through the shipped router.
//
// Phase 3 recorded what was done and carried no money. This is the money, and
// John settled its four open questions on 2026-09-26:
//
//   * ONE labour rate per ticket, seeded from the market's labor_rate_default
//     — the field that has been inert since it shipped, with a written
//     warning against reading it by accident. This is the decision that
//     warning asked for, and the test below pins that it is COPIED onto the
//     ticket, not read live, so editing a market never re-prices a work order
//     somebody has already looked at.
//   * A MATERIAL'S COST is typed by the office, pre-filled from the materials
//     catalogue on an exact description match.
//   * MARKUP IS PER LINE, with the ticket's default behind it.
//   * OVER CONTRACT IS A HARD REFUSAL — no override, no tick-box.
//
// What is asserted here:
//   * the math is not a second opinion: lineExt/lineSell are byte-for-byte
//     the expression js/pricing-pipeline.js prices every estimate and change
//     order with, proved by LIFTING that function and comparing;
//   * a job's work order bills into a draft CHANGE ORDER on that job, a
//     lead's into a draft INVOICE, and the two round differently on purpose —
//     an invoice line has to multiply out on the page;
//   * the blockers are ALL of them at once, not the first one found;
//   * approval before billing, which is the 1.29 rule this door enforces
//     for money;
//   * over contract is refused, and no key in the body gets past it;
//   * a second bill is refused — and deleting the draft releases the ticket,
//     because the refusal reads the LINK, not the word;
//   * none of it reaches a crew link, ever;
//   * another tenant reads and writes nothing.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

jest.mock('../server/storage', () => ({
  storage: { put: async (key) => 'https://cdn.test/' + key, delete: async () => {} },
}));
jest.mock('../server/services/work-order-notices', () => ({
  notifyProblemFlagged: async () => ({ sent: 0 }),
  notifyAssigned: async () => ({ sent: 0 }),
  sendBackRecipients: async () => [],
  notifySentBack: async () => ({ sent: 0 }),
}));
jest.mock('../server/services/service-ticket-notify', () => ({
  notifyAwaitingApproval: async () => ({ sent: 0 }),
}));

const bill = require('../server/services/service-ticket-billing');
const fc = require('../server/services/service-ticket-field-capture');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks', 'attachments', 'clients',
  'estimates', 'markets', 'materials', 'job_change_orders', 'invoices',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares', 'service_ticket_revisions',
  'service_ticket_flags', 'service_ticket_participants', 'service_ticket_labor', 'service_ticket_materials_used',
];

const WIDE = 10;
const RIVAL = 50;
const USERS = {
  [WIDE]: { role: 'bl_wide', org: 1 },
  [RIVAL]: { role: 'bl_wide', org: 2 },
};

let eng, auth, svc, ticketRouter, shareRouter;

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  const future = '2099-01-01T00:00:00.000Z';
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs; DELETE FROM job_access;
    DELETE FROM leads; DELETE FROM tasks; DELETE FROM attachments; DELETE FROM clients; DELETE FROM estimates;
    DELETE FROM markets; DELETE FROM materials; DELETE FROM job_change_orders; DELETE FROM invoices;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_flags;
    DELETE FROM service_ticket_participants;
    DELETE FROM service_ticket_labor; DELETE FROM service_ticket_materials_used;

    INSERT INTO organizations (id, name, timezone) VALUES (1, 'AGX', 'America/New_York'), (2, 'Rival Co', 'America/New_York');
    INSERT INTO roles (name, capabilities) VALUES
      ('bl_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])});
    INSERT INTO users (id, name, email, role, organization_id, active) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'bl_wide', 1, 1),
      (50, 'Rival Ray', 'r@rival.test', 'bl_wide', 2, 1);

    INSERT INTO markets (id, organization_id, name, code, timezone, labor_rate_default, active, sort) VALUES
      (7, 1, 'Tampa', 'TPA', 'America/New_York', 95.00, 1, 0),
      (8, 2, 'Rival Market', 'RIV', 'America/New_York', 11.00, 1, 0);

    INSERT INTO jobs (id, owner_id, data, organization_id, market_id) VALUES
      ('j1', 10, '{}', 1, 7), ('j9', 50, '{}', 2, 8);
    INSERT INTO leads (id, organization_id, title, property_name, market_id, created_at) VALUES
      ('ld1', 1, 'Gate motor replacement', 'Belleair Villas', 7, '2026-09-01 09:00:00');

    -- The catalogue: an exact description match carries a real purchase price.
    -- Org 1's own rows, a legacy NULL-org row (shared reference data, the
    -- predicate the rest of the app reads this table with) and one belonging
    -- to the RIVAL, which org 1 must never be offered.
    INSERT INTO materials (id, organization_id, vendor, description, raw_description, unit, last_unit_price, avg_unit_price, is_hidden, last_seen) VALUES
      (1, 1,    'home_depot', '2in PVC check valve', '2IN PVC CHECK VALVE', 'ea', 42.50, 40.00, 0, '2026-08-01'),
      (2, 1,    'home_depot', 'Hidden noise sku',    'HIDDEN',              'ea', 99.00, 99.00, 1, '2026-08-01'),
      (3, NULL, 'home_depot', 'Pipe dope',           'PIPE DOPE',           'ea',  6.25,  6.00, 0, '2026-08-02'),
      (4, 2,    'home_depot', 'Rival only widget',   'RIVAL',               'ea', 12.00, 12.00, 0, '2026-08-03');

    -- st_j  a job's approved work order: bills into a CHANGE ORDER.
    -- st_l  a lead's approved work order: bills into an INVOICE.
    -- st_c  a contract service ticket with a price: the over-contract guard.
    -- st_op an OPEN work order: approval before billing.
    -- st_n  bill_as 'none': bills nowhere at all.
    -- st_b  the rival tenant's.
    INSERT INTO service_tickets (id, organization_id, ticket_number, title, job_id, lead_id, client_id, status, bill_as, ticket_kind, contract_amount, contract_source, checklist, created_by, approval_notice_attempts, billing_status, archived_at, created_at) VALUES
      ('st_j',  1, 'WO-0001', 'Pump room leak',   'j1',  NULL,  NULL, 'approved',    'time_materials', 'work_order', NULL,    NULL,       '[]', 10, 0, 'unbilled', NULL, '2026-09-01 10:00:00'),
      ('st_l',  1, 'WO-0002', 'Gate motor',       NULL,  'ld1', NULL, 'approved',    'time_materials', 'work_order', NULL,    NULL,       '[]', 10, 0, 'unbilled', NULL, '2026-09-01 10:00:01'),
      ('st_c',  1, 'ST-0001', 'Rail repaint',     'j1',  NULL,  NULL, 'approved',    'contract',       'service_ticket', 8000.00, 'estimate', '[]', 10, 0, 'unbilled', NULL, '2026-09-01 10:00:02'),
      ('st_op', 1, 'WO-0003', 'Still running',    'j1',  NULL,  NULL, 'in_progress', 'time_materials', 'work_order', NULL,    NULL,       '[]', 10, 0, 'unbilled', NULL, '2026-09-01 10:00:03'),
      ('st_n',  1, NULL,      'Old rails ticket', 'j1',  NULL,  NULL, 'approved',    'none',           'work_order', NULL,    NULL,       '[]', 10, 0, 'unbilled', NULL, '2026-09-01 10:00:04'),
      ('st_b',  2, 'WO-9001', 'Rival work order', 'j9',  NULL,  NULL, 'approved',    'time_materials', 'work_order', NULL,    NULL,       '[]', 50, 0, 'unbilled', NULL, '2026-09-01 10:00:05');
  `);

  const lab = eng.db.prepare(
    `INSERT INTO service_ticket_labor (id, organization_id, ticket_id, source, author_label, work_date,
       crew_size, hours, work_performed, status, office_crew_size, office_hours, markup_pct, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // 2 × 6.5 = 13 person-hours, accepted.
  lab.run('lb1', 1, 'st_j', 'crew', 'Marco', '2026-09-14', 2, 6.5, 'Replaced the failed check valve.', 'accepted', null, null, null, '2026-09-14 17:00:00');
  // corrected by the office to 2 × 6 = 12, and rejected lines bill nothing.
  lab.run('lb2', 1, 'st_j', 'crew', 'Luis', '2026-09-15', 2, 8, 'Re-primed and tested.', 'accepted', 2, 6, null, '2026-09-15 17:00:00');
  lab.run('lb3', 1, 'st_j', 'crew', 'Luis', '2026-09-15', 9, 9, 'Not our work.', 'rejected', null, null, null, '2026-09-15 17:00:01');
  lab.run('lb9', 1, 'st_l', 'crew', 'Marco', '2026-09-16', 1, 4, 'Swapped the gate motor.', 'accepted', null, null, null, '2026-09-16 17:00:00');
  lab.run('lbB', 2, 'st_b', 'crew', 'Ray', '2026-09-16', 1, 4, 'Rival work.', 'accepted', null, null, null, '2026-09-16 17:00:00');

  const mat = eng.db.prepare(
    `INSERT INTO service_ticket_materials_used (id, organization_id, ticket_id, source, author_label, description,
       quantity, unit, receipt_ids, status, office_quantity, unit_cost, cost_source, markup_pct, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  mat.run('mt1', 1, 'st_j', 'crew', 'Marco', '2in PVC check valve', 1, 'ea', '[]', 'accepted', null, null, null, null, '2026-09-14 17:05:00');
  mat.run('mt2', 1, 'st_j', 'crew', 'Marco', 'Pipe dope', 2, 'ea', '[]', 'accepted', null, null, null, null, '2026-09-14 17:06:00');
  mat.run('mt9', 1, 'st_l', 'crew', 'Marco', 'Gate motor', 1, 'ea', '[]', 'accepted', null, null, null, null, '2026-09-16 17:05:00');
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'fields', 'data', 'tags', 'materials',
                  'crew_takeoff', 'receipt_ids'],
  });
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  svc = require('../server/services/service-tickets');
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  ticketRouter = require('../server/routes/service-ticket-routes');
  shareRouter = require('../server/routes/service-ticket-share-routes');
});

beforeEach(() => seed());

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 25));
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

// ── the drive ─────────────────────────────────────────────────────────────
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.set = () => res; res.setHeader = () => res;
  return res;
}

function tokenFor(uid) {
  const u = USERS[uid];
  return auth.signToken({ id: uid, email: uid + '@t.test', name: 'U' + uid, role: u.role, organization_id: u.org });
}

async function drive(router, method, routePath, opts) {
  const o = opts || {};
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error('route not declared: ' + method + ' ' + routePath);
  const chain = layer.route.stack.map((s) => s.handle);
  const res = fakeRes();
  const req = {
    method: method.toUpperCase(), params: o.params || {}, query: {}, body: o.body || {}, cookies: {},
    headers: o.as ? { authorization: 'Bearer ' + tokenFor(o.as) } : {},
    protocol: 'https', ip: '127.0.0.1', get: () => 'project86.test',
  };
  for (const h of chain) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

// ticketRouter is assigned in beforeAll, so these read it at CALL time —
// a `const R = ticketRouter` at module scope captures undefined.
const sheet = (id, as) => drive(ticketRouter, 'get', '/:id/billing', { params: { id }, as: as || WIDE });
const setRate = (id, body, as) => drive(ticketRouter, 'put', '/:id/billing', { params: { id }, body, as: as || WIDE });
const setLine = (id, kind, lineId, body, as) => drive(ticketRouter, 'put', '/:id/billing/:kind/:lineId',
  { params: { id, kind, lineId }, body, as: as || WIDE });
const doBill = (id, body, as) => drive(ticketRouter, 'post', '/:id/billing/bill', { params: { id }, body: body || {}, as: as || WIDE });
const writeOff = (id, body, as) => drive(ticketRouter, 'post', '/:id/billing/write-off', { params: { id }, body: body || {}, as: as || WIDE });

const codes = (res) => (res.body.blockers || []).map((b) => b.code).sort();
const ticketRow = (id) => eng.all('SELECT * FROM service_tickets WHERE id = ?', id)[0];

/** Price st_j fully: a rate, and a cost on both materials. */
async function priceTheJobTicket() {
  await setRate('st_j', { use_market_rate: true });
  await setLine('st_j', 'materials-used', 'mt1', { unit_cost: 42.5 });
  await setLine('st_j', 'materials-used', 'mt2', { unit_cost: 7 });
}

// ── 1. the math is the pipeline's, not a second opinion ──────────────────
describe('the markup formula is the one js/pricing-pipeline.js already uses', () => {
  // Lifted from the shipped file and RUN, so this compares behaviour rather
  // than two copies of a sentence about behaviour.
  const PIPE = fs.readFileSync(path.join(__dirname, '..', 'js', 'pricing-pipeline.js'), 'utf8')
    .replace(/\r\n/g, '\n');

  function liftLineMoney() {
    const at = PIPE.indexOf('function lineMoney(');
    expect(at).toBeGreaterThan(0);
    let depth = 0, end = -1;
    for (let i = PIPE.indexOf('{', at); i < PIPE.length; i += 1) {
      if (PIPE[i] === '{') depth += 1;
      else if (PIPE[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    // lineMoney leans on three helpers; give it the same ones the file has.
    const src = `
      function num(v){ var n = Number(v); return isFinite(n) ? n : 0; }
      function sellLocked(){ return false; }
      function effectiveMarkupForLine(l){ return num(l.markup); }
      ${PIPE.slice(at, end)}
      return lineMoney;`;
    // eslint-disable-next-line no-new-func
    return new Function(src)();
  }

  const pipelineLineMoney = liftLineMoney();

  const FIXTURES = [
    { qty: 13, cost: 95, markup: 0 },
    { qty: 13, cost: 95, markup: 15 },
    { qty: 1, cost: 42.5, markup: 22.5 },
    { qty: 2, cost: 7, markup: 100 },
    { qty: 0.25, cost: 199.99, markup: 7.125 },
    { qty: 1000, cost: 0.03, markup: 33.333 },
    { qty: 12, cost: 0, markup: 50 },
  ];

  test('qty × cost × (1 + m/100) — the same number, to the last float', () => {
    for (const f of FIXTURES) {
      const theirs = pipelineLineMoney({ qty: f.qty, unitCost: f.cost, markup: f.markup });
      const ext = bill.lineExt(f.qty, f.cost);
      expect([f, ext]).toEqual([f, theirs.ext]);
      expect([f, bill.lineSell(ext, f.markup)]).toEqual([f, theirs.sell]);
    }
  });

  test('and a change-order line previews through that same expression', () => {
    // The CO destination rounds ONCE, at the end — the pipeline's way.
    const row = bill.priced({ qty: 13, unit_cost: 95, effective_markup_pct: 15 }, 'change_order');
    expect(row.total).toBe(bill.round2(pipelineLineMoney({ qty: 13, unitCost: 95, markup: 15 }).sell));
    expect(row.total).toBe(1420.25);
  });

  test('an invoice line rounds the UNIT price first, so the page multiplies out', () => {
    // 3 × 10.005 is 30.015. An invoice that prints "3 @ $10.01" must total
    // $30.03, not $30.02 — a client checks it with a calculator.
    const row = bill.priced({ qty: 3, unit_cost: 10.005, effective_markup_pct: 0 }, 'invoice');
    expect(row.unit_sell).toBe(10.01);
    expect(row.total).toBe(30.03);
    expect(bill.round2(row.qty * row.unit_sell)).toBe(row.total);
  });
});

// ── 2. the cascade, and where a bill goes ────────────────────────────────
describe('markup cascades from the line to the ticket, and stops', () => {
  test('the line wins, then the ticket, then nothing', () => {
    const t = { default_markup_pct: 20 };
    expect(bill.effectiveMarkup({ markup_pct: 35 }, t)).toBe(35);
    expect(bill.effectiveMarkup({ markup_pct: null }, t)).toBe(20);
    expect(bill.effectiveMarkup({ markup_pct: null }, {})).toBe(0);
  });

  test('a line markup of zero is a DECISION, not an absent one', () => {
    // The bug this stops: `line.markup_pct || ticket.default` reads 0 as
    // missing and quietly bills the ticket's 20% on a line set to nothing.
    expect(bill.effectiveMarkup({ markup_pct: 0 }, { default_markup_pct: 20 })).toBe(0);
  });
});

describe('where a work order bills', () => {
  test('a job’s is a change order on that job', () => {
    expect(bill.destinationFor({ job_id: 'j1' })).toEqual({ kind: 'change_order', job_id: 'j1' });
  });
  test('a lead’s is an invoice, because there is no contract to change', () => {
    expect(bill.destinationFor({ lead_id: 'ld1' })).toEqual({ kind: 'invoice', lead_id: 'ld1' });
  });
  test('the job wins when a ticket carries both', () => {
    expect(bill.destinationFor({ job_id: 'j1', lead_id: 'ld1' }).kind).toBe('change_order');
  });
  test('and a ticket with neither has nowhere to go', () => {
    expect(bill.destinationFor({})).toBe(null);
  });
});

// ── 3. the sheet ─────────────────────────────────────────────────────────
describe('the sheet', () => {
  test('a ticket raised before billing existed bills nowhere', async () => {
    const res = await sheet('st_n');
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe(bill.MSG.notBillable);
  });

  test('it names EVERY blocker at once, not the first one found', async () => {
    const res = await sheet('st_j');
    expect(res.statusCode).toBe(200);
    // No rate yet, and neither material has a cost.
    expect(codes(res)).toEqual(['no_cost', 'no_rate']);
    const noCost = res.body.blockers.find((b) => b.code === 'no_cost');
    expect(noCost.count).toBe(2);
    expect(noCost.ids.sort()).toEqual(['mt1', 'mt2']);
  });

  test('a rejected line is not on it, and a corrected one bills the correction', async () => {
    await priceTheJobTicket();
    const res = await sheet('st_j');
    const labor = res.body.lines.filter((l) => l.kind === 'labor');
    expect(labor.map((l) => l.id).sort()).toEqual(['lb1', 'lb2']);      // lb3 was rejected
    expect(labor.find((l) => l.id === 'lb1').qty).toBe(13);             // 2 × 6.5, as claimed
    expect(labor.find((l) => l.id === 'lb2').qty).toBe(12);             // 2 × 6, as corrected
  });

  test('cleared of blockers, the totals add up', async () => {
    await priceTheJobTicket();
    const res = await sheet('st_j');
    expect(res.body.blockers).toEqual([]);
    // labour 25 hrs × $95 = 2375 ; materials 42.50 + 14.00 = 56.50
    expect(res.body.totals.cost).toBe(2431.5);
    expect(res.body.totals.price).toBe(2431.5);   // markup still 0 everywhere
    expect(res.body.totals.markup).toBe(0);
  });

  test('a line with no cost contributes NOTHING — it is not a zero', async () => {
    await setRate('st_j', { use_market_rate: true });
    const res = await sheet('st_j');
    const mt1 = res.body.lines.find((l) => l.id === 'mt1');
    expect(mt1.ready).toBe(false);
    expect(mt1.total).toBe(null);          // not 0 — a 0 would bill as free
    expect(codes(res)).toContain('no_cost');
  });

  test('a line still waiting on the office blocks the bill', async () => {
    eng.db.exec("UPDATE service_ticket_labor SET status = 'submitted' WHERE id = 'lb1'");
    await priceTheJobTicket();
    const res = await sheet('st_j');
    expect(codes(res)).toContain('waiting');
    expect(res.body.blockers.find((b) => b.code === 'waiting').count).toBe(1);
  });

  test('approval before billing — the 1.29 rule, enforced for money', async () => {
    const res = await sheet('st_op');
    expect(codes(res)).toContain('not_approved');
    const bl = await doBill('st_op');
    expect(bl.statusCode).toBe(409);
    expect(bl.body.error).toBe(bill.MSG.notApproved);
    expect(eng.all('SELECT * FROM job_change_orders')).toHaveLength(0);
  });
});

// ── 4. the rate ──────────────────────────────────────────────────────────
describe('the labour rate', () => {
  test('the market offers it, and taking it COPIES it onto the ticket', async () => {
    const before = await sheet('st_j');
    expect(before.body.rate).toEqual({ value: null, source: null, market_default: 95 });

    const res = await setRate('st_j', { use_market_rate: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.rate.value).toBe(95);
    expect(res.body.rate.source).toBe('market');
    expect(Number(ticketRow('st_j').labor_rate)).toBe(95);
  });

  test('and editing the market afterwards does NOT re-price the work order', async () => {
    await setRate('st_j', { use_market_rate: true });
    eng.db.exec('UPDATE markets SET labor_rate_default = 250 WHERE id = 7');
    const res = await sheet('st_j');
    expect(res.body.rate.value).toBe(95);            // what was stamped
    expect(res.body.rate.market_default).toBe(250);  // what is on offer now
  });

  test('a lead’s work order inherits its LEAD’s market', async () => {
    const res = await sheet('st_l');
    expect(res.body.rate.market_default).toBe(95);
  });

  test('a typed rate says it was typed', async () => {
    const res = await setRate('st_j', { labor_rate: '112.50' });
    expect(res.body.rate).toMatchObject({ value: 112.5, source: 'typed' });
  });

  test('a rate that is not a number, or is absurd, is refused', async () => {
    for (const v of ['abc', -1, 1e9]) {
      const res = await setRate('st_j', { labor_rate: v });
      expect([v, res.statusCode]).toEqual([v, 400]);
      expect([v, ticketRow('st_j').labor_rate]).toEqual([v, null]);
    }
  });

  test('without a rate, labour cannot be priced and the bill is refused', async () => {
    await setLine('st_j', 'materials-used', 'mt1', { unit_cost: 42.5 });
    await setLine('st_j', 'materials-used', 'mt2', { unit_cost: 7 });
    const res = await doBill('st_j');
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe(bill.MSG.noRate);
    expect(eng.all('SELECT * FROM job_change_orders')).toHaveLength(0);
  });
});

// ── 5. a material's cost ─────────────────────────────────────────────────
describe('a material’s cost', () => {
  const look = (d, org) => bill.catalogCost(eng.pool, org === undefined ? 1 : org, d);

  test('the catalogue matches an exact description and offers a real price', async () => {
    expect(await look('2in PVC check valve')).toEqual({ unit_cost: 42.5, unit: 'ea', matched: '2in PVC check valve' });
  });

  test('case does not matter, but a near miss does — a wrong pre-fill is worse than none', async () => {
    expect((await look('2IN PVC CHECK VALVE')).unit_cost).toBe(42.5);
    expect(await look('2in PVC check valves')).toBe(null);
    expect(await look('  ')).toBe(null);
  });

  test('a legacy NULL-org row is shared reference data and IS offered', async () => {
    expect((await look('pipe dope')).unit_cost).toBe(6.25);
  });

  test('another tenant\u2019s purchase price is NOT \u2014 what a company paid is its own business', async () => {
    expect(await look('Rival only widget', 1)).toBe(null);
    expect((await look('Rival only widget', 2)).unit_cost).toBe(12);
    expect(await look('2in PVC check valve', 2)).toBe(null);
    expect(await look('2in PVC check valve', null)).toBe(null);
  });

  test('a hidden sku is not offered', async () => {
    expect(await look('Hidden noise sku')).toBe(null);
  });

  test('the sheet OFFERS the price beside the empty box, and does not fill it', async () => {
    const res = await sheet('st_j');
    const valve = res.body.lines.find((l) => l.id === 'mt1');
    expect(valve.unit_cost).toBe(null);          // still empty \u2014 nobody chose it
    expect(valve.catalog).toEqual({ unit_cost: 42.5, unit: 'ea', matched: '2in PVC check valve' });
    expect(res.body.blockers.map((b) => b.code)).toContain('no_cost');
  });

  test('the office types it, and the source is recorded', async () => {
    await setLine('st_j', 'materials-used', 'mt1', { unit_cost: 44, cost_source: 'catalog' });
    await setLine('st_j', 'materials-used', 'mt2', { unit_cost: 7 });
    const rows = eng.all('SELECT id, unit_cost, cost_source FROM service_ticket_materials_used WHERE ticket_id = ? ORDER BY id', 'st_j');
    expect(rows.map((r) => [r.id, Number(r.unit_cost), r.cost_source])).toEqual([
      ['mt1', 44, 'catalog'], ['mt2', 7, 'typed'],
    ]);
  });

  test('only an ACCEPTED line carries money', async () => {
    eng.db.exec("UPDATE service_ticket_materials_used SET status = 'rejected' WHERE id = 'mt1'");
    const res = await setLine('st_j', 'materials-used', 'mt1', { unit_cost: 42.5 });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe(bill.MSG.lineDecided);
    expect(eng.all('SELECT unit_cost FROM service_ticket_materials_used WHERE id = ?', 'mt1')[0].unit_cost).toBe(null);
  });

  test('a labour line takes a markup but never a cost — labour prices off the one rate', async () => {
    const res = await setLine('st_j', 'labor', 'lb1', { markup_pct: 18, unit_cost: 999 });
    expect(res.statusCode).toBe(200);
    const row = eng.all('SELECT * FROM service_ticket_labor WHERE id = ?', 'lb1')[0];
    expect(Number(row.markup_pct)).toBe(18);
    expect(row.unit_cost).toBe(undefined);   // there is no such column on labour
  });

  test('a line on another ticket is simply not found', async () => {
    const res = await setLine('st_l', 'materials-used', 'mt1', { unit_cost: 5 });
    expect(res.statusCode).toBe(404);
  });
});

// ── 6. billing a job's work order into a draft change order ──────────────
describe('a job’s work order becomes a DRAFT change order', () => {
  test('one draft, with a line per accepted row, cost and markup — never a total', async () => {
    await priceTheJobTicket();
    await setRate('st_j', { default_markup_pct: 15 });
    await setLine('st_j', 'materials-used', 'mt1', { markup_pct: 30 });

    const res = await doBill('st_j');
    expect(res.statusCode).toBe(200);
    expect(res.body.billed.kind).toBe('change_order');

    const cos = eng.all('SELECT * FROM job_change_orders');
    expect(cos).toHaveLength(1);
    expect(cos[0].status).toBe('draft');
    expect(cos[0].job_id).toBe('j1');
    expect(cos[0].organization_id).toBe(1);
    expect(cos[0].co_number).toBe('CO-1');

    const data = cos[0].data;   // jsonColumns decodes it
    expect(data.lines).toHaveLength(4);
    // Selected by the KIND PREFIX, not by the words: a labour line’s
    // work_performed also says “check valve”, so a search on the noun finds
    // the wrong row. That prefix is why lineText writes one.
    const valve = data.lines.find((l) => /^Material.*check valve/.test(l.description));
    expect(valve.unitCost).toBe(42.5);
    expect(valve.qty).toBe(1);
    expect(valve.markup).toBe(30);           // the line's own beats the ticket's
    const labour = data.lines.filter((l) => /^Labour/.test(l.description));
    expect(labour.map((l) => l.markup)).toEqual([15, 15]);   // the ticket's default
    expect(labour.map((l) => l.unitCost)).toEqual([95, 95]);
    // The money is DERIVED by the CO editor from these, never asserted here.
    expect(data.lines.every((l) => l.unitSell === undefined && l.amount === undefined)).toBe(true);
  });

  test('the ticket records what it became, and the timeline says so', async () => {
    await priceTheJobTicket();
    const res = await doBill('st_j');
    const co = eng.all('SELECT * FROM job_change_orders')[0];
    const t = ticketRow('st_j');
    expect(t.billing_status).toBe('billed');
    expect(t.billed_change_order_id).toBe(co.id);
    expect(t.billed_invoice_id).toBe(null);
    expect(t.billed_by).toBe(10);
    expect(res.body.billed.number).toBe('CO-1');

    const ev = eng.all("SELECT * FROM service_ticket_events WHERE ticket_id = 'st_j' AND kind = 'billed'");
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toMatchObject({ destination: 'change_order', lines: 4, cost: 2431.5 });
  });

  test('a second bill is refused', async () => {
    await priceTheJobTicket();
    await doBill('st_j');
    const again = await doBill('st_j');
    expect(again.statusCode).toBe(409);
    expect(again.body.error).toBe(bill.MSG.alreadyBilled);
    expect(eng.all('SELECT * FROM job_change_orders')).toHaveLength(1);
  });

  // DELETING THE DRAFT RELEASES THE TICKET. That is one claim resting on two
  // separate facts, and this fixture can only demonstrate one of them:
  // test/helpers/db-schema.js derives columns from server/db.js and
  // deliberately reproduces no constraints, so no FK fires in sqlite and a
  // DELETE here would leave a dangling pointer that Postgres would have
  // nulled. Asserting the whole chain against the shim would be asserting
  // the shim. So the two halves are proved apart, and neither is a comment.
  test('the DATABASE nulls the pointer when the draft is deleted', () => {
    // Half one: the columns really are declared ON DELETE SET NULL. Read off
    // server/db.js itself, which is the thing that runs in production.
    const dbjs = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
    for (const col of ['billed_change_order_id', 'billed_invoice_id']) {
      const line = dbjs.split(/\r?\n/).find((l) => l.includes(col) && l.includes('ADD COLUMN'));
      expect([col, line]).toEqual([col, expect.stringContaining('ON DELETE SET NULL')]);
    }
    // …and NOT cascade, which would delete the work order along with a draft
    // somebody thought better of.
    expect(dbjs).not.toMatch(/billed_(change_order|invoice)_id[^\n]*ON DELETE CASCADE/);
  });

  test('and with the pointer gone the ticket bills again — the refusal reads the LINK, not the word', async () => {
    await priceTheJobTicket();
    await doBill('st_j');
    // What Postgres' ON DELETE SET NULL does, done by hand: the draft is
    // gone and the pointer with it. billing_status is deliberately left
    // saying 'billed', because that is the state the word would be left in.
    eng.db.exec('DELETE FROM job_change_orders');
    eng.db.exec("UPDATE service_tickets SET billed_change_order_id = NULL WHERE id = 'st_j'");
    expect(ticketRow('st_j').billing_status).toBe('billed');

    const res = await doBill('st_j');
    expect(res.statusCode).toBe(200);
    expect(eng.all('SELECT * FROM job_change_orders')).toHaveLength(1);
  });

  test('but a pointer that is still there refuses, however stale the word looks', async () => {
    // The mirror of the test above: billing_status alone must not be what
    // decides, in EITHER direction. Here the word says unbilled and the link
    // says otherwise, and the link wins.
    await priceTheJobTicket();
    await doBill('st_j');
    eng.db.exec("UPDATE service_tickets SET billing_status = 'unbilled' WHERE id = 'st_j'");
    const res = await doBill('st_j');
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe(bill.MSG.alreadyBilled);
    expect(eng.all('SELECT * FROM job_change_orders')).toHaveLength(1);
  });
});

// ── 7. billing a lead's work order into a draft invoice ──────────────────
describe('a lead’s work order becomes a DRAFT invoice', () => {
  test('lines carry a unit PRICE, the markup folded in and out of sight', async () => {
    await setRate('st_l', { labor_rate: 100, default_markup_pct: 20 });
    await setLine('st_l', 'materials-used', 'mt9', { unit_cost: 300 });

    const res = await doBill('st_l');
    expect(res.statusCode).toBe(200);
    expect(res.body.billed.kind).toBe('invoice');

    const inv = eng.all('SELECT * FROM invoices');
    expect(inv).toHaveLength(1);
    expect(inv[0].status).toBe('draft');
    expect(inv[0].organization_id).toBe(1);
    expect(inv[0].job_id).toBe(null);       // it hangs off a lead, not a job

    const data = inv[0].data;   // jsonColumns decodes it
    // labour 1 × 4 = 4 hrs @ 100 + 20% = 120 -> 480 ; motor 300 + 20% = 360
    expect(data.lines.map((l) => [l.qty, l.unitPrice, l.amount])).toEqual([[4, 120, 480], [1, 360, 360]]);
    // A client is quoted a price, never a cost and a percentage.
    expect(data.lines.every((l) => l.unitCost === undefined && l.markup === undefined)).toBe(true);
    expect(Number(inv[0].total)).toBe(840);
  });

  test('the ticket points at the invoice, not at a change order', async () => {
    await setRate('st_l', { labor_rate: 100 });
    await setLine('st_l', 'materials-used', 'mt9', { unit_cost: 300 });
    await doBill('st_l');
    const t = ticketRow('st_l');
    expect(t.billed_invoice_id).toBe(eng.all('SELECT id FROM invoices')[0].id);
    expect(t.billed_change_order_id).toBe(null);
    expect(eng.all('SELECT * FROM job_change_orders')).toHaveLength(0);
  });
});

// ── 8. THE OVER-CONTRACT HARD REFUSAL ────────────────────────────────────
describe('a contract price is the price', () => {
  test('a contract ticket bills its price, as one line, with no markup', async () => {
    const res = await sheet('st_c');
    expect(res.body.blockers).toEqual([]);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.totals.price).toBe(8000);
    expect(res.body.contract).toEqual({ amount: 8000, remaining: 0 });
  });

  test('it may be billed for LESS — a job part done, a goodwill reduction', async () => {
    const res = await doBill('st_c', { amount: 6500 });
    expect(res.statusCode).toBe(200);
    const co = eng.all('SELECT * FROM job_change_orders')[0];
    expect(co.data.lines[0].unitCost).toBe(8000);
    const ev = eng.all("SELECT * FROM service_ticket_events WHERE kind = 'billed'")[0];
    expect(ev.detail.price).toBe(6500);
  });

  test('a cent over is refused, and the sentence names the road that IS open', async () => {
    const res = await doBill('st_c', { amount: 8000.01 });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe(bill.MSG.overContract);
    expect(res.body).toMatchObject({ contract_amount: 8000, attempted: 8000.01, over_by: 0.01 });
    expect(/change order/i.test(res.body.error)).toBe(true);
    expect(eng.all('SELECT * FROM job_change_orders')).toHaveLength(0);
  });

  test('THERE IS NO OVERRIDE. Nothing in the body gets past it', async () => {
    // Every shape the rest of this app uses to mean "I meant it". The
    // work-order status door has override / override_time, the change-order
    // door has allowDuplicate — none of them is a key here, and the guard is
    // not written to look for one.
    const keys = ['override', 'override_contract', 'force', 'allow_over', 'confirm',
                  'i_mean_it', 'acknowledged', 'allowDuplicate'];
    for (const k of keys) {
      const body = { amount: 12000 }; body[k] = true;
      const res = await doBill('st_c', body);
      expect([k, res.statusCode]).toEqual([k, 409]);
      expect([k, res.body.error]).toEqual([k, bill.MSG.overContract]);
    }
    expect(eng.all('SELECT * FROM job_change_orders')).toHaveLength(0);
    expect(ticketRow('st_c').billing_status).toBe('unbilled');
  });

  test('the guard is a pure function, and it holds on its own', () => {
    const t = { bill_as: 'contract', contract_amount: 8000 };
    expect(bill.overContract(t, 8000)).toBe(null);
    expect(bill.overContract(t, 7999.99)).toBe(null);
    expect(bill.overContract(t, 8000.01).status).toBe(409);
    // A ticket with no price has no ceiling to be under, so billing is refused
    // rather than allowed through.
    expect(bill.overContract({ bill_as: 'contract' }, 1).error).toBe(bill.MSG.noContract);
    // It says nothing about a work order — that has no contract at all.
    expect(bill.overContract({ bill_as: 'time_materials' }, 1e9)).toBe(null);
  });
});

// ── 9. written off ───────────────────────────────────────────────────────
describe('a call that will not be charged', () => {
  test('it is written off with a reason, and bills nothing', async () => {
    const res = await writeOff('st_j', { reason: 'Warranty return on our own work.' });
    expect(res.statusCode).toBe(200);
    const t = ticketRow('st_j');
    expect(t.billing_status).toBe('written_off');
    expect(t.write_off_reason).toBe('Warranty return on our own work.');
    expect(eng.all('SELECT * FROM job_change_orders')).toHaveLength(0);
    expect(res.body.billed).toEqual(expect.objectContaining({ kind: 'written_off' }));
  });

  test('a reason is required — "written off" with no why is a hole in the ledger', async () => {
    const res = await writeOff('st_j', { reason: '   ' });
    expect(res.statusCode).toBe(400);
    expect(ticketRow('st_j').billing_status).toBe('unbilled');
  });

  test('and it cannot then be billed', async () => {
    await writeOff('st_j', { reason: 'Goodwill.' });
    await priceTheJobTicket();
    const res = await doBill('st_j');
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe(bill.MSG.writtenOff);
  });

  test('nor written off twice', async () => {
    await writeOff('st_j', { reason: 'Goodwill.' });
    const res = await writeOff('st_j', { reason: 'Again.' });
    expect(res.statusCode).toBe(409);
    expect(ticketRow('st_j').write_off_reason).toBe('Goodwill.');
  });
});

// ── 10. none of it reaches the crew ──────────────────────────────────────
describe('a crew link never sees a price', () => {
  const MONEY = ['markup_pct', 'unit_cost', 'cost_source', 'labor_rate', 'labor_rate_source',
                 'default_markup_pct', 'contract_amount', 'billing_status', 'billed_change_order_id',
                 'billed_invoice_id', 'write_off_reason', 'rate', 'price', 'cost', 'total', 'unit_sell'];

  test('publicLine projects by inclusion, and no money key is on the list', () => {
    const row = {
      id: 'mt1', description: 'valve', quantity: 1, unit: 'ea', status: 'accepted', receipt_ids: '[]',
      markup_pct: 30, unit_cost: 42.5, cost_source: 'typed', office_quantity: 4,
    };
    const out = fc.publicLine('material', row, []);
    for (const k of MONEY) expect([k, Object.prototype.hasOwnProperty.call(out, k)]).toEqual([k, false]);
    expect(JSON.stringify(out)).not.toMatch(/42\.5|30/);
  });

  test('the same for a labour line', () => {
    const out = fc.publicLine('labor', {
      id: 'lb1', work_date: '2026-09-14', crew_size: 2, hours: 6.5, work_performed: 'x',
      status: 'accepted', markup_pct: 18,
    }, []);
    for (const k of MONEY) expect([k, Object.prototype.hasOwnProperty.call(out, k)]).toEqual([k, false]);
  });

  test('and the office panel DOES carry it — that is the whole difference', () => {
    const out = fc.officeLine('material', {
      id: 'mt1', description: 'valve', quantity: 1, status: 'accepted',
      markup_pct: 30, unit_cost: 42.5, cost_source: 'typed',
    });
    expect(out).toMatchObject({ markup_pct: 30, unit_cost: 42.5, cost_source: 'typed' });
  });

  test('there is no billing door on the share router at all', () => {
    const paths = shareRouter.stack.filter((l) => l.route).map((l) => l.route.path);
    expect(paths.filter((p) => /billing|markup|rate|invoice|change-order/i.test(p))).toEqual([]);
  });
});

// ── 11. another tenant ───────────────────────────────────────────────────
describe('another tenant', () => {
  test('reads nothing, writes nothing, bills nothing', async () => {
    expect((await sheet('st_j', RIVAL)).statusCode).toBe(404);
    expect((await setRate('st_j', { labor_rate: 1 }, RIVAL)).statusCode).toBe(404);
    expect((await setLine('st_j', 'materials-used', 'mt1', { unit_cost: 1 }, RIVAL)).statusCode).toBe(404);
    expect((await doBill('st_j', {}, RIVAL)).statusCode).toBe(404);
    expect((await writeOff('st_j', { reason: 'x' }, RIVAL)).statusCode).toBe(404);
    expect(ticketRow('st_j').labor_rate).toBe(null);
    expect(eng.all('SELECT * FROM job_change_orders')).toHaveLength(0);
  });

  test('and its own market’s rate is the one it is offered', async () => {
    const res = await sheet('st_b', RIVAL);
    expect(res.statusCode).toBe(200);
    expect(res.body.rate.market_default).toBe(11);
  });
});

// ── 12. mutants: each guard removed, and it must go red ──────────────────
// A guard nobody has watched fail is a guard nobody has tested. Each case
// below takes the SHIPPED service, removes exactly one thing, and asserts the
// property this file relies on stops holding. An anchor that stops matching
// is a loud error, never a silent pass.
describe('MUTANTS', () => {
  const SERVICE = path.join(__dirname, '..', 'server', 'services', 'service-ticket-billing.js');
  const written = [];

  afterEach(() => {
    for (const p of written.splice(0)) {
      try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
      try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
    }
  });

  function mutate(pairs) {
    let out = fs.readFileSync(SERVICE, 'utf8').replace(/\r\n/g, '\n');
    for (const [find, replace] of pairs) {
      const hits = out.split(find).length - 1;
      if (hits !== 1) {
        throw new Error('anchor ' + (hits ? 'matches ' + hits + ' places' : 'no longer matches') +
          ' — re-read the service and repoint it; the guard may be fine:\n' + find);
      }
      out = out.split(find).join(replace);
    }
    // Relative requires have to survive the move to a temp directory.
    out = out.replace(/require\((['"])(\.[^'"]+)\1\)/g, (_m, _q, spec) =>
      'require(' + JSON.stringify(require.resolve(path.resolve(path.dirname(SERVICE), spec)).split(path.sep).join('/')) + ')');
    const p = path.join(os.tmpdir(), '_p86_bill_mutant_' + process.pid + '_' +
      Math.random().toString(36).slice(2, 10) + '.js');
    fs.writeFileSync(p, out, 'utf8');
    written.push(p);
    // A mutant that no longer parses would go red for the wrong reason.
    // eslint-disable-next-line global-require
    return require(p);
  }

  test('the shipped service passes the four properties the mutants break', () => {
    // The control. Without it a mutant that broke the whole module would
    // "pass" every case below for reasons that have nothing to do with a guard.
    const ok = require('../server/services/service-ticket-billing');
    expect(ok.overContract({ bill_as: 'contract', contract_amount: 100 }, 100.01)).not.toBe(null);
    expect(ok.effectiveMarkup({ markup_pct: 0 }, { default_markup_pct: 20 })).toBe(0);
    expect(ok.priced({ qty: 2, unit_cost: null, effective_markup_pct: 0 }, 'invoice').total).toBe(null);
    expect(ok.blockersFor({ bill_as: 'time_materials', status: 'in_progress' },
      { lines: [], waiting: 0, price: 0, contract: null, dest: { kind: 'invoice' } })
      .map((b) => b.code)).toContain('not_approved');
  });

  test('MUTANT: over-contract comparing the wrong way round lets the excess through', () => {
    const m = mutate([['if (want <= round2(cap)) return null;', 'if (want >= round2(cap)) return null;']]);
    expect(m.overContract({ bill_as: 'contract', contract_amount: 8000 }, 12000)).toBe(null);
  });

  test('MUTANT: over-contract dropped entirely bills anything', () => {
    const m = mutate([['  const want = round2(amount);', '  const want = round2(amount); return null;']]);
    expect(m.overContract({ bill_as: 'contract', contract_amount: 8000 }, 1e6)).toBe(null);
  });

  test('MUTANT: the markup cascade reading 0 as absent bills a line set to nothing', () => {
    const m = mutate([['  const own = numberOr(line && line.markup_pct, null);\n  if (own != null) return own;',
                       '  const own = numberOr(line && line.markup_pct, null);\n  if (own) return own;']]);
    expect(m.effectiveMarkup({ markup_pct: 0 }, { default_markup_pct: 20 })).toBe(20);
  });

  test('MUTANT: a costless line priced as zero bills the work as FREE', () => {
    const m = mutate([['  const ready = row.qty != null && row.unit_cost != null;',
                       '  const ready = row.qty != null;']]);
    const row = m.priced({ qty: 2, unit_cost: null, effective_markup_pct: 50 }, 'invoice');
    expect(row.ready).toBe(true);
    expect(row.total).toBe(0);      // exactly the silent zero the guard exists to refuse
  });

  test('MUTANT: approval before billing dropped lets an in-progress ticket bill', () => {
    const m = mutate([["  else if (BILLABLE_STATUSES.indexOf(String(ticket.status || '')) === -1) add('not_approved', MSG.notApproved);",
                       '  else if (false) add(\'not_approved\', MSG.notApproved);']]);
    const codes = m.blockersFor({ bill_as: 'time_materials', status: 'in_progress' },
      { lines: [{ ready: true, kind: 'labor', unit_cost: 95 }], waiting: 0, price: 1, contract: null, dest: { kind: 'invoice' } })
      .map((b) => b.code);
    expect(codes).not.toContain('not_approved');
  });

  test('MUTANT: the billed record read off the WORD instead of the link never releases', () => {
    const m = mutate([["  if (ticket.billed_change_order_id) return { kind: 'change_order', id: String(ticket.billed_change_order_id), at: ticket.billed_at || null };",
                       "  if (String(ticket.billing_status || '') === 'billed') return { kind: 'change_order', id: null, at: ticket.billed_at || null };"]]);
    // The draft was deleted and Postgres nulled the pointer; the word remains.
    const released = { billing_status: 'billed', billed_change_order_id: null, billed_invoice_id: null };
    expect(m.billedRecord(released)).not.toBe(null);   // stuck for ever
    expect(require('../server/services/service-ticket-billing').billedRecord(released)).toBe(null);
  });

  test('MUTANT: an invoice line rounding the total instead of the unit stops multiplying out', () => {
    const m = mutate([['    const unitSell = round2(lineSell(row.unit_cost, m));\n    return Object.assign(row, {\n      ready: true, ext: round2(ext), unit_sell: unitSell, total: round2(row.qty * unitSell),\n    });',
                       '    const unitSell = round2(lineSell(row.unit_cost, m));\n    return Object.assign(row, {\n      ready: true, ext: round2(ext), unit_sell: unitSell, total: round2(lineSell(ext, m)),\n    });']]);
    const row = m.priced({ qty: 3, unit_cost: 10.005, effective_markup_pct: 0 }, 'invoice');
    // The page would read "3 @ $10.01 ....... $30.02", which is not 3 × 10.01.
    expect(row.total).toBe(30.02);
    expect(row.total).not.toBe(row.qty * row.unit_sell);
  });
});

// ── 12b. A CHANGE ORDER BELONGS TO THE JOB. ─────────────────────────────
// John, 2026-09-27: "if a service ticket needs a change order it should
// create one in the jobs change orders section."
//
// That settles a question that had been open since 2026-09-24, when the
// working note said the opposite — that extra work on a service ticket should
// become a change order ON THAT TICKET, which would have needed
// job_change_orders to grow a ticket parent. It does not, and this is here so
// nobody builds that later: a change order has ONE parent and it is a job.
describe('a change order belongs to the job, never to the ticket', () => {
  test('job_change_orders has no ticket parent, and must not grow one', () => {
    const cols = require('./helpers/db-schema').columnsFor('job_change_orders');
    expect(cols).toBeTruthy();
    for (const c of ['service_ticket_id', 'ticket_id', 'parent_ticket_id']) {
      expect([c, cols.has(c)]).toEqual([c, false]);
    }
    // The link runs the OTHER way and is a record inside data, not a column:
    // data.fromWorkOrder says which work order a change order came out of.
    expect(cols.has('job_id')).toBe(true);
  });

  test('billing a job\u2019s ticket writes the change order onto THAT job', async () => {
    await priceTheJobTicket();
    await doBill('st_j');
    const co = eng.all('SELECT * FROM job_change_orders')[0];
    expect(co.job_id).toBe('j1');
    expect(ticketRow('st_j').job_id).toBe('j1');
  });

  test('and a contract service ticket on a job bills into that job too', async () => {
    await doBill('st_c');
    const co = eng.all('SELECT * FROM job_change_orders')[0];
    expect(co.job_id).toBe('j1');
    // It is an ordinary job change order: the job's own section lists it by
    // job_id, with no ticket predicate anywhere.
    expect(co.organization_id).toBe(1);
  });

  test('a ticket with no job has nowhere to put one, and says so rather than guessing', () => {
    // destinationFor is the one place that decides. A lead's ticket is an
    // INVOICE, never a change order invented on some other job.
    expect(bill.destinationFor({ lead_id: 'ld1' }).kind).toBe('invoice');
    expect(bill.destinationFor({})).toBe(null);   // no parent, no destination at all
  });
});

// ── 13. the billing views on the company-wide board ──────────────────────
// "To bill" is the list somebody works through: done, approved, earning
// nothing. It is a view on the existing board rather than a new page, so it
// inherits the board's tenancy, its job-access rule and its whitelist — and
// that whitelist is the thing to keep honest, because a money column added to
// a LIST is a money column on a page that a lot of people can open.
describe('the board\u2019s billing views', () => {
  const board = require('../server/services/service-ticket-board');

  test('to_bill and billed are views; to_bill is counted and billed is not', () => {
    expect(board.VIEWS.to_bill).toEqual({ billing: 'to_bill' });
    expect(board.VIEWS.billed).toEqual({ billing: 'billed' });
    // to_bill wears its number because it is a to-do list. billed only ever
    // grows, and every counted view costs a FILTER on every row.
    expect(board.COUNTED_VIEWS).toContain('to_bill');
    expect(board.COUNTED_VIEWS).not.toContain('billed');
  });

  test('the query parser accepts the billing primitive and refuses a made-up value', () => {
    expect(board.PRIMITIVES.billing).toEqual(['to_bill', 'billed', 'written_off']);
    expect(board.parseBoardQuery({ board: '1', view: 'to_bill' }).error).toBe(null);
    expect(board.parseBoardQuery({ board: '1', billing: 'to_bill' }).error).toBe(null);
    expect(board.parseBoardQuery({ board: '1', billing: 'everything' }).error).not.toBe(null);
  });

  // The comment in the board says these statuses match BILLABLE_STATUSES in
  // the billing service. That is a claim about two files, so it is tested:
  // a status added to one and not the other would put a ticket on the list
  // that the bill door then refuses, or keep one off that is ready to go.
  test('the statuses to_bill lists are exactly the ones the bill door accepts', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'service-ticket-board.js'), 'utf8');
    const at = src.indexOf("if (value === 'to_bill')");
    expect(at).toBeGreaterThan(0);
    const clause = src.slice(at, src.indexOf('}', at));
    const inSql = (clause.match(/'(\w+)'/g) || [])
      .map((s) => s.slice(1, -1))
      .filter((w) => bill.BILLABLE_STATUSES.concat(['approved', 'closed', 'draft', 'open', 'scheduled',
        'in_progress', 'work_complete', 'cancelled']).indexOf(w) >= 0);
    expect(inSql.sort()).toEqual(bill.BILLABLE_STATUSES.slice().sort());
  });

  test('a board row carries the billing STATE and no money whatever', () => {
    for (const k of ['bill_as', 'billing_status', 'has_billing_doc']) {
      expect([k, board.BOARD_ROW_KEYS.indexOf(k) >= 0]).toEqual([k, true]);
    }
    // The property, not a list: nothing on a board row may be a price.
    const MONEY = ['labor_rate', 'labor_rate_source', 'default_markup_pct', 'contract_amount',
      'markup_pct', 'unit_cost', 'cost', 'price', 'total', 'amount', 'rate', 'billed_change_order_id',
      'billed_invoice_id', 'write_off_reason'];
    for (const k of MONEY) {
      expect([k, board.BOARD_ROW_KEYS.indexOf(k)]).toEqual([k, -1]);
    }
  });

  test('a ticket that bills nothing is in NONE of the three billing filters', () => {
    // bill_as 'none' predates billing. It is not waiting to be billed, was
    // not billed and was not written off — a list of work earning nothing
    // must not be padded with tickets that never could earn anything.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'service-ticket-board.js'), 'utf8');
    const at = src.indexOf("case 'billing':");
    const block = src.slice(at, src.indexOf("default:", at));
    expect((block.match(/bill_as <> 'none'/g) || []).length).toBe(3);
  });
});
