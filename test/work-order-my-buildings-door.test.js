// THE BUILDING PREDICATE AND THE ASSIGNEE-BASED "MY BUILDINGS" DOOR (1.33).
//
// The owner's rule for this release: "service tickets are not to be confused
// with tasks, they are two different things; the subtasks in a service ticket
// shouldn't show up on any task lists separately." From 1.33 the buildings on
// a work order's punch list are subtracted from every task list.
//
// Removing them is only safe because of what is pinned here. A building's
// ASSIGNEE may be someone who cannot open its job at all — services/
// service-ticket-subtask-door.js doneVerdict deliberately lets that person
// finish a building — so the replacement read cannot be gated on the job
// access rule (services/service-ticket-access.js listVisibility) that the
// Service Tickets board runs through. It is gated on assignment and nothing
// else, and that is the whole of what this file exists to prove:
//
//   1. THE HEADLINE. Carl Crew, who cannot open job j1, gets his work orders
//      back from GET /api/service-tickets/my-buildings — and the board,
//      driven in the same file against the same rows, shows him none of them.
//   2. Assignment is the only key: not assigned, done, archived and a
//      personal to-do carrying the ticket id are all absent.
//   3. Two orgs. Nothing crosses, not even a building in org 2 whose
//      service_ticket_id names an org-1 ticket.
//   4. Only the active statuses.
//   5. THE PROJECTION is an exact key set (MY_BUILDING_ROW_KEYS), not a
//      subset, and no money and no office text reaches a crew surface.
//   6. Paging and count_only.
//   7. ROUTE ORDER: both new routes are declared above '/:id', driven by URL
//      through the real Express router rather than by picking a layer.
//   8. building-counts, the header line on a job's and a lead's Tasks panel.
//   9. MUTANTS: each rule removed from a copy of the shipped source and the
//      named assertion above shown to go red — including (c), the regression
//      this release exists to prevent, executed.
//  10. The two predicates themselves.
//
// HOW: the REAL router — real requireAuth over a signed JWT, the real role
// cache — against node:sqlite through the pg shim, on the schema derived from
// server/db.js.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

jest.setTimeout(60000);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const TICKET_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'service-ticket-routes.js');
const DOOR = path.join(__dirname, '..', 'server', 'services', 'service-ticket-subtask-door.js');

const door = require('../server/services/service-ticket-subtask-door');

const TABLES = ['organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks',
  'service_tickets', 'service_ticket_shares', 'service_ticket_participants',
  'service_ticket_events', 'service_ticket_revisions', 'service_ticket_flags', 'attachments', 'job_change_orders'];

const WIDE = 10;     // can edit every job and lead
const CREW = 20;     // narrow tier, NO job_access row on j1: cannot open it at all
const NOBODY = 40;   // signed in, nothing ticket-relevant
const RIVAL = 50;    // another organization
const USERS = {
  [WIDE]: { role: 'st_wide', org: 1, name: 'Wendy Wide' },
  [CREW]: { role: 'st_crew', org: 1, name: 'Carl Crew' },
  [NOBODY]: { role: 'st_none', org: 1, name: 'Nora None' },
  [RIVAL]: { role: 'st_wide', org: 2, name: 'Rival Ray' },
};

// The office text and the money that must never reach a crew surface.
const MARKS = ['INTERNAL_ONLY_MARK', 'PROPOSED_MARK', 'APPROVED_MARK', 'MATERIAL_MARK', 'TAKEOFF_MARK'];
const MONEY_RE = /[$£€]\s?\d|\b\d+\.\d{2}\b/;

