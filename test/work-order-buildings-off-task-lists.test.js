// A BUILDING ON A WORK ORDER IS NOT A TASK, AND IS NOT ON ANY TASK LIST (1.33).
//
// THE OWNER'S RULE. "Service tickets are not to be confused with tasks, they
// are two different things; the subtasks in a service ticket shouldn't show up
// on any task lists separately." A work order's punch list is a list of
// BUILDINGS, stored as ordinary org tasks carrying service_ticket_id, and one
// job's twelve buildings used to bury every real to-do in the company — in My
// Tasks, in Team Tasks, in a job's Tasks panel, in My Day, in 86's answers and
// in the morning email.
//
// The rule is ONE predicate —
// services/service-ticket-subtask-door.js notAWorkOrderBuildingSql — so the
// SQL of every list and the JS of every write door (isWorkOrderSubtask) cannot
// drift apart. Its `scope = 'personal'` arm is load-bearing in the OTHER
// direction, and has its own test here: a PRIVATE to-do that happens to carry
// a ticket id belongs to its owner and must keep showing on their list. A bare
// `service_ticket_id IS NULL` would hide it from the only person who can see
// it at all.
//
// Nobody loses sight of work assigned to them, so the removal ships with its
// replacements. Three doors stay deliberately OPEN and are asserted open here:
//   * GET /api/tasks/:id — a link to a building must open it, and it is how
//     the assignee still ticks theirs off;
//   * GET /api/tasks?service_ticket_id=… — asking for a ticket's tasks IS
//     asking for its buildings;
//   * readServiceTicketForAgent's punch-list read — the work order's OWN list.
//
// And one door is CLOSED: a single-task guest share on a building. That page is
// task-shaped and knows nothing about the photo rule or the ticket's status;
// the work order already has its own crew link.
//
// Two organization predicates that were simply missing are fixed in the same
// files and asserted here: the daily task email had NO org predicate at all
// (users.organization_id is mutable, so someone who changed companies kept
// getting their old company's task email), and the photo_count subquery had
// none either.
//
// HOW: the REAL routers and the REAL cron query over node:sqlite through the
// pg shim, built from the schema server/db.js writes — real requireAuth over a
// signed JWT, the real role cache. Then each rule is REMOVED from a copy of
// the shipped source and the identical drive is shown to produce the exact
// wrong answer the rule exists to prevent.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

jest.setTimeout(60000);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const REPO = path.join(__dirname, '..');
const TASK_ROUTES = path.join(REPO, 'server', 'routes', 'tasks-routes.js');
const SHARE_ROUTES = path.join(REPO, 'server', 'routes', 'task-share-routes.js');
const REMINDERS = path.join(REPO, 'server', 'reminders-cron.js');
const AI_ROUTES = path.join(REPO, 'server', 'routes', 'ai-routes.js');

const TABLES = ['organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks',
  'task_shares', 'attachments', 'service_tickets', 'service_ticket_events'];

const WIDE = 10;     // can edit every job and lead
const CREW = 20;     // narrow tier, no grant on j1 — but assigned buildings
const NOBODY = 40;   // signed in, nothing ticket-relevant
const RIVAL = 50;    // another organization
const USERS = {
  [WIDE]: { role: 'st_wide', org: 1, name: 'Wendy Wide' },
  [CREW]: { role: 'st_crew', org: 1, name: 'Carl Crew' },
  [NOBODY]: { role: 'st_none', org: 1, name: 'Nora None' },
  [RIVAL]: { role: 'st_wide', org: 2, name: 'Rival Ray' },
};

// Every building on the fixture. NONE of these may appear on a task list.
const BUILDINGS = ['k1', 'k2', 'w1', 'w2', 'a1', 'a2', 'o1', 'lk1'];
// How many ordinary rows the bulk seed adds — deliberately past the list's
// hard cap of 200, because the admin console's "Open tasks" KPI used to BE
// that cap and read "200" forever.
const BULK = 220;

let eng;
let auth;
let tasksRouter;
let shareRouter;
let aiInternals;

