// A BUILDING ON A WORK ORDER FOLLOWS THE WORK ORDER'S RULES FROM EVERY DOOR
// (1.29, A3).
//
// A building on a punch list is an ordinary org task with service_ticket_id
// set. The office checkbox and the crew link already went through
// services/service-ticket-workorder.js setSubtaskDone, but four other doors
// wrote the same row straight away:
//   * My Tasks and the job's Tasks panel (PATCH /api/tasks/:id),
//   * adding one (POST /api/tasks) and archiving one (DELETE /api/tasks/:id),
//   * a task link sent to a sub (PATCH /api/task-share/:token, and its photo).
// So a building could be finished with no completion photo, on an approved
// work order, by someone who cannot edit the job, and the work order never
// moved to Awaiting approval. Each door now runs through
// services/service-ticket-subtask-door.js and the work-order service.
//
// HOW: the REAL routers — real requireAuth over a signed JWT, the real role
// cache — against node:sqlite through the pg shim, built from the schema
// server/db.js writes. Assertions are on what came back and what the rows say.
// Then each door call is removed from a copy of the shipped route file and the
// identical drive is shown to reach the bypass it exists to stop.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

jest.setTimeout(60000);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const ROUTES_DIR = path.join(__dirname, '..', 'server', 'routes');
const TASK_ROUTES = path.join(ROUTES_DIR, 'tasks-routes.js');
const SHARE_ROUTES = path.join(ROUTES_DIR, 'task-share-routes.js');

const TABLES = ['organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks',
  'task_shares', 'attachments', 'service_tickets', 'service_ticket_events'];

const WIDE = 10;     // can edit every job and lead
const CREW = 20;     // narrow tier, no grant on j1: cannot edit it — but assigned buildings
const NOBODY = 40;   // signed in, nothing ticket-relevant
const RIVAL = 50;    // another organization
const USERS = {
  [WIDE]: { role: 'st_wide', org: 1, name: 'Wendy Wide' },
  [CREW]: { role: 'st_crew', org: 1, name: 'Carl Crew' },
  [NOBODY]: { role: 'st_none', org: 1, name: 'Nora None' },
  [RIVAL]: { role: 'st_wide', org: 2, name: 'Rival Ray' },
};
const TOKEN = 'b'.repeat(64);
const TOKEN_PLAIN = 'c'.repeat(64);
const TOKEN_APPROVED = 'd'.repeat(64);