let eng;
let auth;
let ticketRouter;

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM tasks; DELETE FROM service_tickets;
    DELETE FROM service_ticket_shares; DELETE FROM service_ticket_participants;
    DELETE FROM service_ticket_events; DELETE FROM service_ticket_revisions;
    DELETE FROM service_ticket_flags; DELETE FROM attachments; DELETE FROM job_change_orders;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('st_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('st_crew', ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])}),
      ('st_none', ${caps(['ESTIMATES_VIEW'])});
    INSERT INTO users (id, name, email, role, organization_id, active) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'st_wide', 1, 1),
      (20, 'Carl Crew', 'c@agx.test', 'st_crew', 1, 1),
      (40, 'Nora None', 'n@agx.test', 'st_none', 1, 1),
      (50, 'Rival Ray', 'r@rival.test', 'st_wide', 2, 1);

    -- j1 is Wendy's and Carl has NO grant on it. j2 is Carl's own, so he can
    -- SEE it through listVisibility's owner arm — which is what makes "not my
    -- building, even on a job I can see" and mutant (c) meaningful.
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES
      ('j1', 10, '{"jobNumber":"86-1001","title":"Latitude at Wekiva"}', 1),
      ('j2', 20, '{"jobNumber":"86-1002","name":"Carls own job"}', 1),
      ('j9', 50, '{"jobNumber":"99-9999","title":"RIVAL job"}', 2);
    INSERT INTO leads (id, title, organization_id) VALUES
      ('l1', 'Maple St reroof', 1),
      ('l2', 'Converted lead', 1);

    INSERT INTO service_tickets
      (id, organization_id, title, job_id, lead_id, status, checklist, created_by,
       due_date, scheduled_for, street_address, city, archived_at, created_at, ticket_number) VALUES
      ('st_ip',     1, 'Latitude punch list', 'j1', NULL, 'in_progress',   '[]', 10, '2999-01-01', NULL,         '1200 Latitude Way', 'Apopka', NULL, '2026-09-11 10:00:00', 'WO-1001'),
      ('st_sched',  1, 'Scheduled list',      'j1', NULL, 'scheduled',     '[]', 10, NULL,         '2999-02-02', '1210 Latitude Way', 'Apopka', NULL, '2026-09-12 10:00:00', 'WO-1002'),
      ('st_wc',     1, 'Waiting on approval', 'j1', NULL, 'work_complete', '[]', 10, NULL,         NULL,         '1220 Latitude Way', 'Apopka', NULL, '2026-09-09 10:00:00', 'WO-1003'),
      ('st_op',     1, 'Overdue list',        'j1', NULL, 'open',          '[]', 10, '2000-01-01', NULL,         '1230 Latitude Way', 'Apopka', NULL, '2026-09-08 10:00:00', 'WO-1004'),
      ('st_proj',   1, 'Projection list',     'j1', NULL, 'in_progress',   '[]', 10, NULL,         NULL,         '1240 Latitude Way', 'Apopka', NULL, '2026-09-10 10:00:00', 'WO-1005'),
      ('st_done',   1, 'All finished',        'j1', NULL, 'in_progress',   '[]', 10, NULL,         NULL,         NULL,                NULL,     NULL, '2026-09-07 10:00:00', 'WO-1006'),
      ('st_arch',   1, 'Archived building',   'j1', NULL, 'in_progress',   '[]', 10, NULL,         NULL,         NULL,                NULL,     NULL, '2026-09-06 10:00:00', 'WO-1007'),
      ('st_pers',   1, 'Private to-do only',  'j1', NULL, 'in_progress',   '[]', 10, NULL,         NULL,         NULL,                NULL,     NULL, '2026-09-05 10:00:00', 'WO-1008'),
      ('st_x',      1, 'Shadowed id',         'j1', NULL, 'in_progress',   '[]', 10, NULL,         NULL,         NULL,                NULL,     NULL, '2026-09-04 10:00:00', 'WO-1009'),
      ('st_j2',     1, 'On Carls own job',    'j2', NULL, 'in_progress',   '[]', 10, NULL,         NULL,         NULL,                NULL,     NULL, '2026-09-03 10:00:00', 'WO-1010'),
      ('st_conv',   1, 'Converted lead list', 'j1', 'l2', 'in_progress',   '[]', 10, NULL,         NULL,         NULL,                NULL,     NULL, '2026-09-02 10:00:00', 'WO-1011'),
      ('st_lead',   1, 'Lead only list',      NULL, 'l1', 'in_progress',   '[]', 10, NULL,         NULL,         NULL,                NULL,     NULL, '2026-09-01 10:00:00', 'WO-1012'),
      ('st_closed', 1, 'Closed list',         'j1', NULL, 'closed',        '[]', 10, NULL,         NULL,         NULL,                NULL,     NULL, '2026-08-31 10:00:00', 'WO-1013'),
      ('st_cancel', 1, 'Cancelled list',      'j1', NULL, 'cancelled',     '[]', 10, NULL,         NULL,         NULL,                NULL,     NULL, '2026-08-30 10:00:00', 'WO-1014'),
      ('st_draft',  1, 'Draft list',          'j1', NULL, 'draft',         '[]', 10, NULL,         NULL,         NULL,                NULL,     NULL, '2026-08-29 10:00:00', 'WO-1015'),
      ('st_appr',   1, 'Approved list',       'j1', NULL, 'approved',      '[]', 10, NULL,         NULL,         NULL,                NULL,     NULL, '2026-08-28 10:00:00', 'WO-1016'),
      ('st_farch',  1, 'Archived work order', 'j1', NULL, 'in_progress',   '[]', 10, NULL,         NULL,         NULL,                NULL, '2026-09-01 00:00:00', '2026-08-27 10:00:00', 'WO-1017'),
      ('st_rival',  2, 'RIVAL list',          'j9', NULL, 'in_progress',   '[]', 50, NULL,         NULL,         NULL,                NULL,     NULL, '2026-09-11 10:00:00', 'WO-9001');

    UPDATE service_tickets SET
      internal_notes = 'OFFICE ONLY INTERNAL_ONLY_MARK quoted $4,250.00 to the GC',
      scope_proposed = 'PROPOSED_MARK strip and reroof three buildings',
      scope_approved = 'APPROVED_MARK two buildings at $1,500.00 each',
      materials      = '[{"description":"MATERIAL_MARK shingle bundle","quantity":"40"}]',
      crew_takeoff   = '{"note":"TAKEOFF_MARK 22 squares"}',
      requested_by   = 'REQUESTED_MARK',
      guest_log      = '[{"note":"GUEST_MARK"}]'
     WHERE id = 'st_proj';

    INSERT INTO tasks
      (id, organization_id, title, status, scope, owner_user_id, assignee_user_id,
       service_ticket_id, entity_type, entity_id, due_date, archived_at, created_at) VALUES
      ('k1',    1, 'Bldg 1 - Side A',  'open', 'org',      NULL, 20, 'st_ip',     'job',  'j1', '2026-12-01', NULL, '2026-09-11 10:00:00'),
      ('k4',    1, 'Bldg 2 - finished','done', 'org',      NULL, 20, 'st_ip',     'job',  'j1', '2020-01-01', NULL, '2026-09-11 10:01:00'),
      ('k3',    1, 'Bldg 3 - Wendys',  'open', 'org',      NULL, 10, 'st_ip',     'job',  'j1', NULL,         NULL, '2026-09-11 10:02:00'),
      ('s1',    1, 'Bldg 4',           'open', 'org',      NULL, 20, 'st_sched',  'job',  'j1', NULL,         NULL, '2026-09-12 10:00:00'),
      ('w1',    1, 'Bldg 5',           'open', 'org',      NULL, 20, 'st_wc',     'job',  'j1', NULL,         NULL, '2026-09-09 10:00:00'),
      ('op1',   1, 'Bldg 6',           'open', 'org',      NULL, 20, 'st_op',     'job',  'j1', NULL,         NULL, '2026-09-08 10:00:00'),
      ('pr1',   1, 'Bldg 7',           'open', 'org',      NULL, 20, 'st_proj',   'job',  'j1', NULL,         NULL, '2026-09-10 10:00:00'),
      ('d1',    1, 'Bldg 8',           'done', 'org',      NULL, 20, 'st_done',   'job',  'j1', NULL,         NULL, '2026-09-07 10:00:00'),
      ('ar1',   1, 'Bldg 9',           'open', 'org',      NULL, 20, 'st_arch',   'job',  'j1', NULL, '2026-09-08 00:00:00', '2026-09-06 10:00:00'),
      ('p1',    1, 'My own reminder',  'open', 'personal',   20, 20, 'st_pers',   'job',  'j1', NULL,         NULL, '2026-09-05 10:00:00'),
      ('q1',    1, 'Bldg 10',          'open', 'org',      NULL, 10, 'st_j2',     'job',  'j2', NULL,         NULL, '2026-09-03 10:00:00'),
      ('c1',    1, 'Bldg 11',          'open', 'org',      NULL, 10, 'st_conv',   'job',  'j1', NULL,         NULL, '2026-09-02 10:00:00'),
      ('lb1',   1, 'Bldg 12',          'open', 'org',      NULL, 10, 'st_lead',   'lead', 'l1', NULL,         NULL, '2026-09-01 10:00:00'),
      ('cl1',   1, 'Bldg 13',          'open', 'org',      NULL, 20, 'st_closed', 'job',  'j1', NULL,         NULL, '2026-08-31 10:00:00'),
      ('cn1',   1, 'Bldg 14',          'open', 'org',      NULL, 20, 'st_cancel', 'job',  'j1', NULL,         NULL, '2026-08-30 10:00:00'),
      ('dr1',   1, 'Bldg 15',          'open', 'org',      NULL, 20, 'st_draft',  'job',  'j1', NULL,         NULL, '2026-08-29 10:00:00'),
      ('ap1',   1, 'Bldg 16',          'open', 'org',      NULL, 20, 'st_appr',   'job',  'j1', NULL,         NULL, '2026-08-28 10:00:00'),
      ('fa1',   1, 'Bldg 17',          'open', 'org',      NULL, 20, 'st_farch',  'job',  'j1', NULL,         NULL, '2026-08-27 10:00:00'),
      ('plain', 1, 'Order the latch',  'open', 'org',      NULL, 20, NULL,        'job',  'j1', NULL,         NULL, '2026-09-11 11:00:00'),
      -- org 2, naming org 1's ticket ids: the cross-tenant shadow
      ('x2',    2, 'RIVAL shadow',     'open', 'org',      NULL, 20, 'st_x',      'job',  'j9', NULL,         NULL, '2026-09-11 10:00:00'),
      ('r2',    2, 'RIVAL on our id',  'open', 'org',      NULL, 50, 'st_ip',     'job',  'j9', NULL,         NULL, '2026-09-11 10:00:00'),
      ('rb1',   2, 'RIVAL own bldg',   'open', 'org',      NULL, NULL, 'st_rival', 'job',  'j9', NULL,         NULL, '2026-09-11 10:00:00');
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'data', 'fields', 'attachment_ids'],
  });
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  ticketRouter = require('../server/routes/service-ticket-routes');
});

