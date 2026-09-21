// THE OFFICE TICKET READS, WIRED TO 1.29 (Work Orders, unit W4-C).
//
// server/routes/service-ticket-routes.js carries four 1.29 reads the office
// screen builds on. Each is driven through the REAL router over node:sqlite
// (the pg shim) with a signed JWT, then removed from a temp copy of the routes
// to watch the same drive go wrong:
//
//   1. GET /:id — flags (the problems the crew flagged, this org's only),
//      change_orders (a whitelist: no lines, no money, never another org's
//      forged record), tasks[].notes[].id (so a change order can start from a
//      building note) and office_seen (stamped only by someone who can EDIT
//      the ticket, never by a view grant). Every one is best-effort: a failed
//      read leaves it empty and the ticket still opens.
//   2. GET / (the plain list) — open_flags, pending_suggestions, last_crew_at,
//      office_seen_at and new_from_crew (services/service-ticket-flags.js
//      ATTENTION_COLUMNS + withAttention), and co_draft_count
//      (services/service-ticket-change-order.js coDraftCounts). A link merely
//      being opened is not crew activity.
//   3. The office building door still decides on the LOCKED row.
//
// Mutants follow the house rule: a copy in the OS temp dir, CRLF normalised,
// every anchor exactly once or 'anchor not found'.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const TICKET_ROUTES = path.join(SERVER_DIR, 'routes', 'service-ticket-routes.js');
const FLAGS = path.join(SERVER_DIR, 'services', 'service-ticket-flags.js');
const CO_SERVICE = path.join(SERVER_DIR, 'services', 'service-ticket-change-order.js');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks', 'attachments',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares',
  'service_ticket_revisions', 'service_ticket_participants',
  'service_ticket_flags', 'job_change_orders',
];

const WIDE = 10;     // jobs wide: may edit every ticket
const CREW = 20;     // narrow tier with an EDIT grant on j1
const VIEWER = 30;   // narrow tier with a VIEW grant on j1
const RIVAL = 50;    // another organization

const USERS = {
  [WIDE]: { role: 'st_wide', org: 1, name: 'Paula PM' },
  [CREW]: { role: 'st_crew', org: 1, name: 'Carl Crew' },
  [VIEWER]: { role: 'st_crew', org: 1, name: 'Vera Viewer' },
  [RIVAL]: { role: 'st_wide', org: 2, name: 'Rival Ray' },
};

const CO_KEYS = ['id', 'co_number', 'status', 'title', 'source_kind', 'source_id', 'task_id', 'created_at'];

let eng;
let auth;
let db;
let ticketRouter;
const made = [];