// ── the two Postgres-isms node:sqlite has no spelling for ──────────────────
// The reminders statement is the only one in this suite that uses them, and
// they are in its SELECT list and its date window — NOT in the two predicates
// under test. Rewriting them is a dialect change, not a loosening: the same
// rows are selected either way, and the WHERE this file asserts on is passed
// through byte for byte. Without it the statement cannot be prepared at all,
// and a tenancy assertion over a statement that never ran is worth nothing.
function pgIsms(sql) {
  return String(sql)
    .replace(/to_char\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*,\s*'YYYY-MM-DD'\s*\)/gi, 'substr($1, 1, 10)')
    .replace(/CURRENT_DATE\s*\+\s*INTERVAL\s*'(\d+)\s+([a-z]+)'/gi, "date('now','+$1 $2')");
}

const today = () => new Date().toISOString().slice(0, 10);

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM tasks; DELETE FROM task_shares;
    DELETE FROM attachments; DELETE FROM service_tickets; DELETE FROM service_ticket_events;

    INSERT INTO organizations (id, name, timezone) VALUES (1, 'AGX', 'America/New_York'), (2, 'Rival Co', 'America/New_York');
    INSERT INTO roles (name, capabilities) VALUES
      ('st_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('st_crew', ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])}),
      ('st_none', ${caps(['ESTIMATES_VIEW'])});
    INSERT INTO users (id, name, email, role, organization_id, active) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'st_wide', 1, 1),
      (20, 'Carl Crew', 'c@agx.test', 'st_crew', 1, 1),
      (40, 'Nora None', 'n@agx.test', 'st_none', 1, 1),
      (50, 'Rival Ray', 'r@rival.test', 'st_wide', 2, 1);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1), ('j9', 50, '{}', 2);
    INSERT INTO leads (id, title, organization_id) VALUES ('l1', 'Maple St reroof', 1);

    INSERT INTO service_tickets (id, organization_id, title, ticket_number, job_id, lead_id, status, checklist, created_by) VALUES
      ('st_ip',   1, 'Latitude punch list', 'WO-1042', 'j1', NULL, 'in_progress',   '[]', 10),
      ('st_wc',   1, 'Waiting on approval', NULL,      'j1', NULL, 'work_complete', '[]', 10),
      ('st_ap',   1, 'Approved list',       NULL,      'j1', NULL, 'approved',      '[]', 10),
      ('st_open', 1, 'Second list',         NULL,      'j1', NULL, 'open',          '[]', 10),
      ('st_lead', 1, 'Lead list',           NULL,      NULL, 'l1', 'in_progress',   '[]', 10),
      ('st_b',    2, 'Rival list',          NULL,      'j9', NULL, 'in_progress',   '[]', 50);

    INSERT INTO tasks (id, organization_id, title, status, scope, owner_user_id, assignee_user_id, service_ticket_id, entity_type, entity_id, due_date) VALUES
      ('k1',    1, 'Bldg 1 — Side A', 'open', 'org', NULL, 20,   'st_ip',   'job', 'j1', '${today()}'),
      ('k2',    1, 'Bldg 2 — Side A', 'done', 'org', NULL, NULL, 'st_ip',   'job', 'j1', NULL),
      ('w1',    1, 'Bldg 5',          'done', 'org', NULL, NULL, 'st_wc',   'job', 'j1', NULL),
      ('w2',    1, 'Bldg 6',          'done', 'org', NULL, NULL, 'st_wc',   'job', 'j1', NULL),
      ('a1',    1, 'Bldg 7',          'done', 'org', NULL, 20,   'st_ap',   'job', 'j1', NULL),
      ('a2',    1, 'Bldg 8',          'open', 'org', NULL, 20,   'st_ap',   'job', 'j1', NULL),
      ('o1',    1, 'Bldg 9',          'open', 'org', NULL, NULL, 'st_open', 'job', 'j1', NULL),
      ('lk1',   1, 'Lead bldg',       'open', 'org', NULL, NULL, 'st_lead', 'lead','l1', NULL),
      ('plain', 1, 'Order the latch', 'open', 'org', NULL, 10,   NULL,      'job', 'j1', '${today()}'),
      ('todo',  1, 'Call supplier',   'open', 'personal', 10, NULL, NULL,   NULL,  NULL, NULL),

      -- THE ARM A BARE \`service_ticket_id IS NULL\` WOULD BREAK. A private
      -- to-do that happens to carry a ticket id: Wendy jotted "remember the
      -- gate code" against the Latitude work order. It is not on the punch
      -- list, no work-order rule touches it, and it belongs to her.
      ('todo_wo', 1, 'Gate code for Latitude', 'open', 'personal', 10, NULL, 'st_ip', NULL, NULL, NULL),

      -- Assigned to the RIVAL user (org 2) but filed in org 1. The daily task
      -- email joined users on assignee_user_id and never asked whose org the
      -- task was in, so this row was mailed to another tenant every morning.
      ('cross',  1, 'Org 1 work, org 2 person', 'open', 'org', NULL, 50, NULL, NULL, NULL, '${today()}');
  `);

  // 220 ordinary org tasks. Past the list's cap of 200 on purpose.
  const ins = eng.db.prepare(
    "INSERT INTO tasks (id, organization_id, title, status, scope, assignee_user_id, service_ticket_id) VALUES (?, 1, ?, 'open', 'org', NULL, NULL)"
  );
  for (let i = 0; i < BULK; i++) ins.run('bulk_' + i, 'Bulk task ' + i);
}