const flush = () => new Promise((r) => setTimeout(r, 25));
let mutantPaths = [];

beforeEach(() => seed());

afterEach(async () => {
  await flush();
  jest.restoreAllMocks();
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});

afterAll(async () => {
  await flush();
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

// ── the drive ─────────────────────────────────────────────────────────────
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.send = (p) => res.json(p);
  res.set = () => res;
  res.setHeader = () => res;
  res.end = () => res;
  return res;
}

function tokenFor(uid) {
  const u = USERS[uid];
  return auth.signToken({ id: uid, email: uid + '@t.test', name: u.name, role: u.role, organization_id: u.org });
}

function reqFor(method, opts) {
  const o = opts || {};
  return {
    method: method.toUpperCase(),
    params: o.params || {},
    query: o.query || {},
    body: o.body || {},
    cookies: {},
    headers: o.as ? { authorization: 'Bearer ' + tokenFor(o.as) } : {},
    protocol: 'https',
    get: () => 'project86.test',
  };
}

async function drive(router, method, routePath, opts) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error('route not declared: ' + method + ' ' + routePath);
  const chain = layer.route.stack.map((s) => s.handle);
  const res = fakeRes();
  const req = reqFor(method, opts);
  for (const h of chain) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

// The SAME router, entered by URL, so Express — not this file — picks the
// layer. This is what proves a route's declaration order.
function driveUrl(router, method, url, as) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    const json = res.json;
    res.json = (p) => { json(p); resolve(res); return res; };
    const req = reqFor(method, { as });
    req.url = url;
    req.originalUrl = url;
    router(req, res, (err) => (err ? reject(err) : resolve(res)));
  });
}

const mine = (router, as, query) => drive(router || ticketRouter, 'get', '/my-buildings', { as, query });
const counts = (router, as, query) => drive(router || ticketRouter, 'get', '/building-counts', { as, query });
const boardOf = (as, query) => drive(ticketRouter, 'get', '/', { as, query: Object.assign({ board: '1', limit: '100' }, query || {}) });
const ids = (res) => (res.body && res.body.tickets ? res.body.tickets.map((t) => t.id) : res.body);
const sorted = (res) => ids(res).slice().sort();
const rowOf = (res, id) => res.body.tickets.find((t) => t.id === id);

// Carl is the assignee of a live, open, org building on exactly these.
const CARLS = ['st_ip', 'st_op', 'st_proj', 'st_sched', 'st_wc'];

