// RESPONSIBILITY SITS ON THE RECORD, NEVER ON A BUILDING (1.35).
//
// The owner, 2026-09-20, overriding every earlier answer on this subject —
// including one he gave an hour before:
//
//   "i dont want assignments to individual buildings like that, whoever is
//    assigned to the ticket, task or work order is evenly responsible."
//
// So a BUILDING on a work order's punch list is never assigned to anybody. The
// one Assigned to that means anything is the work order's own
// (service_tickets.assignee_user_id, which the office sets from a real
// dropdown), and everyone on that record is equally responsible for every
// building on it.
//
// test/work-order-my-buildings-door.test.js drives the READ that rule changed
// and test/work-order-task-doors.test.js drives the four WRITE doors. This
// file is the rule itself, stated once, where the two cannot disagree with it:
//
//   1. doneVerdict reads the TICKET's assignee and never the task's.
//   2. assignVerdict is unconditional — no caller, no ticket, no status and no
//      argument shape makes it say yes.
//   3. ONE SENTENCE. Every door that could have written the field asks the
//      door for the words instead of retyping them, so the four refusals
//      cannot drift into four rules.
//   4. myOpenBuildingSql matches the caller on the RECORD; nothing inside its
//      EXISTS asks who a building belongs to.
//   5. NO BACKFILL, NO CLEARING. Nothing in the server clears the dead column
//      on existing rows. It simply stops being read and stops being settable.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server');
const DOOR_PATH = path.join(SERVER, 'services', 'service-ticket-subtask-door.js');
const TASK_ROUTES = path.join(SERVER, 'routes', 'tasks-routes.js');
const SHARE_ROUTES = path.join(SERVER, 'routes', 'task-share-routes.js');
const TICKET_ROUTES = path.join(SERVER, 'routes', 'service-ticket-routes.js');
const DISPATCHER = path.join(SERVER, 'services', 'payload-dispatcher.js');

const door = require('../server/services/service-ticket-subtask-door');
const access = require('../server/services/service-ticket-access');

const read = (p) => fs.readFileSync(p, 'utf8');

// A ticket row as lockTickets hands one over: SELECT *, so assignee_user_id is
// always present. Status defaults to one a crew may still write on.
const ticketRow = (over) => Object.assign({
  id: 'st_1', organization_id: 1, job_id: 'j1', lead_id: null,
  status: 'in_progress', assignee_user_id: null,
}, over || {});

// doneVerdict's first arm is "can this person edit the job or lead", which is
// services/service-ticket-access.js and a whole capability stack. This file is
// about the SECOND arm, so the first is pinned open or shut deliberately.
function withWriteAccess(ok) {
  return jest.spyOn(access, 'mayAccessTicketParent').mockResolvedValue({ ok: !!ok });
}
const db = { query: async () => ({ rows: [], rowCount: 0 }) };

afterEach(() => jest.restoreAllMocks());

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. doneVerdict READS THE RECORD
 * ══════════════════════════════════════════════════════════════════════════*/