function coData(o) {
  return JSON.stringify(Object.assign({
    title: 'Extra rot',
    lines: [{ description: 'Rot', qty: 1, unit: 'ea', unitCost: 4321, unitSell: 9876 }],
    total: 9876,
  }, o)).replace(/'/g, "''");
}

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  const fromNote = coData({ fromWorkOrder: { v: 1, ticketId: 'st_a', source: { kind: 'building_note', id: 'ev_note1', taskId: 'k1' } } });
  const fromTicket = coData({ title: 'Second extra', fromWorkOrder: { v: 1, ticketId: 'st_a', source: { kind: 'ticket', id: null, taskId: null } } });
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM tasks; DELETE FROM attachments;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_participants;
    DELETE FROM service_ticket_flags; DELETE FROM job_change_orders;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('st_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('st_crew', ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])});
    INSERT INTO users (id, name, email, role, organization_id, active) VALUES
      (10, 'Paula PM', 'p@agx.test', 'st_wide', 1, 1),
      (20, 'Carl Crew', 'c@agx.test', 'st_crew', 1, 1),
      (30, 'Vera Viewer', 'v@agx.test', 'st_crew', 1, 1),
      (50, 'Rival Ray', 'r@rival.test', 'st_wide', 2, 1);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES
      ('j1', 10, '{}', 1), ('j2', 10, '{}', 1), ('j9', 50, '{}', 2);
    INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j1', 20, 'edit'), ('j1', 30, 'view');

    INSERT INTO service_tickets (id, organization_id, title, job_id, status, priority, checklist,
        approval_notice_attempts, office_seen_at, created_at) VALUES
      ('st_a',  1, 'Stairs on 784', 'j1', 'in_progress', 'normal', '[]', 0, NULL, '2026-09-01 10:00:01'),
      ('st_b',  1, 'Link opened',   'j1', 'open',        'normal', '[]', 0, NULL, '2026-09-01 10:00:02'),
      ('st_c',  1, 'Quiet one',     'j2', 'open',        'normal', '[]', 0, NULL, '2026-09-01 10:00:03'),
      ('st_cl', 1, 'Closed one',    'j1', 'closed',      'normal', '[]', 0, NULL, '2026-09-01 10:00:04'),
      ('st_r',  2, 'RIVAL ticket',  'j9', 'open',        'normal', '[]', 0, NULL, '2026-09-01 10:00:05');

    INSERT INTO tasks (id, organization_id, title, status, scope, owner_user_id, service_ticket_id, entity_type, entity_id, created_at) VALUES
      ('k1',   1, 'Bldg 784 — Side A: rail post', 'done', 'org', NULL, 'st_a',  'job', 'j1', '2026-09-02 08:00:01'),
      ('k2',   1, 'Bldg 790 — Side B: tread 3',   'open', 'org', NULL, 'st_a',  'job', 'j1', '2026-09-02 08:00:02'),
      ('k_cl', 1, 'Bldg 12',                      'open', 'org', NULL, 'st_cl', 'job', 'j1', '2026-09-02 08:00:03');

    INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, tags, organization_id, position) VALUES
      ('ph1', 'task', 'k1',   'a.jpg', 'image/jpeg', '["completion"]', 1, 0),
      ('ph2', 'task', 'k_cl', 'b.jpg', 'image/jpeg', '["completion"]', 1, 0);

    -- st_a: the crew wrote a building note through a link. st_b: a link was
    -- only OPENED. st_r: another tenant's crew.
    INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, actor_label, detail, created_at) VALUES
      ('ev_note1', 1, 'st_a', 'subtask_note', 'share', 'Marco', '{"task_id":"k1","note":"Rot behind the siding"}', '2026-09-10 10:00:00'),
      ('ev_open',  1, 'st_b', 'share_opened', 'share', 'Marco', '{}', '2026-09-10 11:00:00'),
      ('ev_rival', 2, 'st_r', 'subtask_note', 'share', 'Rex',   '{"task_id":"kx","note":"theirs"}', '2026-09-10 12:00:00');

    INSERT INTO service_ticket_revisions (id, organization_id, ticket_id, author_label, fields, note, status, created_at) VALUES
      ('rev1', 1, 'st_a', 'Marco', '{"scope_proposed":"Add a rail"}', 'Found more', 'pending', '2026-09-10 10:30:00');

    -- Problems: one open and one resolved on st_a, and ANOTHER TENANT'S row
    -- that names st_a — only an organization predicate keeps it out.
    INSERT INTO service_ticket_flags (id, organization_id, ticket_id, task_id, share_id, author_label, category, note, attachment_ids, status, resolved_by, resolved_at, resolution_note, client_ref, created_at) VALUES
      ('fl_open',  1, 'st_a', 'k1', NULL, 'Marco', 'extra_damage', 'Joist is rotten', '[]', 'open',     NULL, NULL, NULL, NULL, '2026-09-10 10:05:00'),
      ('fl_done',  1, 'st_a', NULL, NULL, 'Marco', 'no_access',    'Gate locked',     '[]', 'resolved', 10, '2026-09-10 10:20:00', 'Code 4411', NULL, '2026-09-10 10:10:00'),
      ('fl_rival', 2, 'st_a', NULL, NULL, 'Rex',   'safety',       'RIVAL FORGED FLAG', '[]', 'open',   NULL, NULL, NULL, NULL, '2026-09-10 10:15:00');

    -- Change orders started from st_a: a draft from the note and an approved
    -- one from the ticket. Then a draft on ANOTHER job that names st_a, and a
    -- RIVAL tenant's draft on j1 that names st_a: neither is st_a's.
    INSERT INTO job_change_orders (id, job_id, owner_id, status, co_number, data, organization_id, is_locked, created_at, updated_at) VALUES
      ('co_draft', 'j1', 10, 'draft',    'CO-1',  '${fromNote}',   1, 0, '2026-09-11 09:00:00', '2026-09-11 09:00:00'),
      ('co_appr',  'j1', 10, 'approved', 'CO-2',  '${fromTicket}', 1, 1, '2026-09-11 09:30:00', '2026-09-11 09:30:00'),
      ('co_j2',    'j2', 10, 'draft',    'CO-3',  '${fromNote}',   1, 0, '2026-09-11 10:00:00', '2026-09-11 10:00:00'),
      ('co_rival', 'j1', 50, 'draft',    'CO-99', '${fromNote}',   2, 0, '2026-09-11 10:30:00', '2026-09-11 10:30:00');
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'fields', 'data', 'tags', 'attachment_ids'],
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