// ── mutant(): one rule removed from a copy of the shipped source ──────────
function absolutizeRequires(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function writeMutant(file, pairs, redirects) {
  let out = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of pairs) {
    if (out.split(find).length !== 2) throw new Error('anchor not found');
    out = out.split(find).join(replace);
  }
  let copy = absolutizeRequires(out, path.dirname(file));
  for (const [from, to] of Object.entries(redirects || {})) {
    const ref = 'require(' + JSON.stringify(from.split(path.sep).join('/')) + ')';
    if (copy.split(ref).length < 2) throw new Error('anchor not found');
    copy = copy.split(ref).join('require(' + JSON.stringify(to.split(path.sep).join('/')) + ')');
  }
  const p = path.join(os.tmpdir(), '_p86_mybuild_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, copy, 'utf8');
  mutantPaths.push(p);
  return p;
}

const routesMutant = (pairs, redirects) => require(writeMutant(TICKET_ROUTES, pairs, redirects));
// A route copy that loads a MUTATED subtask-door module.
const doorMutant = (pairs) => routesMutant([], { [require.resolve(DOOR)]: writeMutant(DOOR, pairs) });

describe('the mutation harness', () => {
  test('an absent anchor and an ambiguous anchor both throw', () => {
    expect(() => writeMutant(DOOR, [['this text is nowhere in the door', 'x']])).toThrow('anchor not found');
    expect(() => writeMutant(DOOR, [['organization_id', 'x']])).toThrow('anchor not found');
  });

  test('both source files are CRLF on disk, so the normalisation is load-bearing', () => {
    for (const f of [TICKET_ROUTES, DOOR]) expect(fs.readFileSync(f, 'utf8').indexOf('\r\n')).toBeGreaterThan(-1);
  });

  test('a door mutant is loaded by a DIFFERENT router over the same database', async () => {
    const mut = doorMutant([["throw new Error('myOpenBuildingSql: bad table alias')",
      "throw new Error('MUTANT alias')"]]);
    expect(mut).not.toBe(ticketRouter);
    expect((await mine(mut, CREW)).statusCode).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. THE HEADLINE — and the counterfactual in the same file
 * ═════════════════════════════════════════════════════════════════════════ */
describe('the person who cannot open the job still reaches the work assigned to them', () => {
  test('Carl Crew, with no grant on j1, gets his work order and his building', async () => {
    const r = await mine(null, CREW);
    expect(r.statusCode).toBe(200);
    expect(sorted(r)).toEqual(CARLS);

    const row = rowOf(r, 'st_ip');
    expect(row.my_buildings_open).toBe(1);   // k1 open; k3 is Wendy's, k4 is done
    expect(row.my_buildings_total).toBe(2);  // k1 + k4, both his
    expect(row.my_next_due).toBe('2026-12-01');
    expect(row.buildings).toEqual([
      { id: 'k1', title: 'Bldg 1 - Side A', status: 'open', due_date: '2026-12-01', completed_at: null },
      { id: 'k4', title: 'Bldg 2 - finished', status: 'done', due_date: '2020-01-01', completed_at: null },
    ]);
    expect(r.body.total).toBe(5);
    expect(r.body.buildings_open).toBe(5);
    expect(r.body.has_more).toBe(false);
    expect(r.body.next_offset).toBe(null);
    expect(r.body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('THE COUNTERFACTUAL: the Service Tickets board shows him none of them', async () => {
    // The board runs services/service-ticket-access.js listVisibility. Carl
    // owns j2 and holds no grant on j1, so the widest board view he has hands
    // him exactly one work order — and it is the ONE he has no building on.
    const b = await boardOf(CREW, { view: 'all' });
    expect(b.statusCode).toBe(200);
    expect(sorted(b)).toEqual(['st_j2']);
    for (const id of CARLS) expect(ids(b)).not.toContain(id);
    // So the new door is not redundant: it is the only surface that reaches
    // the five work orders he is personally assigned a building on.
    expect(sorted(await mine(null, CREW))).toEqual(CARLS);
  });

  test('the wide caller sees their own assignments by the same rule, not everything', async () => {
    // Wendy can open every job, but my-buildings is ASSIGNMENT, not access:
    // she gets only the tickets where a live open org building is hers.
    expect(sorted(await mine(null, WIDE))).toEqual(['st_conv', 'st_ip', 'st_j2', 'st_lead']);
  });

  test('a caller with no ticket capability at all still gets their own buildings', async () => {
    // Nora holds nothing, so she is assigned nothing and gets an honest empty
    // answer — not a 403, and not someone else's list.
    const r = await mine(null, NOBODY);
    expect([r.statusCode, r.body.tickets, r.body.total, r.body.buildings_open]).toEqual([200, [], 0, 0]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. ASSIGNMENT IS THE ONLY KEY
 * ═════════════════════════════════════════════════════════════════════════ */
describe('what does not count as a building of mine', () => {
  test('a work order on a job I CAN see, where no building is mine, does not come back', async () => {
    // Carl owns j2, so listVisibility shows him st_j2 (the board test above
    // proves it). Its only building is Wendy's, so this door does not.
    expect(ids(await mine(null, CREW))).not.toContain('st_j2');
    expect(ids(await boardOf(CREW, { view: 'all' }))).toContain('st_j2');
  });

  test('a work order whose only building of mine is done does not come back', async () => {
    expect(ids(await mine(null, CREW))).not.toContain('st_done');
  });

  test('a work order whose only building of mine is archived does not come back', async () => {
    expect(ids(await mine(null, CREW))).not.toContain('st_arch');
  });

  test('a personal to-do carrying a ticket id is not a building', async () => {
    // tasks-routes.js treats a personal row with a service_ticket_id as its
    // owner's own and never a subtask. It must not pull its ticket in here.
    expect(ids(await mine(null, CREW))).not.toContain('st_pers');
    expect(JSON.stringify((await mine(null, CREW)).body)).not.toContain('My own reminder');
  });

  test('an ordinary task assigned to me, on no work order, changes nothing', async () => {
    expect(JSON.stringify((await mine(null, CREW)).body)).not.toContain('Order the latch');
  });

  test('an archived work order does not come back even with an open building of mine', async () => {
    expect(ids(await mine(null, CREW))).not.toContain('st_farch');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. TENANCY
 * ═════════════════════════════════════════════════════════════════════════ */
describe('two organizations', () => {
  test('Rival Ray, assigned nothing in org 1, gets an empty list', async () => {
    // r2 is an org-2 task assigned to him whose service_ticket_id names an
    // ORG-1 work order. It pulls nothing across.
    const r = await mine(null, RIVAL);
    expect(r.statusCode).toBe(200);
    expect(r.body.tickets).toEqual([]);
    expect(r.body.total).toBe(0);
    expect(r.body.buildings_open).toBe(0);
    // And the door is not simply broken for him: his own org's building works.
    eng.db.exec("UPDATE tasks SET assignee_user_id = 50 WHERE id = 'rb1'");
    expect(sorted(await mine(null, RIVAL))).toEqual(['st_rival']);
  });

  test('a building in org 2 whose service_ticket_id names an org-1 ticket never leaks in', async () => {
    // x2 lives in org 2, is assigned to Carl's user id and points at st_x,
    // which is an org-1 work order with no org-1 buildings at all.
    expect(ids(await mine(null, CREW))).not.toContain('st_x');
    expect(JSON.stringify((await mine(null, CREW)).body)).not.toContain('RIVAL');
    expect(JSON.stringify((await mine(null, WIDE)).body)).not.toContain('RIVAL');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. ONLY THE ACTIVE STATUSES
 * ═════════════════════════════════════════════════════════════════════════ */
describe('the statuses this door answers for', () => {
  test('closed, cancelled, draft and approved are absent; the four active ones are present', async () => {
    const got = ids(await mine(null, CREW));
    for (const id of ['st_closed', 'st_cancel', 'st_draft', 'st_appr']) expect(got).not.toContain(id);
    expect(got.slice().sort()).toEqual(CARLS);
    const board = require('../server/services/service-ticket-board');
    expect(board.STATUS_GROUPS.active.slice().sort())
      .toEqual(['in_progress', 'open', 'scheduled', 'work_complete']);
    // Every status in the group is represented by one of the five above.
    const statuses = (await mine(null, CREW)).body.tickets.map((t) => t.status).sort();
    expect(statuses).toEqual(['in_progress', 'in_progress', 'open', 'scheduled', 'work_complete']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. THE PROJECTION
 * ═════════════════════════════════════════════════════════════════════════ */
describe('what a work order may carry to someone who is only a building assignee', () => {
  test('every row has EXACTLY MY_BUILDING_ROW_KEYS, not a subset', async () => {
    const want = ticketRouter.MY_BUILDING_ROW_KEYS.slice().sort();
    expect(want.length).toBeGreaterThan(10);
    const r = await mine(null, CREW);
    for (const row of r.body.tickets) expect(Object.keys(row).sort()).toEqual(want);
  });

  test('a ticket loaded with office text and money hands over none of it', async () => {
    const r = await mine(null, CREW);
    const row = rowOf(r, 'st_proj');
    expect(row).toBeTruthy();
    const blob = JSON.stringify(r.body);
    for (const mark of MARKS) expect(blob).not.toContain(mark);
    expect(blob).not.toContain('REQUESTED_MARK');
    expect(blob).not.toContain('GUEST_MARK');
    expect(blob).not.toMatch(MONEY_RE);
    for (const k of ['internal_notes', 'scope_proposed', 'scope_approved', 'materials',
      'crew_takeoff', 'guest_log', 'requested_by', 'assignee_user_id', 'created_by',
      'organization_id', 'checklist']) {
      expect(Object.prototype.hasOwnProperty.call(row, k)).toBe(false);
    }
    // And the row really was seeded with all of it.
    const raw = eng.all("SELECT internal_notes, scope_approved, materials FROM service_tickets WHERE id = 'st_proj'")[0];
    expect(raw.internal_notes).toContain('INTERNAL_ONLY_MARK');
    expect(raw.scope_approved).toContain('APPROVED_MARK');
    expect(raw.materials).toContain('MATERIAL_MARK');
  });

  test('the deliberate widening: the job number, job title, address and ticket title DO travel', async () => {
    // Carl cannot open j1 at all. He is told where to go and nothing else.
    const row = rowOf(await mine(null, CREW), 'st_ip');
    expect(row.job_number).toBe('86-1001');
    expect(row.job_title).toBe('Latitude at Wekiva');
    expect(row.street_address).toBe('1200 Latitude Way');
    expect(row.city).toBe('Apopka');
    expect(row.title).toBe('Latitude punch list');
    expect(row.ticket_number).toBe('WO-1001');
    expect(row.lead_title).toBe(null);
  });

  test('a lead-only work order names its lead, a converted one names its job', async () => {
    const r = await mine(null, WIDE);
    expect(rowOf(r, 'st_lead').lead_title).toBe('Maple St reroof');
    expect(rowOf(r, 'st_lead').job_number).toBe(null);
    expect(rowOf(r, 'st_conv').lead_title).toBe(null);   // it belongs to the job now
    expect(rowOf(r, 'st_conv').job_number).toBe('86-1001');
  });

  test('is_overdue is a boolean decided against the caller own day, and ordering is by due date', async () => {
    const r = await mine(null, CREW);
    expect(rowOf(r, 'st_op').is_overdue).toBe(true);    // due 2000-01-01
    expect(rowOf(r, 'st_ip').is_overdue).toBe(false);   // due 2999-01-01
    expect(rowOf(r, 'st_wc').is_overdue).toBe(false);   // no due date
    expect(ids(r)).toEqual(['st_op', 'st_ip', 'st_sched', 'st_proj', 'st_wc']);
  });

  test('each building carries exactly five keys', async () => {
    const row = rowOf(await mine(null, CREW), 'st_ip');
    for (const b of row.buildings) {
      expect(Object.keys(b).sort()).toEqual(['completed_at', 'due_date', 'id', 'status', 'title']);
    }
  });

  test('a ticket with no buildings of mine on the page never appears, so buildings is never empty', async () => {
    const r = await mine(null, CREW);
    for (const row of r.body.tickets) expect(row.buildings.length).toBeGreaterThan(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. PAGING AND COUNT_ONLY
 * ═════════════════════════════════════════════════════════════════════════ */
describe('paging', () => {
  test('limit=1 over five matching work orders pages, and the pages add up', async () => {
    const p0 = await mine(null, CREW, { limit: '1' });
    expect(ids(p0)).toEqual(['st_op']);
    expect(p0.body.has_more).toBe(true);
    expect(p0.body.next_offset).toBe(1);
    expect(p0.body.total).toBe(5);
    expect(p0.body.buildings_open).toBe(5);

    const p1 = await mine(null, CREW, { limit: '1', offset: '1' });
    expect(ids(p1)).toEqual(['st_ip']);
    expect(p1.body.next_offset).toBe(2);

    const last = await mine(null, CREW, { limit: '4', offset: '4' });
    expect(ids(last)).toEqual(['st_wc']);
    expect([last.body.has_more, last.body.next_offset]).toEqual([false, null]);

    // Every page concatenated is the whole list, once each.
    const walked = [];
    let offset = 0;
    for (let guard = 0; guard < 10; guard++) {
      const page = await mine(null, CREW, { limit: '2', offset: String(offset) });
      walked.push(...ids(page));
      if (!page.body.has_more) break;
      offset = page.body.next_offset;
    }
    expect(walked).toEqual(['st_op', 'st_ip', 'st_sched', 'st_proj', 'st_wc']);
  });

  test('count_only=1 answers the two numbers and nothing else', async () => {
    const r = await mine(null, CREW, { count_only: '1' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ total: 5, buildings_open: 5 });
    expect(Object.prototype.hasOwnProperty.call(r.body, 'tickets')).toBe(false);
  });

  test('count_only runs neither the rows statement nor the buildings statement', async () => {
    const before = eng.log.length;
    await mine(null, CREW, { count_only: '1' });
    const sqls = eng.log.slice(before).map((e) => e.sql);
    expect(sqls.some((s) => /my_buildings_open/.test(s))).toBe(false);
    expect(sqls.some((s) => /service_ticket_id = ANY/.test(s))).toBe(false);
    expect(sqls.some((s) => /COUNT\(\*\)/.test(s))).toBe(true);
  });

  test('a silly limit or offset is clamped, never trusted into the SQL', async () => {
    expect((await mine(null, CREW, { limit: '99999' })).body.tickets.length).toBe(5);
    expect((await mine(null, CREW, { limit: '0' })).body.tickets.length).toBe(5);   // 0 -> the default 50
    expect((await mine(null, CREW, { limit: '-3' })).body.tickets.length).toBe(1);  // clamped up to 1
    expect((await mine(null, CREW, { offset: '-5' })).body.tickets.length).toBe(5);
    expect((await mine(null, CREW, { offset: '99999' })).body.tickets.length).toBe(0);
    expect((await mine(null, CREW, { limit: 'DROP TABLE tasks' })).statusCode).toBe(200);
    expect(eng.all('SELECT COUNT(*) AS n FROM tasks')[0].n).toBeGreaterThan(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 7. ROUTE ORDER — Express picks the layer, not this file
 * ═════════════════════════════════════════════════════════════════════════ */
describe('the new routes are declared above /:id', () => {
  test('GET /my-buildings answers 200 and is NOT swallowed as a missing ticket', async () => {
    const r = await driveUrl(ticketRouter, 'get', '/my-buildings', CREW);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toEqual({ error: 'Service ticket not found' });
    expect(Array.isArray(r.body.tickets)).toBe(true);
    expect(r.body.tickets.map((t) => t.id).sort()).toEqual(CARLS);
  });

  test('GET /building-counts is not swallowed either', async () => {
    const r = await driveUrl(ticketRouter, 'get', '/building-counts?entity_type=job&entity_id=j1', WIDE);
    expect(r.body).not.toEqual({ error: 'Service ticket not found' });
    // No query parser is mounted on a bare Router, so the handler sees no
    // entity_type and answers its own 404 — which is still proof that IT, and
    // not loadOwnedTicket, handled the request.
    expect(r.body).toEqual({ error: 'Not found' });
  });

  test('and a real ticket id still reaches GET /:id', async () => {
    const r = await driveUrl(ticketRouter, 'get', '/st_ip', WIDE);
    expect(r.statusCode).toBe(200);
    expect(r.body.ticket.id).toBe('st_ip');
  });

  test('structurally, both layers are declared before the /:id layer', () => {
    const at = (p) => ticketRouter.stack.findIndex((l) => l.route && l.route.path === p && l.route.methods.get);
    expect(at('/my-buildings')).toBeGreaterThan(-1);
    expect(at('/building-counts')).toBeGreaterThan(-1);
    expect(at('/my-buildings')).toBeLessThan(at('/:id'));
    expect(at('/building-counts')).toBeLessThan(at('/:id'));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 8. BUILDING-COUNTS — the line above a Tasks panel
 * ═════════════════════════════════════════════════════════════════════════ */
describe('building-counts', () => {
  test('a job counts only live org buildings, open, on active work orders', async () => {
    const r = await counts(null, WIDE, { entity_type: 'job', entity_id: 'j1' });
    expect(r.statusCode).toBe(200);
    // k1 + k3 (st_ip), s1, w1, op1, pr1, c1 = 7 buildings over 6 work orders.
    // Excluded: k4/d1 done, ar1 archived, p1 personal, fa1 on an archived
    // ticket, cl1/cn1/dr1/ap1 on closed/cancelled/draft/approved ones, q1 on
    // another job, x2 in another org.
    expect(r.body).toEqual({ buildings_open: 7, work_orders: 6 });
  });

  test('a converted lead counts on the job, not the lead', async () => {
    // st_conv carries job_id j1 AND lead_id l2, so parentOf calls it the job's.
    expect((await counts(null, WIDE, { entity_type: 'lead', entity_id: 'l2' })).body)
      .toEqual({ buildings_open: 0, work_orders: 0 });
    // l1's own lead-only ticket does count on the lead.
    expect((await counts(null, WIDE, { entity_type: 'lead', entity_id: 'l1' })).body)
      .toEqual({ buildings_open: 1, work_orders: 1 });
  });

  test('none is zero, never a 404', async () => {
    expect((await counts(null, WIDE, { entity_type: 'job', entity_id: 'j2' })).body)
      .toEqual({ buildings_open: 1, work_orders: 1 });
    eng.db.exec("DELETE FROM tasks WHERE service_ticket_id = 'st_j2'");
    const r = await counts(null, WIDE, { entity_type: 'job', entity_id: 'j2' });
    expect([r.statusCode, r.body]).toEqual([200, { buildings_open: 0, work_orders: 0 }]);
  });

  test('the narrow tier with no grant gets the SAME body a missing job gets', async () => {
    // ticketAccessOk maps not_assigned to 404 with the missing-job sentence,
    // so an in-org user cannot learn which jobs exist by asking.
    const refused = await counts(null, CREW, { entity_type: 'job', entity_id: 'j1' });
    const absent = await counts(null, CREW, { entity_type: 'job', entity_id: 'nope' });
    expect([refused.statusCode, refused.body]).toEqual([404, { error: 'Job not found' }]);
    expect([absent.statusCode, absent.body]).toEqual([404, { error: 'Job not found' }]);
    // But the job he OWNS answers.
    expect((await counts(null, CREW, { entity_type: 'job', entity_id: 'j2' })).body)
      .toEqual({ buildings_open: 1, work_orders: 1 });
  });

  test('no job capability at all is the file house 403, naming the capabilities', async () => {
    const r = await counts(null, NOBODY, { entity_type: 'job', entity_id: 'j1' });
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toContain('Missing capability');
  });

  test('another tenant job is a 404, never a 403 existence oracle', async () => {
    const r = await counts(null, WIDE, { entity_type: 'job', entity_id: 'j9' });
    expect([r.statusCode, r.body]).toEqual([404, { error: 'Job not found' }]);
    const rival = await counts(null, RIVAL, { entity_type: 'job', entity_id: 'j1' });
    expect([rival.statusCode, rival.body]).toEqual([404, { error: 'Job not found' }]);
  });

  test('a bad or missing entity_type is a flat 404', async () => {
    for (const q of [{}, { entity_type: 'client', entity_id: 'j1' }, { entity_type: 'job' }]) {
      const r = await counts(null, WIDE, q);
      expect(r.statusCode).toBe(404);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 9. MUTANTS
 * ═════════════════════════════════════════════════════════════════════════ */
describe('each rule, removed, makes a named assertion above go red', () => {
  test('(a) without `wob.assignee_user_id = $n`, Carl gets work orders he is not assigned', async () => {
    const mut = doorMutant([[
      "    ' AND wob.assignee_user_id = ' + me + ')';",
      "    ' AND ' + me + ' IS NOT NULL)';",
    ]]);
    const got = ids(await mine(mut, CREW));
    expect(got).toContain('st_j2');    // Wendy's building, on Carl's own job
    expect(got).toContain('st_conv');  // Wendy's building, on a job he cannot open
    expect(got).toContain('st_lead');
    // The shipped door does not.
    const shipped = ids(await mine(null, CREW));
    for (const id of ['st_j2', 'st_conv', 'st_lead']) expect(shipped).not.toContain(id);
  });

  test("(b) without `wob.scope = 'org'`, a private to-do drags its work order in", async () => {
    const mut = doorMutant([["    \" AND wob.scope = 'org'\" +\n", '    "" +\n']]);
    expect(ids(await mine(mut, CREW))).toContain('st_pers');
    expect(ids(await mine(null, CREW))).not.toContain('st_pers');
  });

  test('(c) THE REGRESSION: gated on listVisibility, Carl loses every work order he is assigned', async () => {
    const mut = routesMutant([[
      `    const baseWhere =
      't.organization_id = $1 AND t.archived_at IS NULL AND ' + activeStatusIn('t') +
      ' AND ' + subtaskDoor.myOpenBuildingSql('t', '$2');`,
      `    const vis = access.listVisibility(req.user);
    const visArm = vis.jobs === 'all' ? 't.job_id IS NOT NULL'
      : (vis.jobs === 'assigned' && vis.userId != null
        ? '(t.job_id IS NOT NULL AND (EXISTS (SELECT 1 FROM jobs mj WHERE mj.id = t.job_id AND mj.owner_id = $2) OR EXISTS (SELECT 1 FROM job_access ma WHERE ma.job_id = t.job_id AND ma.user_id = $2)))'
        : '(1 = 0)');
    const baseWhere =
      't.organization_id = $1 AND t.archived_at IS NULL AND ' + activeStatusIn('t') +
      ' AND ' + visArm;`,
    ]]);
    const got = await mine(mut, CREW);
    // The gate returns exactly the wrong set: the one work order he can SEE
    // and has no building on, and none of the five he is assigned by name.
    expect(ids(got)).toEqual(['st_j2']);
    for (const id of CARLS) expect(ids(got)).not.toContain(id);
    // And it hands him no building at all to open.
    expect(got.body.tickets.every((t) => t.buildings.length === 0)).toBe(true);
    expect(sorted(await mine(null, CREW))).toEqual(CARLS);
  });

  test('(d) shaping with the raw row instead of MY_BUILDING_ROW_KEYS leaks the office text', async () => {
    const mut = routesMutant([
      [
        "      `SELECT t.id, t.ticket_number, t.title, t.status, t.priority,\n              t.scheduled_for, t.due_date, t.street_address, t.city,\n              t.job_id, t.lead_id,\n",
        '      `SELECT t.*,\n',
      ],
      [
        '  const shaped = {};\n  MY_BUILDING_ROW_KEYS.forEach(function (k) { shaped[k] = out[k]; });\n  return shaped;',
        '  return Object.assign({}, r, out);',
      ],
    ]);
    const r = await mine(mut, CREW);
    const blob = JSON.stringify(r.body);
    expect(blob).toContain('INTERNAL_ONLY_MARK');
    expect(blob).toContain('APPROVED_MARK');
    expect(blob).toMatch(MONEY_RE);
    // ... which is exactly what the exact-keys assertion catches.
    const want = ticketRouter.MY_BUILDING_ROW_KEYS.slice().sort();
    expect(Object.keys(rowOf(r, 'st_proj')).sort()).not.toEqual(want);
  });

  test('(e) without the org predicate on the per-row counts, another tenant building is counted', async () => {
    const mut = routesMutant([[
      '                WHERE bo.service_ticket_id = t.id AND bo.organization_id = t.organization_id\n',
      '                WHERE bo.service_ticket_id = t.id\n',
    ]]);
    // r2 is an org-2 task on st_ip. It is not Carl's, so use the wide caller
    // whose own st_ip count is unaffected — the point is the count moves.
    const shipped = rowOf(await mine(null, CREW), 'st_ip').my_buildings_open;
    eng.db.exec("UPDATE tasks SET assignee_user_id = 20 WHERE id = 'r2'");
    expect(rowOf(await mine(mut, CREW), 'st_ip').my_buildings_open).toBe(shipped + 1);
    expect(rowOf(await mine(null, CREW), 'st_ip').my_buildings_open).toBe(shipped);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 10. THE TWO PREDICATES
 * ═════════════════════════════════════════════════════════════════════════ */
describe('notAWorkOrderBuildingSql and myOpenBuildingSql', () => {
  test('the negation is exactly the string every task list will paste into its WHERE', () => {
    expect(door.notAWorkOrderBuildingSql('t'))
      .toBe("(t.service_ticket_id IS NULL OR t.scope = 'personal')");
    expect(door.notAWorkOrderBuildingSql('k'))
      .toBe("(k.service_ticket_id IS NULL OR k.scope = 'personal')");
  });

  test("the personal arm is load-bearing: it is the negation of isWorkOrderSubtask, not of `service_ticket_id IS NULL`", () => {
    // A private to-do carrying a ticket id is its owner's, never a building.
    expect(door.isWorkOrderSubtask({ scope: 'personal', service_ticket_id: 'st_ip' })).toBe(false);
    expect(door.isWorkOrderSubtask({ scope: 'org', service_ticket_id: 'st_ip' })).toBe(true);
    expect(door.notAWorkOrderBuildingSql('t')).toContain("scope = 'personal'");
    // And it is executed, not just asserted: the personal row survives the
    // predicate while the org one is removed by it.
    const rows = eng.all(
      "SELECT id FROM tasks WHERE organization_id = 1 AND archived_at IS NULL AND " +
      door.notAWorkOrderBuildingSql('tasks') + " AND id IN ('p1','k1','plain') ORDER BY id"
    ).map((r) => r.id);
    expect(rows).toEqual(['p1', 'plain']);
  });

  test('archived_at is deliberately not repeated — the base WHERE already carries it', () => {
    expect(door.notAWorkOrderBuildingSql('t')).not.toContain('archived_at');
  });

  test('myOpenBuildingSql is the exact EXISTS the door documents', () => {
    expect(door.myOpenBuildingSql('t', '$2')).toBe(
      'EXISTS (SELECT 1 FROM tasks wob WHERE wob.service_ticket_id = t.id' +
      ' AND wob.organization_id = t.organization_id AND wob.archived_at IS NULL' +
      " AND wob.scope = 'org' AND wob.status <> 'done' AND wob.assignee_user_id = $2)"
    );
  });

  test('both refuse an alias that is not an identifier, and a user that is not a $n parameter', () => {
    for (const bad of ['t; DROP', '1t', 't-1', 'a b', '']) {
      expect(() => door.notAWorkOrderBuildingSql(bad)).toThrow('notAWorkOrderBuildingSql: bad table alias');
      expect(() => door.myOpenBuildingSql(bad, '$2')).toThrow('myOpenBuildingSql: bad table alias');
    }
    for (const bad of ['2', '$', '$a', '20', "$1 OR 1=1", 20]) {
      expect(() => door.myOpenBuildingSql('t', bad)).toThrow('myOpenBuildingSql: the user must be a $n parameter');
    }
  });

  test('the door does NOT add an arm to work-order-recipients myTicketRelationSql', () => {
    // An arm there would make every building assignee an approver in "My
    // approvals" and break the SQL/RELATIONS invariant that
    // test/work-order-recipients.test.js pins.
    const recipients = require('../server/services/work-order-recipients');
    const sql = recipients.myTicketRelationSql('t', '$2');
    expect(sql).not.toContain('wob');
    expect(sql).not.toContain('tasks');
    expect(recipients.RELATIONS).toEqual(['pm', 'creator', 'sender', 'assignee', 'salesperson', 'participant']);
  });
});