describe('who may finish or reopen a building', () => {
  test('the WORK ORDER\'s assignee may, without any right to edit the job', async () => {
    withWriteAccess(false);
    const v = await door.doneVerdict(db, {
      user: { id: 7 }, orgId: 1,
      ticket: ticketRow({ assignee_user_id: 7 }),
      task: { id: 'k1', assignee_user_id: null },
    });
    expect(v).toEqual({ ok: true });
  });

  test('and may finish a building whose own row names SOMEBODY ELSE — everyone on the record is equal', async () => {
    withWriteAccess(false);
    const v = await door.doneVerdict(db, {
      user: { id: 7 }, orgId: 1,
      ticket: ticketRow({ assignee_user_id: 7 }),
      task: { id: 'k1', assignee_user_id: 99 },
    });
    expect(v).toEqual({ ok: true });
  });

  test('THE 1.34 ARM IS GONE: the BUILDING\'s assignee alone opens nothing', async () => {
    withWriteAccess(false);
    const v = await door.doneVerdict(db, {
      user: { id: 7 }, orgId: 1,
      ticket: ticketRow({ assignee_user_id: null }),
      task: { id: 'k1', assignee_user_id: 7 },
    });
    expect(v.ok).toBe(false);
    expect(v.status).toBe(403);
    expect(v.code).toBe('no_access');
  });

  test('the refusal names the WORK ORDER\'s Assigned to, because that is the rule it applied', async () => {
    withWriteAccess(false);
    const onJob = await door.doneVerdict(db, { user: { id: 7 }, orgId: 1, ticket: ticketRow(), task: {} });
    expect(onJob.error)
      .toBe('Only someone who can edit this job, or the person this work order is assigned to, can finish or reopen it.');
    // Never the task's — a reader sent to that field is sent to one no screen
    // sets and no door reads.
    expect(onJob.error).not.toContain('this task is assigned to');

    const onLead = await door.doneVerdict(db, {
      user: { id: 7 }, orgId: 1, ticket: ticketRow({ job_id: null, lead_id: 'l1' }), task: {} });
    expect(onLead.error)
      .toBe('Only someone who can edit this lead, or the person this work order is assigned to, can finish or reopen it.');
  });

  test('the record\'s assignee is still held to the crew rule on a locked work order', async () => {
    withWriteAccess(false);
    for (const status of ['approved', 'closed', 'cancelled', 'draft']) {
      const v = await door.doneVerdict(db, {
        user: { id: 7 }, orgId: 1, ticket: ticketRow({ status, assignee_user_id: 7 }), task: {} });
      expect([status, v.ok, v.code]).toEqual([status, false, 'work_order_locked']);
    }
  });

  test('a null assignee never matches a caller, and neither does a null caller', async () => {
    withWriteAccess(false);
    const nobodyOn = await door.doneVerdict(db, {
      user: { id: 7 }, orgId: 1, ticket: ticketRow({ assignee_user_id: null }), task: {} });
    expect(nobodyOn.ok).toBe(false);
    const noUser = await door.doneVerdict(db, {
      user: {}, orgId: 1, ticket: ticketRow({ assignee_user_id: 7 }), task: {} });
    expect(noUser.ok).toBe(false);
  });

  test('CONTROL: an office writer is still the first arm, unchanged', async () => {
    withWriteAccess(true);
    expect(await door.doneVerdict(db, { user: { id: 99 }, orgId: 1, ticket: ticketRow(), task: {} }))
      .toEqual({ ok: true });
    const closed = await door.doneVerdict(db, {
      user: { id: 99 }, orgId: 1, ticket: ticketRow({ status: 'closed' }), task: {} });
    expect([closed.ok, closed.code]).toEqual([false, 'work_order_locked']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. assignVerdict IS UNCONDITIONAL
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a building can never be assigned', () => {
  const REFUSAL = {
    ok: false, status: 409, code: 'building_not_assignable',
    error: 'A building on a work order is never assigned to one person. ' +
      "Set the work order's Assigned to instead — everyone on it is equally responsible for every building on its punch list.",
  };

  test('it is the same refusal for every caller, ticket and status — and it asks no database', async () => {
    withWriteAccess(true);  // even someone who may edit the job
    const shapes = [
      [],
      [db, { user: { id: 10 }, orgId: 1, ticket: ticketRow() }],
      [db, { user: { id: 7 }, orgId: 1, ticket: ticketRow({ assignee_user_id: 7 }) }],
      [db, { user: { id: 10 }, orgId: 1, ticket: ticketRow({ status: 'approved' }) }],
      [db, { user: { id: 10 }, orgId: 1, ticket: ticketRow({ job_id: null, lead_id: 'l1' }) }],
      [null, null],
    ];
    for (const args of shapes) expect(await door.assignVerdict(...args)).toEqual(REFUSAL);
    expect(access.mayAccessTicketParent).not.toHaveBeenCalled();
  });

  test('the sentence is actionable: it names the field that DOES mean something', () => {
    const msg = door.MSG.notAssignable;
    expect(msg).toContain("work order's Assigned to");
    expect(msg).toContain('equally responsible');
    // And it is the frozen MSG entry, not a string built at the call site.
    expect(door.assignVerdict().error).toBe(msg);
    expect(Object.isFrozen(door.MSG)).toBe(true);
  });

  test('it takes no arguments at all, so a stale (db, o) call site still refuses', async () => {
    expect(door.assignVerdict.length).toBe(0);
    expect(await door.assignVerdict(db, { user: { id: 10 }, orgId: 1, ticket: ticketRow() })).toEqual(REFUSAL);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. ONE SENTENCE, SAID IN ONE PLACE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('every door that could write the field asks this module for the words', () => {
  const DOORS = {
    'routes/tasks-routes.js': TASK_ROUTES,
    'routes/task-share-routes.js': SHARE_ROUTES,
    'services/payload-dispatcher.js': DISPATCHER,
  };

  test('each refusal comes from subtaskDoor, not from a retyped copy of the sentence', () => {
    const problems = [];
    for (const [name, file] of Object.entries(DOORS)) {
      const src = read(file);
      const asksTheDoor = src.indexOf('subtaskDoor.assignVerdict()') > -1 ||
        src.indexOf('subtaskDoor.MSG.notAssignable') > -1;
      if (!asksTheDoor) problems.push(name + ': does not ask the door for the refusal');
      // The words themselves must live in exactly one file. The tail of the
      // sentence is the tell — prose ABOUT the rule is welcome in a comment,
      // a second copy of the refusal a user reads is not.
      if (src.indexOf("Set the work order's Assigned to instead") > -1) {
        problems.push(name + ': retypes the sentence instead of asking for it');
      }
    }
    expect(problems).toEqual([]);
    expect(read(DOOR_PATH)).toContain("Set the work order's Assigned to instead");
  });

  test('the two REST doors and the link all refuse with the same code', () => {
    expect(door.assignVerdict().code).toBe('building_not_assignable');
    for (const file of [TASK_ROUTES, SHARE_ROUTES]) {
      expect(read(file)).toContain('subtaskDoor.assignVerdict()');
    }
    // The dispatcher's refusal carries the same code so a client branching on
    // it does not need to know which door answered.
    expect(read(DISPATCHER)).toContain("code: 'building_not_assignable'");
  });

  test('the dispatcher refuses the key BY NAME rather than as an unknown field', () => {
    const src = read(DISPATCHER);
    // The key left the read set, so nothing downstream can consume it...
    expect(src).toMatch(/const SERVICE_TICKET_TASK_KEYS = new Set\(\['title', 'notes', 'priority', 'due_date'\]\);/);
    // ...and it is named in the refused map, checked before the stray sweep.
    expect(src).toContain('const SERVICE_TICKET_TASK_REFUSED_KEYS = {');
    expect(src.indexOf('SERVICE_TICKET_TASK_REFUSED_KEYS, key')).toBeLessThan(
      src.indexOf('const stray = Object.keys(t).filter'));
    // And no INSERT path can put the column on a building.
    const adds = src.slice(src.indexOf('const cols = [\'id\', \'organization_id\', \'created_by\', \'scope\', \'title\','));
    expect(adds.slice(0, 2000)).not.toContain("cols.push('assignee_user_id')");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. THE PREDICATE MATCHES ON THE RECORD
 * ══════════════════════════════════════════════════════════════════════════*/
describe('myOpenBuildingSql', () => {
  test('the caller is matched on the ticket alias, and the EXISTS asks no owner', () => {
    const sql = door.myOpenBuildingSql('t', '$2');
    expect(sql).toContain('t.assignee_user_id = $2');
    expect(sql.slice(sql.indexOf('EXISTS'))).not.toContain('assignee');
    expect(sql).not.toContain('wob.assignee_user_id');
    // Still every column pinned to the TICKET's own organization.
    expect(sql).toContain('wob.organization_id = t.organization_id');
  });

  test('it is still deliberately outside the job-access rule', () => {
    // doneVerdict lets the record's assignee finish a building on a job they
    // cannot open, so the read that reaches it must not be gated on access.
    const src = read(TICKET_ROUTES);
    const route = src.slice(src.indexOf("router.get('/my-buildings'"), src.indexOf("router.get('/building-counts'"));
    expect(route).toContain("subtaskDoor.myOpenBuildingSql('t', '$2')");
    expect(route).not.toContain('listVisibility(');
  });

  test('the aliases are still validated, so nothing is interpolated unchecked', () => {
    for (const bad of ['t; DROP', '1t', 't-1', 'a b', '']) {
      expect(() => door.myOpenBuildingSql(bad, '$2')).toThrow('myOpenBuildingSql: bad table alias');
    }
    for (const bad of ['2', '$', '$a', '20', '$1 OR 1=1', 20]) {
      expect(() => door.myOpenBuildingSql('t', bad)).toThrow('myOpenBuildingSql: the user must be a $n parameter');
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. EXISTING DATA IS LEFT ALONE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('no backfill and no clearing pass', () => {
  const serverFiles = () => {
    const out = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full);
        else if (name.endsWith('.js')) out.push(full);
      }
    };
    walk(SERVER);
    return out;
  };

  test('nothing in the server clears tasks.assignee_user_id in bulk', () => {
    // A rule that no longer READS a column does not earn the right to delete
    // what is already written there. The offenders a backfill would look like:
    // an UPDATE that nulls the column, or one keyed on service_ticket_id.
    const bulkClear = /UPDATE\s+tasks\s+SET\s+assignee_user_id\s*=\s*NULL/i;
    const keyedOnTicket = /UPDATE\s+tasks\s+SET[^;]{0,400}assignee_user_id[^;]{0,400}WHERE[^;]{0,200}service_ticket_id/i;
    const offenders = serverFiles().filter((f) => {
      const src = read(f).replace(/\s+/g, ' ');
      return bulkClear.test(src) || keyedOnTicket.test(src);
    });
    expect(offenders.map((f) => path.relative(SERVER, f))).toEqual([]);
  });

  test('and the door says so out loud, so the next reader does not "finish the job"', () => {
    const src = read(DOOR_PATH);
    expect(src).toContain('EXISTING DATA IS LEFT EXACTLY AS IT IS');
    expect(src).toMatch(/no backfill and no clearing pass/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. THE RULE HAS NO EXCEPTIONS — THE TWO TASK DOORS, EXECUTED
 *
 * Sections 1-5 state the rule against the module that holds it. This section
 * drives the two doors in server/routes/tasks-routes.js that the review found
 * still carrying an exception to it, because a rule with an exception is a
 * different rule:
 *
 *   (a) THE WRITE. The refusal used to exclude ARCHIVED rows, so an archived
 *       building — scope 'org', service_ticket_id still set — fell through to
 *       the generic UPDATE and had a name written on it. The write was inert
 *       (nothing in the server clears tasks.archived_at today), but an
 *       unarchive feature would have inherited the exception silently, and
 *       "refused for every caller, on every ticket status" was not true while
 *       it stood.
 *
 *   (b) THE READ. GET /api/tasks switches the building rule off in exactly two
 *       cases (service_ticket_id=…, include_work_orders=1) and both then let
 *       `assignee=` narrow the punch list BY THE BUILDING'S OWN assignee —
 *       a per-building owner filter wearing a general-purpose name. It would
 *       have answered "Carl's buildings on this work order" with a straight
 *       face, and the answer means nothing: everyone on the work order is
 *       equally responsible for every building on it.
 *
 * HOW: the REAL router — real requireAuth over a signed JWT, the real role
 * cache — over node:sqlite through the pg shim, built from the schema
 * server/db.js writes. Then each fix is REMOVED from a copy of the shipped
 * file and the identical drive is shown to reach the exception again.
 *
 * THE CRLF TRAP: tasks-routes.js is CRLF on disk and the anchors below are
 * written LF. mutant() normalises each anchor to the file's own line ending
 * and throws when it is absent, ambiguous, or moves no bytes — otherwise the
 * "mutant" is the shipped code and the test passes having proved nothing.
 * ══════════════════════════════════════════════════════════════════════════*/

jest.setTimeout(60000);

const os = require('os');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const RB_TABLES = ['organizations', 'users', 'roles', 'jobs', 'job_access', 'leads',
  'tasks', 'attachments', 'service_tickets', 'service_ticket_events'];

const WIDE = 10;    // can edit every job — and still may not name a building
const CREW = 20;    // the crew lead the WORK ORDER is assigned to
const RIVAL = 50;   // another organization entirely
const RB_USERS = {
  [WIDE]: { role: 'rb_wide', org: 1, name: 'Wendy Wide' },
  [CREW]: { role: 'rb_crew', org: 1, name: 'Carl Crew' },
  [RIVAL]: { role: 'rb_wide', org: 2, name: 'Rival Ray' },
};

let eng;
let auth;
let tasksRouter;
let mutantPaths = [];

// One work order, assigned to Carl, with a punch list. The assignee_user_id
// values ON THE BUILDINGS are what older releases left behind: from 1.35
// nothing reads them and no door may write them. Two buildings are ARCHIVED,
// which is the hole (a); two plain tasks carry assignees, which is the control
// the read tests need (an assignee filter on a real task list still works).
function rbSeed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM tasks; DELETE FROM attachments;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('rb_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('rb_crew', ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])});
    INSERT INTO users (id, name, email, role, organization_id, active) VALUES
      (10, 'Wendy Wide', 'w@agx.test',   'rb_wide', 1, 1),
      (20, 'Carl Crew',  'c@agx.test',   'rb_crew', 1, 1),
      (50, 'Rival Ray',  'r@rival.test', 'rb_wide', 2, 1);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1);

    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, checklist, created_by, assignee_user_id) VALUES
      ('st_1', 1, 'Latitude punch list', 'j1', NULL, 'in_progress', '[]', 10, 20);

    INSERT INTO tasks (id, organization_id, title, status, scope, owner_user_id, assignee_user_id, service_ticket_id, entity_type, entity_id, archived_at, created_at) VALUES
      ('b_live',   1, 'Bldg 1',          'open', 'org', NULL, NULL, 'st_1', 'job', 'j1', NULL,                   '2026-09-02 08:00:01'),
      ('b_carl',   1, 'Bldg 2',          'open', 'org', NULL, 20,   'st_1', 'job', 'j1', NULL,                   '2026-09-02 08:00:02'),
      ('b_wendy',  1, 'Bldg 3',          'open', 'org', NULL, 10,   'st_1', 'job', 'j1', NULL,                   '2026-09-02 08:00:03'),
      ('b_arch',   1, 'Bldg 4',          'open', 'org', NULL, NULL, 'st_1', 'job', 'j1', '2026-09-10 09:00:00',  '2026-09-02 08:00:04'),
      ('b_arch2',  1, 'Bldg 5',          'open', 'org', NULL, 20,   'st_1', 'job', 'j1', '2026-09-10 09:00:00',  '2026-09-02 08:00:05'),
      ('plain',    1, 'Order the latch', 'open', 'org', NULL, NULL, NULL,   'job', 'j1', NULL,                   '2026-09-02 08:00:06'),
      ('plain_c',  1, 'Call the sub',    'open', 'org', NULL, 20,   NULL,   'job', 'j1', NULL,                   '2026-09-02 08:00:07'),
      ('plain_w',  1, 'Chase the PO',    'open', 'org', NULL, 10,   NULL,   'job', 'j1', NULL,                   '2026-09-02 08:00:08'),
      ('plain_a',  1, 'Old errand',      'open', 'org', NULL, NULL, NULL,   'job', 'j1', '2026-09-10 09:00:00',  '2026-09-02 08:00:09');
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(RB_TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'data', 'tags'],
  });
  const pgdb = require('../server/db');
  pgdb.pool.query = eng.pool.query;
  pgdb.pool.connect = eng.pool.connect;
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  rbSeed();
  await auth.refreshRoleCache();
  tasksRouter = require('../server/routes/tasks-routes');
});

// Fire-and-forget continuations (the assignment email lookup) must drain
// before the engine closes, or a late log reads as a failure this file
// manufactured.
const flush = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => { if (eng) rbSeed(); });

afterEach(async () => {
  if (!eng) return;
  await flush();
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

// ── the drive: the whole declared middleware chain, the way express runs it ──
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.set = () => res;
  return res;
}

function tokenFor(uid) {
  const u = RB_USERS[uid];
  return auth.signToken({ id: uid, email: uid + '@t.test', name: u.name, role: u.role, organization_id: u.org });
}

async function drive(router, method, routePath, opts) {
  const o = opts || {};
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error('route not declared: ' + method + ' ' + routePath);
  const chain = layer.route.stack.map((s) => s.handle).filter((h) => h.name !== 'multerMiddleware');
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
  for (const h of chain) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const patchTask = (as, id, body, router) => drive(router || tasksRouter, 'patch', '/:id', { as, params: { id }, body });
const listTasks = (as, query, router) => drive(router || tasksRouter, 'get', '/', { as, query: query || {} });
const idsOf = (res) => (res.body && res.body.tasks ? res.body.tasks.map((t) => t.id).sort() : res.body);
const taskRow = (id) => eng.all('SELECT * FROM tasks WHERE id = ?', id)[0];

// ── mutant(): put ONE exception back into a copy of the shipped route file ──
function absolutizeRequires(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function mutant(file, find, replace) {
  const SOURCE = fs.readFileSync(file, 'utf8');
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const f = String(find).replace(/\r?\n/g, eol);
  const r = String(replace).replace(/\r?\n/g, eol);
  const hits = SOURCE.split(f).length - 1;
  if (hits === 0) {
    throw new Error('MUTATION ANCHOR NOT FOUND — the guard moved or the line endings differ. Anchor:\n'
      + JSON.stringify(f.slice(0, 200)));
  }
  if (hits > 1) throw new Error('MUTATION ANCHOR IS AMBIGUOUS (' + hits + ' matches)');
  const out = SOURCE.split(f).join(r);
  if (out === SOURCE) throw new Error('MUTATION CHANGED NO BYTES: ' + JSON.stringify(f.slice(0, 80)));
  const p = path.join(os.tmpdir(), '_p86_respons_' + process.pid + '_'
    + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(out, path.dirname(file)), 'utf8');
  mutantPaths.push(p);
  return require(p);
}

// The two exceptions, as they read before this pass. Kept next to each other
// so a reader can see exactly what was removed.
const ARCHIVED_EXCEPTION = [
  "    const endsUpABuilding = before.scope === 'org' && !!newTicketId;\n",
  "    const endsUpABuilding = before.scope === 'org' && !before.archived_at && !!newTicketId;\n",
];
const FILTER_EXCEPTION = [
  "    const assignee = skipBuildingRule ? '' : String(req.query.assignee || '').trim();\n",
  "    const assignee = String(req.query.assignee || '').trim();\n",
];

describe('the mutation harness is not the thing being fooled', () => {
  test('an anchor that is nowhere in the file throws instead of passing quietly', () => {
    expect(() => mutant(TASK_ROUTES, 'this string is nowhere in tasks-routes.js', 'x'))
      .toThrow(/MUTATION ANCHOR NOT FOUND/);
  });

  test('an LF anchor still finds the CRLF line, and a no-op replacement throws', () => {
    expect(() => mutant(TASK_ROUTES, ARCHIVED_EXCEPTION[0], ARCHIVED_EXCEPTION[0]))
      .toThrow(/MUTATION CHANGED NO BYTES/);
  });
});

describe('(a) an ARCHIVED building is still a building', () => {
  const REFUSAL = door.MSG.notAssignable;

  test('naming somebody on one is refused with the one sentence, and nothing is written', async () => {
    const res = await patchTask(WIDE, 'b_arch', { assignee_user_id: CREW });
    expect([res.statusCode, res.body.code, res.body.error]).toEqual([409, 'building_not_assignable', REFUSAL]);
    expect(taskRow('b_arch').assignee_user_id).toBeNull();
  });

  test('clearing the name an older release left on one is refused too — rewriting the field is writing it', async () => {
    for (const cleared of [null, '']) {
      rbSeed();
      const res = await patchTask(WIDE, 'b_arch2', { assignee_user_id: cleared });
      expect([cleared, res.statusCode, res.body.code]).toEqual([cleared, 409, 'building_not_assignable']);
      expect(taskRow('b_arch2').assignee_user_id).toBe(CREW);
    }
  });

  test('the work order\'s own assignee is refused on one as flatly as the office is', async () => {
    const res = await patchTask(CREW, 'b_arch', { assignee_user_id: CREW });
    expect([res.statusCode, res.body.error]).toEqual([409, REFUSAL]);
    expect(taskRow('b_arch').assignee_user_id).toBeNull();
  });

  test('a PATCH that carries other fields alongside is refused WHOLE — no half-write', async () => {
    const res = await patchTask(WIDE, 'b_arch', { title: 'Renamed', assignee_user_id: WIDE });
    expect(res.statusCode).toBe(409);
    expect([taskRow('b_arch').title, taskRow('b_arch').assignee_user_id]).toEqual(['Bldg 4', null]);
  });

  test('re-sending the value already on the row is not a change, and is not refused', async () => {
    const res = await patchTask(WIDE, 'b_arch2', { assignee_user_id: CREW });
    expect(res.statusCode).toBe(200);
    expect(taskRow('b_arch2').assignee_user_id).toBe(CREW);
  });

  test('CONTROL: an archived ORDINARY task is still assignable — the refusal is about the work order', async () => {
    const res = await patchTask(WIDE, 'plain_a', { assignee_user_id: WIDE });
    expect(res.statusCode).toBe(200);
    expect(taskRow('plain_a').assignee_user_id).toBe(WIDE);
  });

  test('MUTANT: with the archived exception back, an archived building takes a name', async () => {
    const mut = mutant(TASK_ROUTES, ARCHIVED_EXCEPTION[0], ARCHIVED_EXCEPTION[1]);
    const res = await patchTask(WIDE, 'b_arch', { assignee_user_id: WIDE }, mut);
    expect(res.statusCode).toBe(200);
    expect(taskRow('b_arch').assignee_user_id).toBe(WIDE);
  });

  test('MUTANT: and the name an older release left on one can be wiped', async () => {
    const mut = mutant(TASK_ROUTES, ARCHIVED_EXCEPTION[0], ARCHIVED_EXCEPTION[1]);
    const res = await patchTask(WIDE, 'b_arch2', { assignee_user_id: '' }, mut);
    expect(res.statusCode).toBe(200);
    expect(taskRow('b_arch2').assignee_user_id).toBeNull();
  });

  test('CONTROL: the LIVE building refusal is unchanged by the same edit', async () => {
    const res = await patchTask(WIDE, 'b_live', { assignee_user_id: CREW });
    expect([res.statusCode, res.body.error]).toEqual([409, REFUSAL]);
    expect(taskRow('b_live').assignee_user_id).toBeNull();
  });
});

describe('(b) no per-building assignee filter on any read', () => {
  const PUNCH_LIST = ['b_carl', 'b_live', 'b_wendy'];

  test('a punch list read answers with the WHOLE list, whoever asks and whatever assignee is sent', async () => {
    for (const who of [WIDE, CREW]) {
      for (const assignee of [undefined, 'me', 'unassigned', String(WIDE), String(CREW)]) {
        const q = { service_ticket_id: 'st_1' };
        if (assignee !== undefined) q.assignee = assignee;
        expect([who, assignee, idsOf(await listTasks(who, q))]).toEqual([who, assignee, PUNCH_LIST]);
      }
    }
  });

  test('the escape hatch answers the same way: include_work_orders=1 ignores the filter too', async () => {
    const everything = ['b_carl', 'b_live', 'b_wendy', 'plain', 'plain_c', 'plain_w'];
    for (const assignee of ['me', 'unassigned', String(WIDE)]) {
      expect([assignee, idsOf(await listTasks(CREW, { include_work_orders: '1', assignee }))])
        .toEqual([assignee, everything]);
    }
  });

  test('count_only counts the same rows the list returns, so the two cannot disagree', async () => {
    const listed = idsOf(await listTasks(CREW, { service_ticket_id: 'st_1', assignee: 'me' })).length;
    const counted = (await listTasks(CREW, { service_ticket_id: 'st_1', assignee: 'me', count_only: '1' })).body;
    expect([listed, counted]).toEqual([3, { count: 3 }]);
  });

  test('CONTROL: on a real task list the assignee filter is untouched — all three arms still narrow', async () => {
    expect(idsOf(await listTasks(CREW, { assignee: 'me' }))).toEqual(['plain_c']);
    expect(idsOf(await listTasks(WIDE, { assignee: 'me' }))).toEqual(['plain_w']);
    expect(idsOf(await listTasks(WIDE, { assignee: 'unassigned' }))).toEqual(['plain']);
    expect(idsOf(await listTasks(WIDE, { assignee: String(CREW) }))).toEqual(['plain_c']);
    expect(idsOf(await listTasks(WIDE, {}))).toEqual(['plain', 'plain_c', 'plain_w']);
  });

  test('CONTROL: the organization predicate still answers first — another tenant gets nothing', async () => {
    expect(idsOf(await listTasks(RIVAL, { service_ticket_id: 'st_1' }))).toEqual([]);
    expect(idsOf(await listTasks(RIVAL, { include_work_orders: '1', assignee: 'me' }))).toEqual([]);
  });

  test('MUTANT: with the filter arm back, a punch list is narrowed to one person\'s buildings', async () => {
    const mut = mutant(TASK_ROUTES, FILTER_EXCEPTION[0], FILTER_EXCEPTION[1]);
    expect(idsOf(await listTasks(CREW, { service_ticket_id: 'st_1', assignee: 'me' }, mut))).toEqual(['b_carl']);
    expect(idsOf(await listTasks(WIDE, { service_ticket_id: 'st_1', assignee: 'me' }, mut))).toEqual(['b_wendy']);
    expect(idsOf(await listTasks(WIDE, { service_ticket_id: 'st_1', assignee: 'unassigned' }, mut))).toEqual(['b_live']);
    expect(idsOf(await listTasks(WIDE, { service_ticket_id: 'st_1', assignee: String(CREW) }, mut))).toEqual(['b_carl']);
  });

  test('MUTANT: and the escape hatch hides the rest of the punch list the same way', async () => {
    const mut = mutant(TASK_ROUTES, FILTER_EXCEPTION[0], FILTER_EXCEPTION[1]);
    expect(idsOf(await listTasks(CREW, { include_work_orders: '1', assignee: 'me' }, mut)))
      .toEqual(['b_carl', 'plain_c']);
    const counted = (await listTasks(CREW, { service_ticket_id: 'st_1', assignee: 'me', count_only: '1' }, mut)).body;
    expect(counted).toEqual({ count: 1 });
  });
});