function photo(id, taskId, orgId) {
  eng.db.prepare(
    "INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, thumb_url, web_url, tags, organization_id, position) VALUES (?, 'task', ?, 'p.jpg', 'image/jpeg', 'https://cdn/t', 'https://cdn/w', '[]', ?, 0)"
  ).run(id, taskId, orgId);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'data', 'tags', 'notification_prefs'],
  });
  const db = require('../server/db');
  db.pool.query = (sql, params) => eng.pool.query(pgIsms(sql), params);
  db.pool.connect = eng.pool.connect;
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  tasksRouter = require('../server/routes/tasks-routes');
  shareRouter = require('../server/routes/task-share-routes');
  // ai-routes arms a setInterval at module load; faking the clock across the
  // require drops it so the jest worker can still exit.
  jest.useFakeTimers();
  try { aiInternals = require('../server/routes/ai-routes').internals; } finally { jest.useRealTimers(); }
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

// ── the drive (the harness of test/work-order-task-doors.test.js) ──────────
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

const listTasks = (as, query, router) => drive(router || tasksRouter, 'get', '/', { as, query: query || {} });
const getTask = (as, id, router) => drive(router || tasksRouter, 'get', '/:id', { as, params: { id } });
const mintShare = (as, id, body, router) =>
  drive(router || shareRouter, 'post', '/tasks/:id/share', { as, params: { id }, body: body || { email: 'crew@sub.test' } });

const idsOf = (res) => (res.body && res.body.tasks ? res.body.tasks.map((t) => t.id) : []);
const shareRows = (taskId) => eng.all('SELECT * FROM task_shares WHERE task_id = ?', taskId);

// ── mutant(): remove ONE rule from a copy of a shipped source file ─────────
const BUILTINS = new Set(require('module').builtinModules);
const abs = (p) => p.split(path.sep).join('/');

function absolutizeRequires(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (m, q, spec) => {
    if (spec.charAt(0) === '.') return 'require(' + q + abs(path.resolve(fromDir, spec)) + q + ')';
    if (BUILTINS.has(spec) || spec.startsWith('node:')) return m;
    return 'require(' + q + abs(path.join(REPO, 'node_modules', spec)) + q + ')';
  });
}