let eng;
let auth;
let tasksRouter;
let shareRouter;
let notifyCalls;

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs; DELETE FROM job_access;
    DELETE FROM leads; DELETE FROM tasks; DELETE FROM task_shares; DELETE FROM attachments;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events;

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
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES
      ('j1', 10, '{}', 1), ('j9', 50, '{}', 2);
    INSERT INTO leads (id, title, organization_id) VALUES ('l1', 'Maple St reroof', 1);

    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, checklist, created_by, approval_notified_at) VALUES
      ('st_ip',   1, 'Latitude punch list', 'j1', NULL, 'in_progress',   '[]', 10, NULL),
      ('st_wc',   1, 'Waiting on approval', 'j1', NULL, 'work_complete', '[]', 10, '2026-09-15 08:00:00'),
      ('st_ap',   1, 'Approved list',       'j1', NULL, 'approved',      '[]', 10, NULL),
      ('st_open', 1, 'Second list',         'j1', NULL, 'open',          '[]', 10, NULL),
      ('st_lead', 1, 'Lead list',           NULL, 'l1', 'in_progress',   '[]', 10, NULL),
      ('st_b',    2, 'Rival list',          'j9', NULL, 'in_progress',   '[]', 50, NULL);

    INSERT INTO tasks (id, organization_id, title, status, scope, owner_user_id, assignee_user_id, service_ticket_id, entity_type, entity_id) VALUES
      ('k1',    1, 'Bldg 1 — Side A', 'open', 'org', NULL, 20,   'st_ip',   'job', 'j1'),
      ('k2',    1, 'Bldg 2 — Side A', 'done', 'org', NULL, NULL, 'st_ip',   'job', 'j1'),
      ('w1',    1, 'Bldg 5',          'done', 'org', NULL, NULL, 'st_wc',   'job', 'j1'),
      ('w2',    1, 'Bldg 6',          'done', 'org', NULL, NULL, 'st_wc',   'job', 'j1'),
      ('a1',    1, 'Bldg 7',          'done', 'org', NULL, 20,   'st_ap',   'job', 'j1'),
      ('a2',    1, 'Bldg 8',          'open', 'org', NULL, 20,   'st_ap',   'job', 'j1'),
      ('o1',    1, 'Bldg 9',          'open', 'org', NULL, NULL, 'st_open', 'job', 'j1'),
      ('lk1',   1, 'Lead bldg',       'open', 'org', NULL, NULL, 'st_lead', 'lead', 'l1'),
      ('plain', 1, 'Order the latch', 'open', 'org', NULL, NULL, NULL,      'job', 'j1'),
      ('todo',  1, 'Call supplier',   'open', 'personal', 10, NULL, NULL,   NULL, NULL);

    INSERT INTO task_shares (id, organization_id, task_id, token, recipient_email, recipient_name, expires_at, created_by) VALUES
      ('tsh_1', 1, 'k1',    '${TOKEN}',          'crew@sub.test', 'Marco', '2099-01-01T00:00:00Z', 14),
      ('tsh_2', 1, 'plain', '${TOKEN_PLAIN}',    'crew@sub.test', 'Marco', '2099-01-01T00:00:00Z', 14),
      ('tsh_3', 1, 'a2',    '${TOKEN_APPROVED}', 'crew@sub.test', 'Marco', '2099-01-01T00:00:00Z', 14);
  `);
  for (const [id, taskId] of [['att_k2', 'k2'], ['att_w1', 'w1'], ['att_w2', 'w2'], ['att_a1', 'a1']]) photo(id, taskId, ['completion']);
}

function photo(id, taskId, tags) {
  eng.db.prepare(
    "INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, thumb_url, web_url, tags, organization_id, position) VALUES (?, 'task', ?, 'p.jpg', 'image/jpeg', 'https://cdn/t', 'https://cdn/w', ?, 1, 0)"
  ).run(id, taskId, JSON.stringify(tags || []));
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'data', 'tags'],
  });
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  tasksRouter = require('../server/routes/tasks-routes');
  shareRouter = require('../server/routes/task-share-routes');
});

const flush = () => new Promise((r) => setTimeout(r, 25));
let mutantPaths = [];

beforeEach(() => {
  seed();
  notifyCalls = [];
  jest.spyOn(require('../server/services/service-ticket-notify'), 'notifyAwaitingApproval')
    .mockImplementation(async (_db, opts) => { notifyCalls.push(opts); return { sent: 1, recipients: 1 }; });
});

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

// ── the drive (the harness of test/service-ticket-route-access.test.js) ────
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
  // Multer is library middleware with nothing to parse on a fake request.
  const chain = layer.route.stack.map((s) => s.handle).filter((h) => h.name !== 'multerMiddleware');
  const res = fakeRes();
  const req = {
    method: method.toUpperCase(),
    params: o.params || {},
    query: o.query || {},
    body: o.body || {},
    file: o.file,
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
const createTask = (as, body, router) => drive(router || tasksRouter, 'post', '/', { as, body });
const deleteTask = (as, id, router) => drive(router || tasksRouter, 'delete', '/:id', { as, params: { id } });
const sharePatch = (token, body, router) => drive(router || shareRouter, 'patch', '/task-share/:token', { params: { token }, body });
const sharePhoto = (token, router) => drive(router || shareRouter, 'post', '/task-share/:token/photo', { params: { token } });

const task = (id) => eng.all('SELECT * FROM tasks WHERE id = ?', id)[0];
const ticket = (id) => eng.all('SELECT * FROM service_tickets WHERE id = ?', id)[0];
const events = (ticketId) => eng.all('SELECT * FROM service_ticket_events WHERE ticket_id = ? ORDER BY rowid', ticketId)
  .map((e) => Object.assign(e, { detail: typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail }));
const allEvents = () => eng.all('SELECT * FROM service_ticket_events');

// ── mutant(): remove ONE door call from a copy of a shipped route file ─────
function absolutizeRequires(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function mutant(file, find, replace) {
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  // One anchor, or a list of [find, replace] pairs applied in order.
  const pairs = Array.isArray(find) ? find : [[find, replace]];
  let out = src;
  for (const [a, b] of pairs) {
    if (out.split(a).length - 1 !== 1) throw new Error('anchor not found');
    out = out.split(a).join(b);
  }
  if (out === src) throw new Error('MUTATION CHANGED NO BYTES');
  const p = path.join(os.tmpdir(), '_p86_taskdoor_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(out, path.dirname(file)), 'utf8');
  mutantPaths.push(p);
  return require(p);
}

describe('the mutation harness', () => {
  test('an anchor that is not in the file throws', () => {
    expect(() => mutant(TASK_ROUTES, 'this string is nowhere', 'x')).toThrow('anchor not found');
  });
  test('both route files are CRLF on disk, so the normalisation is load-bearing', () => {
    for (const f of [TASK_ROUTES, SHARE_ROUTES]) expect(fs.readFileSync(f, 'utf8').indexOf('\r\n')).toBeGreaterThan(-1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * My Tasks / the job's Tasks panel — PATCH /api/tasks/:id
 * ══════════════════════════════════════════════════════════════════════════*/
describe('PATCH /api/tasks/:id — finishing and reopening a building', () => {
  test('done with no completion photo: 409 completion_photo_required, the task stays open, no timeline row', async () => {
    const res = await patchTask(WIDE, 'k1', { status: 'done' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Add a completion photo before marking this complete.', code: 'completion_photo_required' });
    expect([task('k1').status, task('k1').completed_at]).toEqual(['open', null]);
    expect(allEvents()).toEqual([]);
  });

  test('with a photo it is done, attributed to the office user, and a partly done list does not move', async () => {
    photo('att_k1', 'k1', []);
    eng.db.exec("UPDATE tasks SET status = 'open' WHERE id = 'k2'");
    const res = await patchTask(WIDE, 'k1', { status: 'done' });
    expect(res.statusCode).toBe(200);
    expect(res.body.task.status).toBe('done');
    expect(res.body.work_order).toEqual({ ticket_id: 'st_ip', ticket_status: 'in_progress', moved_to: null });
    const ev = events('st_ip');
    expect(ev.map((e) => [e.kind, e.actor_kind, e.actor_user_id])).toEqual([['subtask_completed', 'user', WIDE]]);
    expect(notifyCalls).toEqual([]);
  });

  test('the LAST building done: work_complete, moved_to in the response, one notice with reason all_subtasks_done', async () => {
    photo('att_k1', 'k1', ['completion']);
    const res = await patchTask(WIDE, 'k1', { status: 'done', notes: 'Railing re-set' });
    expect(res.statusCode).toBe(200);
    expect(res.body.work_order).toEqual({ ticket_id: 'st_ip', ticket_status: 'work_complete', moved_to: 'work_complete' });
    expect(res.body.task.notes).toBe('Railing re-set');
    expect(ticket('st_ip').status).toBe('work_complete');
    await flush();
    expect(notifyCalls).toHaveLength(1);
    expect([notifyCalls[0].reason, notifyCalls[0].ticket.id, notifyCalls[0].ticket.status, notifyCalls[0].actor.userId])
      .toEqual(['all_subtasks_done', 'st_ip', 'work_complete', WIDE]);
  });

  test('reopening a building on a work_complete ticket: back to in_progress, and the notice stamp is cleared', async () => {
    const res = await patchTask(WIDE, 'w1', { status: 'open' });
    expect(res.statusCode).toBe(200);
    expect(res.body.work_order.moved_to).toBe('in_progress');
    expect([task('w1').status, task('w1').completed_at]).toEqual(['open', null]);
    expect([ticket('st_wc').status, ticket('st_wc').approval_notified_at]).toEqual(['in_progress', null]);
    expect(events('st_wc').map((e) => e.kind)).toEqual(['subtask_reopened', 'status_changed']);
  });

  test('asking for In progress on a done building reopens it through the door and lands In progress', async () => {
    const res = await patchTask(WIDE, 'w1', { status: 'in_progress' });
    expect(res.statusCode).toBe(200);
    expect(task('w1').status).toBe('in_progress');
    expect(res.body.task.status).toBe('in_progress');
    expect(ticket('st_wc').status).toBe('in_progress');
  });

  test('someone who can neither edit the job nor is assigned: 403 with the exact sentence, nothing written', async () => {
    photo('att_k1', 'k1', ['completion']);
    eng.db.exec("UPDATE tasks SET assignee_user_id = NULL WHERE id = 'k1'");
    const res = await patchTask(NOBODY, 'k1', { status: 'done' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: 'Only someone who can edit this job, or the person this task is assigned to, can finish or reopen it.',
      code: 'no_access',
    });
    expect(task('k1').status).toBe('open');
    expect(allEvents()).toEqual([]);
  });

  test('on a lead\'s work order the sentence names the lead', async () => {
    const res = await patchTask(NOBODY, 'lk1', { status: 'done' });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Only someone who can edit this lead, or the person this task is assigned to, can finish or reopen it.');
  });

  test('the ASSIGNEE without job edit may finish their building', async () => {
    photo('att_k1', 'k1', ['completion']);
    const res = await patchTask(CREW, 'k1', { status: 'done' });
    expect(res.statusCode).toBe(200);
    expect(task('k1').status).toBe('done');
    expect(events('st_ip')[0].actor_user_id).toBe(CREW);
  });

  test('…but not on an approved work order: 409 work_order_locked', async () => {
    const res = await patchTask(CREW, 'a1', { status: 'open' });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('work_order_locked');
    expect(res.body.error).toBe('The office has approved this work order. Ask them to reopen it for changes.');
    expect(task('a1').status).toBe('done');
  });

  test('assigning yourself in the same PATCH does not make you the assignee the rule asks about', async () => {
    photo('att_o1', 'o1', ['completion']);
    const res = await patchTask(NOBODY, 'o1', { status: 'done', assignee_user_id: NOBODY });
    expect(res.statusCode).toBe(403);
    expect([task('o1').status, task('o1').assignee_user_id]).toEqual(['open', null]);
  });

  test('an office writer on a closed work order: 409 with the closed sentence', async () => {
    eng.db.exec("UPDATE service_tickets SET status = 'closed' WHERE id = 'st_ap'");
    const res = await patchTask(WIDE, 'a1', { status: 'open' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'This work order is closed. Reopen it before changing its punch list.', code: 'work_order_locked' });
  });

  test('another organization\'s user reaches nothing', async () => {
    const res = await patchTask(RIVAL, 'k1', { status: 'done' });
    expect(res.statusCode).toBe(404);
    expect(task('k1').status).toBe('open');
  });

  test('CONTROLS: a plain task and a personal to-do are done with no photo, exactly as before', async () => {
    const plain = await patchTask(WIDE, 'plain', { status: 'done' });
    expect([plain.statusCode, plain.body.work_order, task('plain').status]).toEqual([200, undefined, 'done']);
    expect(task('plain').completed_at).toBeTruthy();
    const todo = await patchTask(WIDE, 'todo', { status: 'done' });
    expect([todo.statusCode, task('todo').status]).toEqual([200, 'done']);
    expect(allEvents()).toEqual([]);
  });

  test('a title-only edit on a building is not a door write', async () => {
    const res = await patchTask(NOBODY, 'k1', { title: 'Bldg 1 — Side B' });
    expect(res.statusCode).toBe(200);
    expect([task('k1').title, res.body.work_order]).toEqual(['Bldg 1 — Side B', undefined]);
  });
});

describe('PATCH /api/tasks/:id — putting a task on, moving it and taking it off a work order', () => {
  test('taking a building off an APPROVED work order: 409, still on it', async () => {
    const res = await patchTask(WIDE, 'a2', { service_ticket_id: null });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'This work order is approved. Reopen it before changing its punch list.', code: 'work_order_locked' });
    expect(task('a2').service_ticket_id).toBe('st_ap');
  });

  test('taking the last open building off an in_progress work order: task_removed, and the recount finishes it', async () => {
    const res = await patchTask(WIDE, 'k1', { service_ticket_id: null });
    expect(res.statusCode).toBe(200);
    expect(task('k1').service_ticket_id).toBeNull();
    const ev = events('st_ip');
    expect(ev.map((e) => e.kind)).toEqual(['task_removed', 'status_changed']);
    expect(ev[0].detail).toEqual({ task_id: 'k1', title: 'Bldg 1 — Side A', reason: 'unlinked' });
    expect(res.body.work_order).toEqual({ ticket_id: 'st_ip', ticket_status: 'work_complete', moved_to: 'work_complete' });
    await flush();
    expect(notifyCalls.map((c) => c.ticket.id)).toEqual(['st_ip']);
  });

  test('moving a building: removed from one, added to the other, both recounted', async () => {
    const res = await patchTask(WIDE, 'k2', { service_ticket_id: 'st_open' });
    expect(res.statusCode).toBe(200);
    expect(events('st_ip').map((e) => [e.kind, e.detail.reason])).toEqual([['task_removed', 'moved']]);
    expect(events('st_open').map((e) => e.kind)).toEqual(['task_added']);
    expect(res.body.work_order).toEqual({ ticket_id: 'st_open', ticket_status: 'open', moved_to: null });
  });

  test('moving a DONE task with no completion photo onto a work order is refused with the exact sentence', async () => {
    eng.db.exec("UPDATE tasks SET status = 'done' WHERE id = 'plain'");
    const res = await patchTask(WIDE, 'plain', { service_ticket_id: 'st_open' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: 'This task is marked done but has no completion photo. Reopen it or add a completion photo before putting it on a work order.',
      code: 'completion_photo_required',
    });
    expect(task('plain').service_ticket_id).toBeNull();
  });

  test('putting an open task onto a work_complete work order sends it back to In progress', async () => {
    const res = await patchTask(WIDE, 'plain', { service_ticket_id: 'st_wc' });
    expect(res.statusCode).toBe(200);
    expect(ticket('st_wc').status).toBe('in_progress');
    expect(events('st_wc').map((e) => [e.kind, e.detail.reason])).toEqual([['task_added', undefined], ['status_changed', 'subtask_added']]);
  });

  test('someone who cannot edit the job cannot move a building', async () => {
    const res = await patchTask(CREW, 'k1', { service_ticket_id: 'st_open' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Only someone who can edit this job can change its work order's punch list.", code: 'no_access' });
    expect(task('k1').service_ticket_id).toBe('st_ip');
  });
});

describe('PATCH /api/tasks/:id — who a building is assigned to', () => {
  const REFUSED = { error: 'Only someone who can edit this job can change who this task is assigned to.', code: 'no_access' };

  test('someone who cannot edit the job cannot assign themselves, so the two-step finish is closed', async () => {
    photo('att_o1', 'o1', ['completion']);
    const assign = await patchTask(NOBODY, 'o1', { assignee_user_id: NOBODY });
    expect([assign.statusCode, assign.body]).toEqual([403, REFUSED]);
    expect(task('o1').assignee_user_id).toBeNull();
    const finish = await patchTask(NOBODY, 'o1', { status: 'done' });
    expect(finish.statusCode).toBe(403);
    expect([task('o1').status, ticket('st_open').status]).toEqual(['open', 'open']);
    await flush();
    expect([allEvents(), notifyCalls]).toEqual([[], []]);
  });

  test('nor unassign someone, nor hand their own building on — the assignee without job edit included', async () => {
    const res = await patchTask(CREW, 'k1', { assignee_user_id: NOBODY });
    expect([res.statusCode, res.body]).toEqual([403, REFUSED]);
    const off = await patchTask(CREW, 'k1', { assignee_user_id: null });
    expect(off.statusCode).toBe(403);
    expect(task('k1').assignee_user_id).toBe(CREW);
  });

  test('on a lead\'s work order the sentence names the lead', async () => {
    const res = await patchTask(NOBODY, 'lk1', { assignee_user_id: NOBODY });
    expect(res.body).toEqual({ error: 'Only someone who can edit this lead can change who this task is assigned to.', code: 'no_access' });
  });

  test('an office writer assigns a building, and that assignee may then finish it', async () => {
    const res = await patchTask(WIDE, 'o1', { assignee_user_id: CREW });
    expect(res.statusCode).toBe(200);
    expect(task('o1').assignee_user_id).toBe(CREW);
    photo('att_o1', 'o1', ['completion']);
    const finish = await patchTask(CREW, 'o1', { status: 'done' });
    expect([finish.statusCode, task('o1').status]).toEqual([200, 'done']);
  });

  test('CONTROLS: re-sending the same assignee, and assigning a plain task, are not asked', async () => {
    const same = await patchTask(NOBODY, 'k1', { assignee_user_id: CREW, title: 'Bldg 1 — rail' });
    expect([same.statusCode, task('k1').title]).toEqual([200, 'Bldg 1 — rail']);
    const plain = await patchTask(NOBODY, 'plain', { assignee_user_id: NOBODY });
    expect([plain.statusCode, task('plain').assignee_user_id]).toEqual([200, NOBODY]);
  });

  test('MUTANT: without the assign verdict, assign-then-finish walks past the rule', async () => {
    const mut = mutant(TASK_ROUTES,
      '        if (assignChange) {\n          const verdict = await subtaskDoor.assignVerdict(client, { user: req.user, orgId, ticket: newTicket });\n          if (!verdict.ok) return { refusal: verdict };\n        }\n',
      '');
    photo('att_o1', 'o1', ['completion']);
    expect((await patchTask(NOBODY, 'o1', { assignee_user_id: NOBODY }, mut)).statusCode).toBe(200);
    expect((await patchTask(NOBODY, 'o1', { status: 'done' }, mut)).statusCode).toBe(200);
    expect([task('o1').status, ticket('st_open').status]).toEqual(['done', 'work_complete']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A10 — each door decides on the task row under the ticket lock, not on the
 * copy it read before taking the lock. The race is staged exactly: the other
 * door's write lands right after this request's first read of the task.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('A10 — another door writes between the first read and the lock', () => {
  const TASKS_PRIOR = /^SELECT \* FROM tasks WHERE id = \$1 AND organization_id = \$2\s+AND \(scope/;
  const DELETE_PRIOR = /^SELECT \* FROM tasks WHERE id = \$1 AND organization_id = \$2 AND archived_at IS NULL/;
  const SHARE_LOAD = /^SELECT \* FROM tasks WHERE id = \$1 AND archived_at IS NULL/;
  const STALE = { error: 'This task just changed. Reload to see the latest.', code: 'status_changed' };

  async function raced(match, race, run) {
    const db = require('../server/db');
    const real = db.pool.query;
    let fired = 0;
    db.pool.query = async (sql, params) => {
      const out = await real(sql, params);
      if (!fired && match.test(String(sql))) { fired++; race(); }
      return out;
    };
    try {
      const res = await run();
      expect(fired).toBe(1); // the race really ran, after the first read
      return res;
    } finally {
      db.pool.query = real;
    }
  }

  const crewFinishesK1 = () => {
    photo('att_k1', 'k1', ['completion']);
    eng.db.exec("UPDATE tasks SET status = 'done', completed_at = '2026-09-15 09:00:00' WHERE id = 'k1'");
    eng.db.exec("UPDATE service_tickets SET status = 'work_complete' WHERE id = 'st_ip'");
  };

  test('My Tasks: In progress on a building the crew just finished is refused, not written over it', async () => {
    const res = await raced(TASKS_PRIOR, crewFinishesK1, () => patchTask(WIDE, 'k1', { status: 'in_progress' }));
    expect([res.statusCode, res.body]).toEqual([409, STALE]);
    expect([task('k1').status, ticket('st_ip').status]).toEqual(['done', 'work_complete']);
    expect(allEvents()).toEqual([]);
  });

  test('My Tasks: reopening a building that was just moved to another work order is refused', async () => {
    const res = await raced(TASKS_PRIOR, () => eng.db.exec("UPDATE tasks SET service_ticket_id = 'st_open' WHERE id = 'k2'"),
      () => patchTask(WIDE, 'k2', { status: 'open' }));
    expect([res.statusCode, res.body]).toEqual([409, STALE]);
    expect([task('k2').status, task('k2').service_ticket_id]).toEqual(['done', 'st_open']);
    expect(allEvents()).toEqual([]);
  });

  test('My Tasks: done on a plain task that was just put on a work order is refused (no photo, no door)', async () => {
    const res = await raced(TASKS_PRIOR, () => eng.db.exec("UPDATE tasks SET service_ticket_id = 'st_ip' WHERE id = 'plain'"),
      () => patchTask(WIDE, 'plain', { status: 'done' }));
    expect([res.statusCode, res.body]).toEqual([409, STALE]);
    expect(task('plain').status).toBe('open');
  });

  test('archiving a building that was just moved to another work order is refused', async () => {
    const res = await raced(DELETE_PRIOR, () => eng.db.exec("UPDATE tasks SET service_ticket_id = 'st_open' WHERE id = 'k1'"),
      () => deleteTask(WIDE, 'k1'));
    expect([res.statusCode, res.body]).toEqual([409, STALE]);
    expect(task('k1').archived_at).toBeNull();
    expect(allEvents()).toEqual([]);
  });

  test('task link: In progress on a building the office just finished is refused, not written over it', async () => {
    const res = await raced(SHARE_LOAD, crewFinishesK1, () => sharePatch(TOKEN, { status: 'in_progress' }));
    expect([res.statusCode, res.body]).toEqual([409, STALE]);
    expect(task('k1').status).toBe('done');
  });

  test('task link: done on a plain task that was just put on a work order is refused', async () => {
    const res = await raced(SHARE_LOAD, () => eng.db.exec("UPDATE tasks SET service_ticket_id = 'st_ip' WHERE id = 'plain'"),
      () => sharePatch(TOKEN_PLAIN, { status: 'done' }));
    expect([res.statusCode, res.body]).toEqual([409, STALE]);
    expect(task('plain').status).toBe('open');
  });

  test('CONTROL: with no race the same requests land', async () => {
    expect((await patchTask(WIDE, 'k1', { status: 'in_progress' })).statusCode).toBe(200);
    expect(task('k1').status).toBe('in_progress');
    expect((await sharePatch(TOKEN_PLAIN, { status: 'done' })).statusCode).toBe(200);
  });

  test('MUTANT: without the re-read under the lock, My Tasks writes In progress over a finished building', async () => {
    const mut = mutant(TASK_ROUTES,
      '      if (subtaskDoor.taskShifted(before, fresh.rows[0])) return { refusal: subtaskDoor.stale() };\n', '');
    const res = await raced(TASKS_PRIOR, crewFinishesK1, () => patchTask(WIDE, 'k1', { status: 'in_progress' }, mut));
    expect(res.statusCode).toBe(200);
    // an open building on a work order that still says Work complete
    expect([task('k1').status, ticket('st_ip').status]).toEqual(['in_progress', 'work_complete']);
  });

  test('MUTANT: without the still-unlinked guard, a task put on a work order a moment ago is done with no photo', async () => {
    const mut = mutant(TASK_ROUTES, "        (stillUnlinked ? ' AND service_ticket_id IS NULL' : '') +\n", '');
    const res = await raced(TASKS_PRIOR, () => eng.db.exec("UPDATE tasks SET service_ticket_id = 'st_ip' WHERE id = 'plain'"),
      () => patchTask(WIDE, 'plain', { status: 'done' }, mut));
    expect([res.statusCode, task('plain').status, task('plain').service_ticket_id]).toEqual([200, 'done', 'st_ip']);
  });

  test('MUTANT: without the ticket predicate on the archive, a moved building comes off the wrong work order', async () => {
    const mut = mutant(TASK_ROUTES, "          '   AND service_ticket_id = $4',\n", "          '   AND $4 = $4',\n");
    const res = await raced(DELETE_PRIOR, () => eng.db.exec("UPDATE tasks SET service_ticket_id = 'st_open' WHERE id = 'k1'"),
      () => deleteTask(WIDE, 'k1', mut));
    expect(res.statusCode).toBe(200);
    expect(task('k1').archived_at).toBeTruthy();
    expect(events('st_ip').map((e) => e.kind)).toContain('task_removed');
  });

  test('MUTANT: without the re-read under the lock, the task link writes In progress over a finished building', async () => {
    const mut = mutant(SHARE_ROUTES,
      '        if (subtaskDoor.taskShifted(req.task, fresh.rows[0])) return subtaskDoor.stale();\n', '');
    const res = await raced(SHARE_LOAD, crewFinishesK1, () => sharePatch(TOKEN, { status: 'in_progress' }, mut));
    expect([res.statusCode, task('k1').status]).toEqual([200, 'in_progress']);
  });

  test('MUTANT: without the still-unlinked guard on the link, a plain task put on a work order is done with no photo', async () => {
    const mut = mutant(SHARE_ROUTES,
      "        if (req.task.scope === 'org') guard = ' AND service_ticket_id IS NULL';\n", '');
    const res = await raced(SHARE_LOAD, () => eng.db.exec("UPDATE tasks SET service_ticket_id = 'st_ip' WHERE id = 'plain'"),
      () => sharePatch(TOKEN_PLAIN, { status: 'done' }, mut));
    expect([res.statusCode, task('plain').status]).toEqual([200, 'done']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * POST /api/tasks — adding a building
 * ══════════════════════════════════════════════════════════════════════════*/
describe('POST /api/tasks — adding a building', () => {
  const add = (as, ticketId, extra) => createTask(as, Object.assign({
    title: 'Bldg 10', service_ticket_id: ticketId, entity_type: 'job', entity_id: 'j1',
  }, extra || {}));

  test('onto an approved work order: 409 with the exact sentence, nothing inserted', async () => {
    const res = await add(WIDE, 'st_ap');
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'This work order is approved. Reopen it before changing its punch list.', code: 'work_order_locked' });
    expect(eng.all("SELECT id FROM tasks WHERE title = 'Bldg 10'")).toEqual([]);
  });

  test('onto a work_complete work order: 200, task_added, and it goes back to In progress (subtask_added)', async () => {
    const res = await add(WIDE, 'st_wc');
    expect(res.statusCode).toBe(200);
    expect([res.body.task.status, res.body.task.scope, res.body.task.service_ticket_id]).toEqual(['open', 'org', 'st_wc']);
    expect(res.body.work_order).toEqual({ ticket_id: 'st_wc', ticket_status: 'in_progress', moved_to: 'in_progress' });
    const ev = events('st_wc');
    expect(ev.map((e) => e.kind)).toEqual(['task_added', 'status_changed']);
    expect(ev[0].detail).toEqual({ task_id: res.body.task.id, title: 'Bldg 10' });
    expect(ev[1].detail).toEqual({ from: 'work_complete', to: 'in_progress', reason: 'subtask_added' });
    expect(ticket('st_wc').approval_notified_at).toBeNull();
    expect(notifyCalls).toEqual([]);
  });

  test('created already done: 409 subtask_starts_open, nothing inserted', async () => {
    const res = await add(WIDE, 'st_ip', { status: 'done' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'A new subtask starts open. Add a completion photo to it, then mark it done.', code: 'subtask_starts_open' });
    expect(eng.all("SELECT id FROM tasks WHERE title = 'Bldg 10'")).toEqual([]);
  });

  test('by someone who cannot edit the job: 403 no_access', async () => {
    const res = await add(NOBODY, 'st_ip');
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('no_access');
    expect(eng.all("SELECT id FROM tasks WHERE title = 'Bldg 10'")).toEqual([]);
  });

  test('another organization\'s work order is refused as before', async () => {
    const res = await add(WIDE, 'st_b');
    expect(res.statusCode).toBe(400);
    expect(events('st_b')).toEqual([]);
  });

  test('CONTROLS: a plain task and a personal to-do on a ticket are created as before, no timeline row', async () => {
    const plain = await createTask(WIDE, { title: 'Order paint', status: 'done' });
    expect([plain.statusCode, plain.body.task.status, plain.body.work_order]).toEqual([200, 'done', undefined]);
    const todo = await createTask(WIDE, { title: 'My note', scope: 'personal', service_ticket_id: 'st_ap' });
    expect([todo.statusCode, todo.body.task.scope, todo.body.work_order]).toEqual([200, 'personal', undefined]);
    expect(allEvents()).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * DELETE /api/tasks/:id — archiving a building
 * ══════════════════════════════════════════════════════════════════════════*/
describe('DELETE /api/tasks/:id — archiving a building', () => {
  test('archiving the last open building finishes the work order and tells the approvers', async () => {
    const res = await deleteTask(WIDE, 'k1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, work_order: { ticket_id: 'st_ip', ticket_status: 'work_complete', moved_to: 'work_complete' } });
    expect(task('k1').archived_at).toBeTruthy();
    expect(events('st_ip').map((e) => [e.kind, e.detail.reason])).toEqual([['task_removed', 'archived'], ['status_changed', 'all_subtasks_done']]);
    await flush();
    expect(notifyCalls.map((c) => [c.ticket.id, c.reason])).toEqual([['st_ip', 'all_subtasks_done']]);
  });

  test('on an approved work order: 409, still live', async () => {
    const res = await deleteTask(WIDE, 'a2');
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('work_order_locked');
    expect(task('a2').archived_at).toBeNull();
  });

  test('by someone who cannot edit the job: 403', async () => {
    const res = await deleteTask(NOBODY, 'k1');
    expect(res.statusCode).toBe(403);
    expect(task('k1').archived_at).toBeNull();
  });

  test('CONTROLS: a plain task and a personal to-do archive as before; a rival reaches nothing', async () => {
    expect((await deleteTask(WIDE, 'plain')).body).toEqual({ ok: true });
    expect((await deleteTask(WIDE, 'todo')).body).toEqual({ ok: true });
    expect((await deleteTask(RIVAL, 'k1')).statusCode).toBe(404);
    expect(task('k1').archived_at).toBeNull();
    expect(allEvents()).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A task link sent to a sub — PATCH /api/task-share/:token and its photo
 * ══════════════════════════════════════════════════════════════════════════*/
describe('task link', () => {
  test('done with no completion photo: 409 with the code, the task open, the link still usable', async () => {
    const res = await sharePatch(TOKEN, { status: 'done' });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('completion_photo_required');
    expect(task('k1').status).toBe('open');
    expect(eng.all("SELECT completed_at FROM task_shares WHERE id = 'tsh_1'")[0].completed_at).toBeNull();
  });

  test('with a photo: done, logged as the link (actor share, no share id), and the last building tells the approvers naming who sent the link', async () => {
    photo('att_k1', 'k1', ['completion']);
    const res = await sharePatch(TOKEN, { status: 'done', note: 'All set' });
    expect(res.statusCode).toBe(200);
    expect([res.body.completed, res.body.task.status]).toEqual([true, 'done']);
    expect(res.body.work_order).toEqual({ ticket_id: 'st_ip', ticket_status: 'work_complete', moved_to: 'work_complete' });
    expect(task('k1').notes).toContain('All set');
    const ev = events('st_ip');
    expect(ev.map((e) => [e.kind, e.actor_kind, e.share_id, e.actor_label])).toEqual([
      ['subtask_completed', 'share', null, 'Marco'],
      ['status_changed', 'share', null, 'Marco'],
    ]);
    await flush();
    expect(notifyCalls).toHaveLength(1);
    expect([notifyCalls[0].ticket.id, notifyCalls[0].reason, notifyCalls[0].sharedBy, notifyCalls[0].actor.kind])
      .toEqual(['st_ip', 'all_subtasks_done', 14, 'share']);
  });

  test('on an approved work order: 409 work_order_locked, nothing written', async () => {
    photo('att_a2', 'a2', ['completion']);
    const res = await sharePatch(TOKEN_APPROVED, { status: 'done' });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('work_order_locked');
    expect(task('a2').status).toBe('open');
  });

  test('a photo for a building on an approved work order is refused before anything is stored', async () => {
    const res = await sharePhoto(TOKEN_APPROVED);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('work_order_locked');
    expect(eng.all("SELECT id FROM attachments WHERE entity_id = 'a2'")).toEqual([]);
  });

  test('CONTROL: a plain task on a link is done with no photo, as before', async () => {
    const res = await sharePatch(TOKEN_PLAIN, { status: 'done' });
    expect([res.statusCode, task('plain').status, res.body.work_order]).toEqual([200, 'done', undefined]);
    expect(allEvents()).toEqual([]);
  });

  test('a partly done building reports the work order it is on, unmoved', async () => {
    eng.db.exec("UPDATE tasks SET status = 'open' WHERE id = 'k2'");
    photo('att_k1', 'k1', ['completion']);
    const res = await sharePatch(TOKEN, { status: 'done' });
    expect(res.statusCode).toBe(200);
    expect(res.body.work_order).toEqual({ ticket_id: 'st_ip', ticket_status: 'in_progress', moved_to: null });
  });

  test('In progress on an open building is written under the lock and reports the work order', async () => {
    const res = await sharePatch(TOKEN, { status: 'in_progress', note: 'On site' });
    expect(res.statusCode).toBe(200);
    expect([task('k1').status, res.body.completed]).toEqual(['in_progress', false]);
    expect(task('k1').notes).toContain('On site');
    expect(res.body.work_order).toEqual({ ticket_id: 'st_ip', ticket_status: 'in_progress', moved_to: null });
    expect(allEvents()).toEqual([]);
  });

  test('MUTANT: without work_order in the response the link page cannot say what the work order did', async () => {
    const mut = mutant(SHARE_ROUTES,
      '    if (doorResult) {\n      out.work_order =', '    if (false) {\n      out.work_order =');
    photo('att_k1', 'k1', ['completion']);
    const res = await sharePatch(TOKEN, { status: 'done' }, mut);
    expect([res.statusCode, res.body.work_order]).toEqual([200, undefined]);
  });

  test('CONTROL: the photo door on an open work order still reaches the file check', async () => {
    const res = await sharePhoto(TOKEN);
    expect([res.statusCode, res.body.error]).toEqual([400, 'No file']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * MUTANTS — each door call removed, the bypass shown
 * ══════════════════════════════════════════════════════════════════════════*/
describe('MUTANTS', () => {
  test('remove the door from tasks PATCH and My Tasks finishes a building with no photo', async () => {
    const mut = mutant(TASK_ROUTES,
      "    const throughDoor = before.scope === 'org' && !before.archived_at &&\n",
      "    const throughDoor = false && before.scope === 'org' && !before.archived_at &&\n");
    const res = await patchTask(WIDE, 'k1', { status: 'done' }, mut);
    expect(res.statusCode).toBe(200);
    expect(task('k1').status).toBe('done');
    expect(allEvents()).toEqual([]);
  });

  test('remove the structure verdict from tasks POST and a building lands on an approved work order', async () => {
    const mut = mutant(TASK_ROUTES,
      "        const verdict = await subtaskDoor.structureVerdict(client, { user: req.user, orgId, ticket });\n        if (!verdict.ok) return { refusal: verdict };\n        if (String(body.status) === 'done') {\n",
      "        if (String(body.status) === 'done') {\n");
    const res = await createTask(WIDE, { title: 'Bldg 10', service_ticket_id: 'st_ap' }, mut);
    expect(res.statusCode).toBe(200);
    expect(eng.all("SELECT service_ticket_id FROM tasks WHERE title = 'Bldg 10'")).toEqual([{ service_ticket_id: 'st_ap' }]);
  });

  test('remove the recount from tasks DELETE and archiving the last open building leaves the work order in progress, unannounced', async () => {
    const mut = mutant(TASK_ROUTES,
      "        const moved = await workOrder.recountTicket(client, ticket, actor, 'subtask_removed');\n",
      '        const moved = { ticketStatus: ticket.status, movedTo: null };\n');
    const res = await deleteTask(WIDE, 'k1', mut);
    expect(res.statusCode).toBe(200);
    expect(ticket('st_ip').status).toBe('in_progress');
    await flush();
    expect(notifyCalls).toEqual([]);
  });

  test('remove the door from the task-link PATCH and a sub finishes a building with no photo', async () => {
    // The door's own status write stands in for setSubtaskDone: done is
    // written straight onto the row, as the link did before 1.29.
    const mut = mutant(SHARE_ROUTES, [
      ['        if (flipsDone) {\n', '        if (false) {\n'],
      ["        if (statusIn !== 'done') { sets.push('status = $' + (i++)); vals.push(statusIn); }\n",
        "        sets.push('status = $' + (i++)); vals.push(statusIn);\n"],
    ]);
    const res = await sharePatch(TOKEN, { status: 'done' }, mut);
    expect(res.statusCode).toBe(200);
    expect(task('k1').status).toBe('done');
    expect(ticket('st_ip').status).toBe('in_progress');
  });

  test('remove the crew gate from the task-link photo door and an approved building takes a photo', async () => {
    const mut = mutant(SHARE_ROUTES,
      '        if (!gate.ok) return res.status(gate.status).json({ error: gate.error, code: gate.code });\n', '');
    const res = await sharePhoto(TOKEN_APPROVED, mut);
    expect([res.statusCode, res.body.error]).toEqual([400, 'No file']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The door module on its own
 * ══════════════════════════════════════════════════════════════════════════*/
describe('service-ticket-subtask-door', () => {
  const door = () => require('../server/services/service-ticket-subtask-door');

  test('isWorkOrderSubtask: a live org task on a ticket, and nothing else', () => {
    const d = door();
    expect(d.isWorkOrderSubtask({ scope: 'org', service_ticket_id: 'st_1', archived_at: null })).toBe(true);
    expect(d.isWorkOrderSubtask({ scope: 'personal', service_ticket_id: 'st_1', archived_at: null })).toBe(false);
    expect(d.isWorkOrderSubtask({ scope: 'org', service_ticket_id: null, archived_at: null })).toBe(false);
    expect(d.isWorkOrderSubtask({ scope: 'org', service_ticket_id: '', archived_at: null })).toBe(false);
    expect(d.isWorkOrderSubtask({ scope: 'org', service_ticket_id: 'st_1', archived_at: '2026-09-01' })).toBe(false);
    expect(d.isWorkOrderSubtask(null)).toBe(false);
  });

  test('lockTickets locks each ticket once, in sorted id order, every read carrying the org', async () => {
    const seen = [];
    const client = { query: async (sql, params) => { seen.push([sql, params]); return { rows: [{ id: params[0] }] }; } };
    const locked = await door().lockTickets(client, 1, ['st_z', null, 'st_a', '', 'st_z']);
    expect(seen.map((s) => s[1])).toEqual([['st_a', 1], ['st_z', 1]]);
    expect(seen.every((s) => /WHERE id = \$1 AND organization_id = \$2 FOR UPDATE/.test(s[0]))).toBe(true);
    expect(Array.from(locked.keys())).toEqual(['st_a', 'st_z']);
  });

  test('taskShifted: another ticket, archived, another scope or flipped done-ness; not a title or a non-done status', () => {
    const d = door();
    const base = { service_ticket_id: 'st_1', archived_at: null, scope: 'org', status: 'open', title: 'A' };
    const w = (patch) => Object.assign({}, base, patch);
    expect(d.taskShifted(base, w({ title: 'B', status: 'in_progress' }))).toBe(false);
    expect(d.taskShifted(base, w({ service_ticket_id: 'st_2' }))).toBe(true);
    expect(d.taskShifted(base, w({ service_ticket_id: null }))).toBe(true);
    expect(d.taskShifted(w({ service_ticket_id: null }), w({ service_ticket_id: 'st_1' }))).toBe(true);
    expect(d.taskShifted(base, w({ archived_at: '2026-09-15' }))).toBe(true);
    expect(d.taskShifted(base, w({ scope: 'personal' }))).toBe(true);
    expect(d.taskShifted(base, w({ status: 'done' }))).toBe(true);
    expect(d.taskShifted(base, undefined)).toBe(true);
    expect(d.stale()).toEqual({ ok: false, status: 409, error: 'This task just changed. Reload to see the latest.', code: 'status_changed' });
  });

  test('crewGate refuses draft, approved, closed and cancelled with work_order_locked', () => {
    const d = door();
    for (const s of ['open', 'scheduled', 'in_progress', 'work_complete']) expect(d.crewGate({ status: s })).toEqual({ ok: true });
    for (const s of ['draft', 'approved', 'closed', 'cancelled']) {
      const v = d.crewGate({ status: s });
      expect([v.ok, v.status, v.code]).toEqual([false, 409, 'work_order_locked']);
    }
  });

  test('notifyMoves announces only arrivals at work_complete, and only through the tracked sender', async () => {
    const out = door().notifyMoves([
      { ticket: { id: 'st_1' }, movedTo: 'work_complete' },
      { ticket: { id: 'st_2' }, movedTo: 'in_progress' },
      { ticket: { id: 'st_3' }, movedTo: null },
    ], { kind: 'user', userId: 10 }, 14, { query: async () => ({ rows: [] }) });
    await Promise.all(out);
    expect(notifyCalls.map((c) => [c.ticket.id, c.reason, c.sharedBy])).toEqual([['st_1', 'all_subtasks_done', 14]]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The client side of the same doors: a refused tick says why and does not
 * pretend it landed; a tick that moved the work order says so.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('client — the My Tasks toggle (js/tasks.js)', () => {
  const TASKS_JS = path.join(__dirname, '..', 'js', 'tasks.js');
  const settle = () => new Promise((r) => setTimeout(r, 30));

  async function mount(src, update) {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', url: 'https://project86.test/' });
    const w = dom.window;
    const toasts = [];
    const gets = [];
    w.p86Toast = function (m, k) { toasts.push([m, k]); };
    w.p86Toast.show = w.p86Toast;
    w.p86Api = {
      isAuthenticated: () => false,
      tasks: {
        list: async () => ({ tasks: [{ id: 'k1', title: 'Bldg 1', status: 'open' }] }),
        update: update,
        get: async (id) => { gets.push(id); return { task: null }; },
      },
    };
    w.eval(src);
    w.p86Tasks.mountList(w.document.getElementById('host'), {}, {});
    await settle();
    const toggle = w.document.querySelector('[data-toggle]');
    if (!toggle) throw new Error('no toggle rendered');
    toggle.click();
    await settle();
    return { w, toasts, gets, toggle };
  }

  const refusal = () => Object.assign(new Error('Add a completion photo before marking this complete.'),
    { status: 409, data: { error: 'Add a completion photo before marking this complete.', code: 'completion_photo_required' } });

  test('the last building done: the work order is awaiting approval, said out loud', async () => {
    const r = await mount(fs.readFileSync(TASKS_JS, 'utf8'),
      async () => ({ task: { id: 'k1', status: 'done' }, work_order: { ticket_id: 'st_1', ticket_status: 'work_complete', moved_to: 'work_complete' } }));
    expect(r.toasts).toContainEqual(['Every subtask is done — the work order is awaiting approval.', 'success']);
  });

  test('a reopened building on a work order awaiting approval: back in progress', async () => {
    const r = await mount(fs.readFileSync(TASKS_JS, 'utf8'),
      async () => ({ task: { id: 'k1', status: 'open' }, work_order: { moved_to: 'in_progress' } }));
    expect(r.toasts).toContainEqual(['The work order is back in progress.', 'info']);
  });

  test('no completion photo: the server\'s sentence, the toggle usable again, and the task opens to add one', async () => {
    const r = await mount(fs.readFileSync(TASKS_JS, 'utf8'), async () => { throw refusal(); });
    expect(r.toasts).toContainEqual(['Add a completion photo before marking this complete.', 'error']);
    expect(r.toggle.disabled).toBe(false);
    expect(r.gets).toEqual(['k1']);
  });

  test('any other refusal toasts and opens nothing', async () => {
    const r = await mount(fs.readFileSync(TASKS_JS, 'utf8'), async () => {
      throw Object.assign(new Error('The office has approved this work order. Ask them to reopen it for changes.'), { status: 409, data: { code: 'work_order_locked' } });
    });
    expect(r.toasts).toContainEqual(['The office has approved this work order. Ask them to reopen it for changes.', 'error']);
    expect(r.gets).toEqual([]);
  });

  test('MUTANT: without the photo branch the task never opens', async () => {
    const src = fs.readFileSync(TASKS_JS, 'utf8').replace(/\r\n/g, '\n');
    const anchor = "            if (err && err.data && err.data.code === 'completion_photo_required') openDetail(id);\n";
    if (src.split(anchor).length !== 2) throw new Error('anchor not found');
    const r = await mount(src.split(anchor).join(''), async () => { throw refusal(); });
    expect(r.gets).toEqual([]);
  });
});

describe('client — the day summary checkbox (js/schedule.js)', () => {
  const SCHEDULE_JS = path.join(__dirname, '..', 'js', 'schedule.js');
  const START = "    el.querySelectorAll('.sch-dsr-check[data-task-id]').forEach(function(cb) {\n";
  const END = '    // Reminder checkboxes';
  const settle = () => new Promise((r) => setTimeout(r, 20));

  function handlerBlock(src) {
    const s = src.replace(/\r\n/g, '\n');
    if (s.split(START).length !== 2) throw new Error('anchor not found');
    const a = s.indexOf(START);
    return s.slice(a, s.indexOf(END, a));
  }

  async function tick(src, update, checked) {
    const toasts = [];
    const opened = [];
    const cb = { checked: checked, handlers: {}, getAttribute: () => 't1', addEventListener(ev, fn) { this.handlers[ev] = fn; } };
    const el = { querySelectorAll: () => [cb] };
    const win = { p86Api: { tasks: { update: update } }, p86Tasks: { openDetail: (id) => opened.push(id) } };
    const quiet = { warn() {} };
    const run = new Function('el', 'window', 'fetchTasks', 'renderDaySummarySidebar', 'renderGrid', 'schToast', 'console', handlerBlock(src));
    run(el, win, async () => [], () => {}, () => {}, (m, k) => toasts.push([m, k]), quiet);
    cb.handlers.change({ stopPropagation() {} });
    await settle();
    return { cb, toasts, opened };
  }

  const photoRefusal = () => Object.assign(new Error('Add a completion photo before marking this complete.'),
    { status: 409, data: { code: 'completion_photo_required' } });

  test('a refused tick is unticked, and the server says why', async () => {
    const r = await tick(fs.readFileSync(SCHEDULE_JS, 'utf8'), async () => { throw photoRefusal(); }, true);
    expect(r.cb.checked).toBe(false);
    expect(r.toasts).toEqual([['Add a completion photo before marking this complete.', 'error']]);
    expect(r.opened).toEqual(['t1']);
  });

  test('a refused untick is ticked again', async () => {
    const r = await tick(fs.readFileSync(SCHEDULE_JS, 'utf8'), async () => {
      throw Object.assign(new Error('This work order is approved.'), { status: 409, data: { code: 'work_order_locked' } });
    }, false);
    expect([r.cb.checked, r.opened]).toEqual([true, []]);
  });

  test('a tick that finishes the work order says so', async () => {
    const r = await tick(fs.readFileSync(SCHEDULE_JS, 'utf8'), async () => ({ work_order: { moved_to: 'work_complete' } }), true);
    expect([r.cb.checked, r.toasts]).toEqual([true, [['Every subtask is done — the work order is awaiting approval.', 'success']]]);
  });

  test('MUTANT: without the untick the box keeps claiming a building the server refused', async () => {
    const src = fs.readFileSync(SCHEDULE_JS, 'utf8').replace(/\r\n/g, '\n');
    const anchor = '            cb.checked = !wanted;\n';
    if (src.split(anchor).length !== 2) throw new Error('anchor not found');
    const r = await tick(src.split(anchor).join(''), async () => { throw photoRefusal(); }, true);
    expect(r.cb.checked).toBe(true);
  });
});