const flush = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => {
  seed();
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
});

afterEach(async () => {
  await flush();
  jest.restoreAllMocks();
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
});

afterAll(async () => {
  await flush();
  db.pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
  for (const p of made) {
    try { delete require.cache[require.resolve(p)]; } catch (_) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (_) { /* already gone */ }
  }
});

// ── the drive ─────────────────────────────────────────────────────────────
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.set = () => res;
  return res;
}

function tokenFor(uid) {
  const u = USERS[uid];
  return auth.signToken({ id: uid, email: uid + '@t.test', name: u.name, role: u.role, organization_id: u.org });
}

async function drive(router, method, routePath, opts) {
  const o = opts || {};
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
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

const readTicket = (router, id, as) => drive(router, 'get', '/:id', { as: as || WIDE, params: { id } });
const listTickets = (router, as) => drive(router, 'get', '/', { as: as || WIDE, query: {} });
const done = (router, id, taskId, as) => drive(router, 'post', '/:id/subtasks/:taskId/done',
  { as: as || WIDE, params: { id, taskId }, body: { done: true } });

const row = (id) => eng.all('SELECT * FROM service_tickets WHERE id = ?', id)[0];
const task = (id) => eng.all('SELECT * FROM tasks WHERE id = ?', id)[0];
const listed = (res, id) => (res.body && res.body.tickets ? res.body.tickets.find((t) => t.id === id) : undefined);

// ── mutants ───────────────────────────────────────────────────────────────
function absolutize(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function mutateText(src, edits) {
  let out = src.replace(/\r\n/g, '\n');
  for (const [find, replace] of edits) {
    if (out.split(find).length !== 2) throw new Error('anchor not found');
    out = out.split(find).join(replace);
  }
  return out;
}

function writeCopy(file, edits, redirects) {
  let src = absolutize(mutateText(fs.readFileSync(file, 'utf8'), edits), path.dirname(file));
  for (const [from, to] of Object.entries(redirects || {})) {
    const ref = 'require(' + JSON.stringify(from.split(path.sep).join('/')) + ')';
    if (src.split(ref).length < 2) throw new Error('anchor not found');
    src = src.split(ref).join('require(' + JSON.stringify(to.split(path.sep).join('/')) + ')');
  }
  const p = path.join(os.tmpdir(), '_p86_w4c_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, src, 'utf8');
  made.push(p);
  return p;
}

const routesMutant = (edits, redirects) => require(writeCopy(TICKET_ROUTES, edits, redirects));

describe('the mutation harness', () => {
  test('an absent anchor and an ambiguous anchor both throw', () => {
    expect(() => routesMutant([['this text is nowhere in the routes', 'x']])).toThrow('anchor not found');
    expect(() => routesMutant([["    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });\n", 'x']]))
      .toThrow('anchor not found');
  });

  test('the routes and the flag service are CRLF on disk', () => {
    for (const f of [TICKET_ROUTES, FLAGS]) expect(fs.readFileSync(f, 'utf8').indexOf('\r\n')).toBeGreaterThan(-1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. GET /:id
 * ══════════════════════════════════════════════════════════════════════════*/
describe('1. the office ticket read', () => {
  test('change_orders: this work order\'s, oldest first, only the whitelisted keys, no money', async () => {
    const r = await readTicket(ticketRouter, 'st_a');
    expect(r.statusCode).toBe(200);
    const cos = r.body.change_orders;
    expect(cos.map((c) => c.id)).toEqual(['co_draft', 'co_appr']);
    for (const c of cos) expect(Object.keys(c)).toEqual(CO_KEYS);
    expect(cos[0]).toMatchObject({
      co_number: 'CO-1', status: 'draft', title: 'Extra rot',
      source_kind: 'building_note', source_id: 'ev_note1', task_id: 'k1',
    });
    expect(cos[1]).toMatchObject({ co_number: 'CO-2', status: 'approved', source_kind: 'ticket', source_id: null });
    const text = JSON.stringify(cos);
    for (const poison of ['4321', '9876', 'lines', 'unitCost', 'CO-99', 'CO-3']) expect(text).not.toContain(poison);
  });

  test('change_orders is empty on a ticket nothing was started from, and a lead-less job ticket is fine', async () => {
    expect((await readTicket(ticketRouter, 'st_b')).body.change_orders).toEqual([]);
  });

  test('flags: this org\'s problems on this ticket, open first, the office shape', async () => {
    const r = await readTicket(ticketRouter, 'st_a');
    expect(r.body.flags.map((f) => f.id)).toEqual(['fl_open', 'fl_done']);
    expect(r.body.flags[0]).toMatchObject({
      id: 'fl_open', task_id: 'k1', task_title: 'Bldg 784 — Side A: rail post', category: 'extra_damage',
      note: 'Joist is rotten', status: 'open', photos: [],
    });
    expect(r.body.flags[1]).toMatchObject({ id: 'fl_done', status: 'resolved', resolved_by_name: 'Paula PM', resolution_note: 'Code 4411' });
    const text = JSON.stringify(r.body.flags);
    expect(text).not.toContain('RIVAL FORGED FLAG');
    for (const k of ['organization_id', 'share_id', 'client_ref', 'attachment_ids']) {
      expect(Object.prototype.hasOwnProperty.call(r.body.flags[0], k)).toBe(false);
    }
  });

  test('building notes carry their event id on the office read', async () => {
    const r = await readTicket(ticketRouter, 'st_a');
    const k1 = r.body.tasks.find((t) => t.id === 'k1');
    expect(k1.notes).toEqual([expect.objectContaining({ id: 'ev_note1', note: 'Rot behind the siding', by: 'Marco' })]);
  });

  test('office_seen: an editor\'s read stamps office_seen_at and says so', async () => {
    expect(row('st_a').office_seen_at).toBeNull();
    const r = await readTicket(ticketRouter, 'st_a', WIDE);
    expect(r.body.office_seen).toBe(true);
    expect(row('st_a').office_seen_at).toBeTruthy();
    // An edit grant is someone who can edit it too.
    eng.db.exec("UPDATE service_tickets SET office_seen_at = NULL WHERE id = 'st_a'");
    expect((await readTicket(ticketRouter, 'st_a', CREW)).body.office_seen).toBe(true);
    expect(row('st_a').office_seen_at).toBeTruthy();
  });

  test('office_seen: a VIEW grant reads the ticket but stamps nothing', async () => {
    const r = await readTicket(ticketRouter, 'st_a', VIEWER);
    expect(r.statusCode).toBe(200);
    expect(r.body.office_seen).toBe(false);
    expect(row('st_a').office_seen_at).toBeNull();
    // It still sees what the office sees.
    expect(r.body.flags.map((f) => f.id)).toEqual(['fl_open', 'fl_done']);
    expect(r.body.change_orders.map((c) => c.id)).toEqual(['co_draft', 'co_appr']);
    // Opening it never bumps updated_at either.
    expect(row('st_a').updated_at).toBeNull();
  });

  test('another tenant gets the ticket 404, reads none of it and stamps nothing', async () => {
    const r = await readTicket(ticketRouter, 'st_a', RIVAL);
    expect([r.statusCode, r.body]).toEqual([404, { error: 'Service ticket not found' }]);
    expect(row('st_a').office_seen_at).toBeNull();
  });

  test('every 1.29 read is best-effort: flags, change orders and the stamp failing still open the ticket', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    db.pool.query = async (sql, params) => {
      const text = String(sql);
      if (/FROM service_ticket_flags f/.test(text) || /FROM job_change_orders co/.test(text)
          || /SET office_seen_at = NOW\(\)/.test(text)) {
        throw new Error('boom');
      }
      return eng.pool.query(sql, params);
    };
    const r = await readTicket(ticketRouter, 'st_a');
    expect(r.statusCode).toBe(200);
    expect([r.body.flags, r.body.change_orders, r.body.office_seen]).toEqual([[], [], false]);
    expect(r.body.ticket.id).toBe('st_a');
  });

  test('MUTANT: subtaskActivity without withIds and the notes lose the id a change order starts from', async () => {
    const mut = routesMutant([['workOrder.subtaskActivity(pool, orgId, ticket.id, { withIds: true }),', 'workOrder.subtaskActivity(pool, orgId, ticket.id),']]);
    const k1 = (await readTicket(mut, 'st_a')).body.tasks.find((t) => t.id === 'k1');
    expect(k1.notes[0].note).toBe('Rot behind the siding');
    expect(Object.prototype.hasOwnProperty.call(k1.notes[0], 'id')).toBe(false);
  });

  test('MUTANT: change_orders and flags left off the answer', async () => {
    const mut = routesMutant([
      ['      change_orders: Array.isArray(changeOrders) ? changeOrders : [],\n', ''],
      ['      flags: Array.isArray(flags) ? flags : [],\n', ''],
    ]);
    const r = await readTicket(mut, 'st_a');
    expect(r.statusCode).toBe(200);
    expect(r.body.change_orders).toBeUndefined();
    expect(r.body.flags).toBeUndefined();
  });

  test('MUTANT: the flags read without its catch and a failing flags table 500s the whole ticket', async () => {
    const mut = routesMutant([[
      "      (async () => flagSvc.listOfficeFlags(pool, ticket))().catch((e) => {\n"
        + "        console.warn('[service-tickets] flags read failed', e && e.message);\n"
        + '        return [];\n'
        + '      }),\n',
      '      flagSvc.listOfficeFlags(pool, ticket),\n']]);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    db.pool.query = async (sql, params) => {
      if (/FROM service_ticket_flags f/.test(String(sql))) throw new Error('boom');
      return eng.pool.query(sql, params);
    };
    expect((await readTicket(mut, 'st_a')).statusCode).toBe(500);
  });

  test('MUTANT: never stamping office_seen and opening the ticket leaves New from crew on', async () => {
    const mut = routesMutant([[
      '      (async () => flagSvc.markOfficeSeen(pool, req.user, ticket, orgId))().catch(() => false),\n',
      '      Promise.resolve(false),\n']]);
    const r = await readTicket(mut, 'st_a');
    expect(r.body.office_seen).toBe(false);
    expect(row('st_a').office_seen_at).toBeNull();
    expect(listed(await listTickets(ticketRouter), 'st_a').new_from_crew).toBe(true);
  });

  test('MUTANT: linkedChangeOrders without its org predicate lists the rival tenant\'s forged record', async () => {
    const coCopy = writeCopy(CO_SERVICE, [[
      "        WHERE co.job_id = $1 AND co.organization_id = $2\n          AND co.data->'fromWorkOrder'->>'ticketId' = $3\n        ORDER BY co.created_at ASC`,",
      "        WHERE co.job_id = $1 AND $2 IS NOT NULL\n          AND co.data->'fromWorkOrder'->>'ticketId' = $3\n        ORDER BY co.created_at ASC`,"]]);
    const mut = routesMutant([], { [CO_SERVICE]: coCopy });
    const r = await readTicket(mut, 'st_a');
    expect(r.body.change_orders.map((c) => c.co_number)).toEqual(['CO-1', 'CO-2', 'CO-99']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. GET / (the plain list)
 * ══════════════════════════════════════════════════════════════════════════*/
describe('2. the list carries attention and draft change orders', () => {
  test('open_flags, pending_suggestions, new_from_crew and co_draft_count per row', async () => {
    const r = await listTickets(ticketRouter);
    expect(r.statusCode).toBe(200);
    const a = listed(r, 'st_a');
    expect([a.open_flags, a.pending_suggestions, a.new_from_crew, a.co_draft_count]).toEqual([1, 1, true, 1]);
    expect(a.last_crew_at).toBeTruthy();
    expect(a.office_seen_at).toBeNull();
    const c = listed(r, 'st_c');
    expect([c.open_flags, c.pending_suggestions, c.new_from_crew, c.co_draft_count]).toEqual([0, 0, false, 0]);
    // Numbers, not strings.
    expect(typeof a.open_flags).toBe('number');
    expect(typeof a.co_draft_count).toBe('number');
  });

  test('a link only being opened is not crew activity', async () => {
    const b = listed(await listTickets(ticketRouter), 'st_b');
    expect(b.last_crew_at).toBeNull();
    expect(b.new_from_crew).toBe(false);
  });

  test('an editor opening the ticket clears New from crew; a later crew write brings it back', async () => {
    expect((await readTicket(ticketRouter, 'st_a', WIDE)).body.office_seen).toBe(true);
    expect(listed(await listTickets(ticketRouter), 'st_a').new_from_crew).toBe(false);
    eng.db.exec(`INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, actor_label, detail, created_at)
      VALUES ('ev_late', 1, 'st_a', 'note_added', 'share', 'Marco', '{}', '2999-01-01 00:00:00')`);
    expect(listed(await listTickets(ticketRouter), 'st_a').new_from_crew).toBe(true);
  });

  test('a view grant opening the ticket leaves New from crew on', async () => {
    expect((await readTicket(ticketRouter, 'st_a', VIEWER)).statusCode).toBe(200);
    expect(listed(await listTickets(ticketRouter, VIEWER), 'st_a').new_from_crew).toBe(true);
  });

  test('the rival tenant\'s rows count for nothing here, and its own list shows none of ours', async () => {
    const a = listed(await listTickets(ticketRouter), 'st_a');
    // fl_rival (open, names st_a) and co_rival (draft, names st_a) are not st_a's.
    expect([a.open_flags, a.co_draft_count]).toEqual([1, 1]);
    const theirs = await listTickets(ticketRouter, RIVAL);
    expect(theirs.body.tickets.map((t) => t.id)).toEqual(['st_r']);
    expect(theirs.body.tickets[0]).toMatchObject({ open_flags: 0, co_draft_count: 0, new_from_crew: true });
  });

  test('a failing draft count leaves co_draft_count 0 and the list still answers', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    db.pool.query = async (sql, params) => {
      if (/FROM job_change_orders co/.test(String(sql))) throw new Error('no such table: job_change_orders');
      return eng.pool.query(sql, params);
    };
    const r = await listTickets(ticketRouter);
    expect(r.statusCode).toBe(200);
    expect(listed(r, 'st_a').co_draft_count).toBe(0);
  });

  test('the board mode is not changed by the plain list wiring', async () => {
    const r = await drive(ticketRouter, 'get', '/', { as: WIDE, query: { board: '1', view: 'all' } });
    expect(r.statusCode).toBe(200);
    const a = r.body.tickets.find((t) => t.id === 'st_a');
    expect(Object.prototype.hasOwnProperty.call(a, 'co_draft_count')).toBe(false);
    expect(a.open_flags).toBe(1);
  });

  test('MUTANT: ATTENTION_COLUMNS without the flag org predicate counts the rival tenant\'s forged flag', async () => {
    const flagsCopy = writeCopy(FLAGS, [[
      "service_ticket_flags f WHERE f.ticket_id = t.id AND f.organization_id = t.organization_id AND f.status = 'open'",
      "service_ticket_flags f WHERE f.ticket_id = t.id AND f.status = 'open'"]]);
    const mut = routesMutant([], { [FLAGS]: flagsCopy });
    expect(listed(await listTickets(mut), 'st_a').open_flags).toBe(2);
    expect(listed(await listTickets(ticketRouter), 'st_a').open_flags).toBe(1);
  });

  test('MUTANT: rows not mapped through withAttention have no new_from_crew', async () => {
    const mut = routesMutant([['    const listed = rows.map(flagSvc.withAttention);\n', '    const listed = rows.slice();\n']]);
    const a = listed(await listTickets(mut), 'st_a');
    expect(a.new_from_crew).toBeUndefined();
  });

  test('MUTANT: no draft merge and the list rows have no co_draft_count', async () => {
    const mut = routesMutant([[
      '    for (const t of listed) t.co_draft_count = Number((drafts && drafts[String(t.id)]) || 0);\n', '']]);
    expect(listed(await listTickets(mut), 'st_a').co_draft_count).toBeUndefined();
  });

  test('MUTANT: the attention columns left out of the SELECT and every count reads as nothing', async () => {
    const mut = routesMutant([['              ${taskCountCols},\n              ${flagSvc.ATTENTION_COLUMNS}\n', '              ${taskCountCols}\n']]);
    const a = listed(await listTickets(mut), 'st_a');
    expect(a.open_flags).toBeUndefined();
    expect(a.new_from_crew).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. THE OFFICE BUILDING DOOR
 * ══════════════════════════════════════════════════════════════════════════*/
describe('3. the office subtask door gates on the locked row', () => {
  const GATE_LINE = '      gate: officeSubtaskGate,\n';

  test('a closed work order refuses a building with work_order_locked, nothing written', async () => {
    const r = await done(ticketRouter, 'st_cl', 'k_cl');
    expect([r.statusCode, r.body.code]).toEqual([409, 'work_order_locked']);
    expect(task('k_cl').status).toBe('open');
  });

  test('MUTANT: drop the gate and the closed work order has its building finished', async () => {
    const mut = routesMutant([[GATE_LINE, '']]);
    const r = await done(mut, 'st_cl', 'k_cl');
    expect(r.statusCode).toBe(200);
    expect(task('k_cl').status).toBe('done');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * REPLY ONLY (1.50) — the office card draws a line as reply only from its
 * kind (js/service-tickets.js subtaskHTML), so the read has to carry it.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the office read carries each line\'s kind', () => {
  test('a reply-only line reads kind follow_up; the rest read what they are', async () => {
    eng.db.exec("UPDATE tasks SET kind = 'follow_up' WHERE id = 'k2'; UPDATE tasks SET kind = 'todo' WHERE id = 'k1'");
    const r = await readTicket(ticketRouter, 'st_a');
    expect(r.statusCode).toBe(200);
    expect(r.body.tasks.map((t) => [t.id, t.kind])).toEqual([['k1', 'todo'], ['k2', 'follow_up']]);
  });

  test('MUTANT: the task SELECT without kind -> every line reads as field work and asks for a photo', async () => {
    eng.db.exec("UPDATE tasks SET kind = 'follow_up' WHERE id = 'k2'");
    const mut = routesMutant([[
      'SELECT id, title, status, due_date, assignee_user_id, completed_at, archived_at, kind\n',
      'SELECT id, title, status, due_date, assignee_user_id, completed_at, archived_at\n']]);
    const r = await readTicket(mut, 'st_a');
    expect(r.statusCode).toBe(200);
    expect(r.body.tasks.map((t) => t.kind)).toEqual([undefined, undefined]);
  });
});