// THE CRLF TRAP. This repo is core.autocrlf=true. An LF-anchored replace
// against CRLF bytes changes nothing and returns the original string, at which
// point the "mutant" IS the shipped code and the mutation test passes having
// proved nothing. So: normalise to LF, refuse when the anchor is absent or
// ambiguous, and refuse when the bytes did not move.
function mutant(file, pairs) {
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  let out = src;
  for (const [find, replace] of pairs) {
    const hits = out.split(find).length - 1;
    if (hits !== 1) throw new Error('MUTATION ANCHOR ' + (hits ? 'AMBIGUOUS (' + hits + ')' : 'NOT FOUND') + ': ' + find.slice(0, 120));
    out = out.split(find).join(replace);
  }
  if (out === src) throw new Error('MUTATION CHANGED NO BYTES');
  const p = path.join(os.tmpdir(), '_p86_bldglist_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(out, path.dirname(file)), 'utf8');
  mutantPaths.push(p);
  return require(p);
}

describe('the mutation harness', () => {
  test('an anchor that is not in the file throws', () => {
    expect(() => mutant(TASK_ROUTES, [['this string is nowhere', 'x']])).toThrow('MUTATION ANCHOR NOT FOUND');
  });
  test('every source file mutated here is CRLF on disk, so the normalisation is load-bearing', () => {
    for (const f of [TASK_ROUTES, SHARE_ROUTES, REMINDERS, AI_ROUTES]) {
      expect(fs.readFileSync(f, 'utf8').indexOf('\r\n')).toBeGreaterThan(-1);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 1 + 2 — GET /api/tasks hides buildings, and keeps a private to-do that
 *         happens to carry a ticket id.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('GET /api/tasks — a building is not on the list', () => {
  test('the office user gets the plain task and her own to-dos, and NOT one building', async () => {
    const res = await listTasks(WIDE);
    expect(res.statusCode).toBe(200);
    const ids = idsOf(res);
    expect(ids).toContain('plain');
    expect(ids).toContain('todo');
    for (const b of BUILDINGS) expect(ids).not.toContain(b);
  });

  test('the assignee of three buildings does not see them either — assignment is not an exception', async () => {
    const ids = idsOf(await listTasks(CREW, { assignee: 'me' }));
    expect(ids).not.toContain('k1');
    expect(ids).not.toContain('a1');
    expect(ids).not.toContain('a2');
  });

  test('a PRIVATE to-do carrying a service_ticket_id still comes back to its owner', async () => {
    // The `scope = 'personal'` arm of the predicate. This row is not on any
    // punch list; it is Wendy's own note filed against the work order.
    const ids = idsOf(await listTasks(WIDE));
    expect(ids).toContain('todo_wo');
  });

  test('…and still comes back to nobody else', async () => {
    for (const who of [CREW, NOBODY]) {
      expect(idsOf(await listTasks(who))).not.toContain('todo_wo');
    }
  });

  test('the other tenant sees none of it', async () => {
    const ids = idsOf(await listTasks(RIVAL));
    expect(ids).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3 + 4 + 5 — the doors that stay open.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the doors a building is still reached through', () => {
  test('?service_ticket_id=st_ip returns the buildings — that filter MEANS "this ticket\'s tasks"', async () => {
    const ids = idsOf(await listTasks(WIDE, { service_ticket_id: 'st_ip' }));
    expect(ids.sort()).toEqual(['k1', 'k2', 'todo_wo']);
  });

  test('?include_work_orders=1 returns them, and the same drive without it does not', async () => {
    // Narrowed by the title search every building shares, so the DONE ones are
    // not simply pushed off the end of the 200-row page by the 220 bulk rows —
    // the question here is the predicate, not the cap.
    const withFlag = idsOf(await listTasks(WIDE, { include_work_orders: '1', q: 'Bldg' }));
    expect(withFlag.slice().sort()).toEqual(BUILDINGS.slice().sort());
    const without = idsOf(await listTasks(WIDE, { q: 'Bldg' }));
    expect(without).toEqual([]);
  });

  test('GET /api/tasks/:id on a building still answers 200 with the building', async () => {
    const res = await getTask(WIDE, 'k1');
    expect(res.statusCode).toBe(200);
    expect(res.body.task.id).toBe('k1');
    expect(res.body.task.service_ticket_id).toBe('st_ip');
  });

  test('…and to its ASSIGNEE, who is the person the open door exists for', async () => {
    // Carl cannot edit j1 and will never see k1 on a list again. openDetail(id)
    // is the whole replacement path, so this read must not 404 him.
    const res = await getTask(CREW, 'k1');
    expect(res.statusCode).toBe(200);
    expect(res.body.task.id).toBe('k1');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6 — count_only: a COUNT, not the length of a page.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('GET /api/tasks?count_only=1', () => {
  test('counts the same rows the list would, buildings excluded, past the 200 cap', async () => {
    const res = await listTasks(WIDE, { count_only: '1' });
    expect(res.statusCode).toBe(200);
    // plain + todo + todo_wo + cross + 220 bulk. The 8 buildings are not here.
    expect(res.body).toEqual({ count: BULK + 4 });
    expect(res.body.tasks).toBeUndefined();
    expect(res.body.count).toBeGreaterThan(200);
  });

  test('the normal list still caps at 200 — which is exactly why the count exists', async () => {
    const res = await listTasks(WIDE, { limit: '500' });
    expect(res.body.tasks.length).toBe(200);
  });

  test('count_only honours every other filter, including the building exclusion', async () => {
    const all = await listTasks(WIDE, { count_only: '1' });
    const withBuildings = await listTasks(WIDE, { count_only: '1', include_work_orders: '1' });
    expect(withBuildings.body.count - all.body.count).toBe(BUILDINGS.length);
    const oneTicket = await listTasks(WIDE, { count_only: '1', service_ticket_id: 'st_ip' });
    expect(oneTicket.body.count).toBe(3);
  });

  test('the other tenant counts zero', async () => {
    expect((await listTasks(RIVAL, { count_only: '1' })).body).toEqual({ count: 0 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 7 — photo_count carries the company, with the tolerance arm.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('photo_count is org-scoped, and tolerant of un-backfilled rows', () => {
  beforeEach(() => {
    photo('att_mine', 'k2', 1);      // this tenant's
    photo('att_legacy', 'k2', null); // stamped by nobody yet — MUST still count
    photo('att_theirs', 'k2', 2);    // another tenant's row on the same key
  });

  test('GET /api/tasks/:id — counts mine and the legacy row, never the rival\'s', async () => {
    const res = await getTask(WIDE, 'k2');
    expect(res.statusCode).toBe(200);
    expect(res.body.task.photo_count).toBe(2);
  });

  test('the list — same count, same reasons', async () => {
    const res = await listTasks(WIDE, { include_work_orders: '1', q: 'Bldg 2' });
    const k2 = res.body.tasks.find((t) => t.id === 'k2');
    expect(k2.photo_count).toBe(2);
  });

  test('the legacy arm is not decoration: with only the un-stamped row, the count is 1', async () => {
    eng.db.exec("DELETE FROM attachments WHERE id IN ('att_mine','att_theirs')");
    expect((await getTask(WIDE, 'k2')).body.task.photo_count).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 8 — the wrong crew door is closed.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('POST /api/tasks/:id/share — a building is refused', () => {
  test('409, the exact sentence naming the ticket number, and no row written', async () => {
    const res = await mintShare(WIDE, 'k1');
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: 'This is a building on WO-1042 — send the work-order link.',
      code: 'work_order_building',
    });
    expect(shareRows('k1')).toEqual([]);
  });

  test('a ticket with no number is named by its title instead', async () => {
    const res = await mintShare(WIDE, 'lk1');
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('This is a building on Lead list — send the work-order link.');
    expect(shareRows('lk1')).toEqual([]);
  });

  test('the refusal lands BEFORE validation — an empty body still gets the building answer, not "email required"', async () => {
    const res = await mintShare(WIDE, 'k1', {});
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('work_order_building');
  });

  test('an ordinary task still mints a share', async () => {
    const res = await mintShare(WIDE, 'plain');
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(shareRows('plain').length).toBe(1);
  });

  test("a private to-do carrying a ticket id is NOT a building, and still shares", async () => {
    const res = await mintShare(WIDE, 'todo_wo');
    expect(res.statusCode).toBe(200);
    expect(shareRows('todo_wo').length).toBe(1);
  });

  test('the other tenant cannot reach the building at all', async () => {
    const res = await mintShare(RIVAL, 'k1');
    expect(res.statusCode).toBe(404);
  });

  // The refusal names the ticket from a SECOND statement, and that statement
  // carries the company too. A task filed in org 1 whose service_ticket_id
  // points at org 2's work order is still refused — it is still a building —
  // but org 2's ticket title never reaches org 1's screen.
  test('the ticket the refusal names is read in the task\'s OWN org — a cross-tenant id names nothing', async () => {
    eng.db.exec(
      "INSERT INTO tasks (id, organization_id, title, status, scope, owner_user_id, assignee_user_id, service_ticket_id, entity_type, entity_id) " +
      "VALUES ('k_cross', 1, 'Bldg on a foreign ticket', 'open', 'org', NULL, 20, 'st_b', 'job', 'j1')");
    const res = await mintShare(WIDE, 'k_cross');
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('This is a building on a work order — send the work-order link.');
    expect(res.body.error).not.toMatch(/Rival list/);
    expect(shareRows('k_cross')).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 9 — 86's reads.
 * ══════════════════════════════════════════════════════════════════════════*/
describe("86's task reads (server/routes/ai-routes.js)", () => {
  const CTX = { userId: WIDE, orgId: 1, user: { id: WIDE, role: 'st_wide', organization_id: 1 } };
  const runTasks = (input) => aiInternals.dispatchReadTool('read_tasks', input, CTX);

  test('the filtered LIST arm hides buildings — 86 cannot answer with them either', async () => {
    const out = await runTasks({ q: 'Bldg' });
    expect(out).toBe('No tasks matched "Bldg".');
  });

  test('…and still answers with the ordinary tasks', async () => {
    const out = await runTasks({ q: 'Order the latch' });
    expect(out).toContain('Order the latch');
    expect(out).toContain('id=plain');
  });

  test("a private to-do carrying a ticket id is still on its owner's list", async () => {
    const out = await runTasks({ q: 'Gate code' });
    expect(out).toContain('Gate code for Latitude');
  });

  test('include_work_order_buildings is the escape hatch, and it works', async () => {
    const out = await runTasks({ q: 'Bldg', include_work_order_buildings: '1' });
    expect(out).toContain('id=k1');
    expect(out).toContain('id=o1');
  });

  test('the by-id arm still answers with a building — 86 must not go blind on a pasted id', async () => {
    const out = await runTasks({ id: 'k1' });
    expect(out).toContain('Bldg 1 — Side A');
    expect(out).toContain('[k1]');
  });

  test("search_entities('task') delegates to read_tasks, so it inherits the rule", async () => {
    const out = await aiInternals.dispatchReadTool('search_entities', { entity_type: 'task', q: 'Bldg' }, CTX);
    expect(String(out)).not.toContain('id=k1');
  });

  // "What's open on this job?" — the OTHER delegation into read_tasks. It
  // arrives as {entity_type:'job', entity_id:'j1'} with no `id`, so it must
  // land on the filtered LIST arm and inherit the rule. It used to land on the
  // single-task arm instead, where the job's id was read as a TASK id and the
  // answer was "Task not found: j1" — so this path has never listed anything.
  test("read_entity('job', include:['tasks']) lists the job's tasks and none of its buildings", async () => {
    const out = String(await aiInternals.dispatchReadTool(
      'read_entity', { entity_type: 'job', id: 'j1', include: ['tasks'] }, CTX));
    expect(out).not.toMatch(/Task not found/);
    expect(out).toContain('Order the latch');
    expect(out).toContain('id=plain');
    // Every open building on j1 — k1 is due today, a2 and o1 are open too.
    for (const b of ['id=k1', 'id=a2', 'id=o1']) expect(out).not.toContain(b);
    expect(out).not.toContain('Bldg');
  });

  test("read_entity('lead', include:['tasks']) is the same door, and the lead's building stays off it", async () => {
    const out = String(await aiInternals.dispatchReadTool(
      'read_entity', { entity_type: 'lead', id: 'l1', include: ['tasks'] }, CTX));
    expect(out).not.toMatch(/Task not found/);
    expect(out).not.toContain('id=lk1');
    expect(out).not.toContain('Lead bldg');
  });

  test("read_entity('task', id) still reaches the by-id arm — the selector change did not close it", async () => {
    const byId = String(await aiInternals.dispatchReadTool('read_entity', { entity_type: 'task', id: 'k1' }, CTX));
    expect(byId).toContain('Bldg 1 — Side A');
    // read_entity normalizes entity_id into id before it dispatches, so the
    // other spelling of the same call is the same answer.
    const byEntityId = String(await aiInternals.dispatchReadTool(
      'read_entity', { entity_type: 'task', entity_id: 'k1' }, CTX));
    expect(byEntityId).toContain('Bldg 1 — Side A');
  });

  test('MUTANT: keying the by-id arm on entity_id again breaks the job read outright', async () => {
    const m = mutant(AI_ROUTES, [[
      '      const taskId = input && input.id;',
      '      const taskId = input && (input.id || input.entity_id);',
    ]]);
    const out = await m.internals.dispatchReadTool(
      'read_entity', { entity_type: 'job', id: 'j1', include: ['tasks'] }, CTX);
    // Red: the JOB's id is read as a TASK id, and the whole read is lost.
    expect(String(out)).toBe('Task not found: j1');
  });

  // ── the two statements that must NOT have been touched ───────────────────
  test("readServiceTicketForAgent's punch-list read is untouched — it is the one list buildings belong on", () => {
    const src = fs.readFileSync(AI_ROUTES, 'utf8');
    const i = src.indexOf('WHERE k.service_ticket_id = $1');
    expect(i).toBeGreaterThan(-1);
    const stmt = src.slice(src.lastIndexOf('SELECT k.id', i), src.indexOf('LIMIT 100', i));
    expect(stmt).not.toContain('notAWorkOrderBuildingSql');
    expect(stmt).toContain('k.organization_id = $2');
  });

  test('the by-id arm carries no exclusion in SOURCE either, so nobody "finishes the job" later', () => {
    const src = fs.readFileSync(AI_ROUTES, 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf("if (taskId && !(input && (input.q || input.filter)))");
    const end = src.indexOf('// ── filtered list (search_entities) ──', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toContain('notAWorkOrderBuildingSql');
    // …and the list arm right after it DOES carry one.
    expect(src.slice(end, end + 4000)).toContain("notAWorkOrderBuildingSql('t')");
  });

  test("buildTodayDigest — 86's \"your plate today\" — names the plain task", async () => {
    const digest = await aiInternals.buildTodayDigest(WIDE, 1);
    expect(digest).toContain('<today_digest>');
    expect(digest).toContain('Order the latch');
  });

  test('…and never a building, however overdue', async () => {
    // k1 is assigned to Carl and due today. Before 1.33 it opened his every
    // session as "DUE TODAY: Bldg 1 — Side A".
    const digest = await aiInternals.buildTodayDigest(CREW, 1);
    expect(digest).toBe('');
  });

  test("…and still not when it is the ONLY thing on the plate and a rival task shares the id space", async () => {
    eng.db.exec("UPDATE tasks SET assignee_user_id = " + CREW + " WHERE id = 'plain'");
    const digest = await aiInternals.buildTodayDigest(CREW, 1);
    expect(digest).toContain('Order the latch');
    expect(digest).not.toContain('Bldg 1');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 10 — the daily "Your tasks for today" email.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('reminders-cron gatherTaskDigests()', () => {
  const gather = (mod) => (mod || require('../server/reminders-cron')).gatherTaskDigests();
  const titlesFor = (byUser, uid) => (byUser[String(uid)] ? byUser[String(uid)].tasks.map((t) => t.id) : []);

  test('a plain org task due today reaches its assignee', async () => {
    const byUser = await gather();
    expect(titlesFor(byUser, WIDE)).toContain('plain');
  });

  test('a building due today does NOT — it is reported by the work-orders digest instead', async () => {
    const byUser = await gather();
    expect(titlesFor(byUser, CREW)).not.toContain('k1');
    expect(byUser[String(CREW)]).toBeUndefined();
  });

  test('someone who moved companies gets nothing of their old tenant\'s', async () => {
    // `cross` is an org-1 task assigned to the org-2 user. users.organization_id
    // is mutable; this is what "they changed companies" looks like in the data.
    const byUser = await gather();
    expect(titlesFor(byUser, RIVAL)).not.toContain('cross');
    expect(byUser[String(RIVAL)]).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 11 — MUTANTS. Each one proves a named assertion above bites.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('MUTANT (a) — the exclusion removed from GET /api/tasks', () => {
  test('every building floods the task list, which is assertion 1 going red', async () => {
    const m = mutant(TASK_ROUTES, [[
      "    if (!skipBuildingRule) where.push(subtaskDoor.notAWorkOrderBuildingSql('t'));",
      '    // MUTANT: the building exclusion removed.',
    ]]);
    const ids = idsOf(await listTasks(WIDE, { q: 'Bldg' }, m));
    expect(ids.slice().sort()).toEqual(BUILDINGS.slice().sort());
    // And on the unfiltered list too — the open ones, which is what My Tasks
    // actually shows first.
    const unfiltered = idsOf(await listTasks(WIDE, {}, m));
    for (const b of ['k1', 'a2', 'o1', 'lk1']) expect(unfiltered).toContain(b);
  });

  test('…and the KPI count goes up by exactly the buildings', async () => {
    const m = mutant(TASK_ROUTES, [[
      "    if (!skipBuildingRule) where.push(subtaskDoor.notAWorkOrderBuildingSql('t'));",
      '    // MUTANT: the building exclusion removed.',
    ]]);
    const leaked = await listTasks(WIDE, { count_only: '1' }, m);
    expect(leaked.body.count).toBe(BULK + 4 + BUILDINGS.length);
  });
});

describe("MUTANT (b) — a bare `service_ticket_id IS NULL` instead of the helper", () => {
  test("the owner's private to-do vanishes from her own list, which is assertion 2 going red", async () => {
    const m = mutant(TASK_ROUTES, [[
      "subtaskDoor.notAWorkOrderBuildingSql('t')",
      "'t.service_ticket_id IS NULL'",
    ]]);
    const ids = idsOf(await listTasks(WIDE, {}, m));
    expect(ids).not.toContain('todo_wo');
    // The buildings are still gone, which is exactly why this mutant is
    // dangerous: the headline assertion stays green while a private row is
    // hidden from the only person who can see it.
    for (const b of BUILDINGS) expect(ids).not.toContain(b);
  });
});

describe('MUTANT (c) — the organization predicate removed from the daily task email', () => {
  test("the org-2 user is mailed an org-1 task, which is assertion 10 going red", async () => {
    const m = mutant(REMINDERS, [[
      "    '  AND t.organization_id = u.organization_id',\n",
      '',
    ]]);
    const byUser = await m.gatherTaskDigests();
    expect(byUser[String(RIVAL)]).toBeDefined();
    expect(byUser[String(RIVAL)].tasks.map((t) => t.id)).toContain('cross');
  });
});

describe('MUTANT (d) — the building guard removed from the share mint', () => {
  test('a building is minted a task-shaped guest link, which is assertion 8 going red', async () => {
    const m = mutant(SHARE_ROUTES, [[
      '    if (subtaskDoor.isWorkOrderSubtask(task)) {',
      '    if (false) {',
    ]]);
    const res = await mintShare(WIDE, 'k1', { email: 'crew@sub.test' }, m);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(shareRows('k1').length).toBe(1);
  });
});
