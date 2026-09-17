// OFFICE EDITING (1.29) — THE FIELD CHECK, THE ASSIGNEE RULE AND THE
// CHANGED-ONLY SAVE, EXECUTED.
//
//   PATCH /api/service-tickets/:id
//     * every value goes through services/service-ticket-fields.js (400 names
//       the field, nothing written);
//     * only fields whose value really changed are written and logged, inside a
//       FOR UPDATE transaction;
//     * `expected` per field: someone else's change since the page loaded is a
//       409 edit_conflict and nothing is saved;
//     * an address change with no new coordinates clears lat/lng;
//     * a CHANGED assignee must be able to open the job or lead; an unchanged
//       one is never re-proved.
//   POST /api/service-tickets — the same check first, due date and assignee.
//   GET  /api/service-tickets/assignees/:kind/:parentId — who may be picked.
//   POST /api/service-tickets/:id/status — a typed reason is detail.note, never
//     detail.reason.
//
// The REAL router over node:sqlite through the pg shim with a signed JWT (the
// drive of test/service-ticket-route-access.test.js), then each guard removed
// from a temp copy and the same drive shown red.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const TICKET_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'service-ticket-routes.js');
const ASSIGNEES = path.join(__dirname, '..', 'server', 'services', 'service-ticket-assignees.js');
const REVIEW = path.join(__dirname, '..', 'server', 'services', 'work-order-review.js');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks', 'attachments',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares',
  'service_ticket_revisions', 'service_ticket_participants',
  // 1.30: ending a work order resolves the crew problems still open on it
  // (work-order-review.js changeStatus, and the archive door below), so a
  // fixture without this table turns every cancel in this suite into a 500.
  'service_ticket_flags',
];

const WIDE = 10;     // every job and lead capability
const CREW = 20;     // narrow tier: view grant j1, edit grant j2, owns j3
const LEADER = 30;   // lead capabilities only
const NOBODY = 40;   // no ticket-relevant capability
const RIVAL = 50;    // another organization
const OTHER = 60;    // narrow tier: an edit grant on j4 only
const OFF = 80;      // wide role, account switched off
const SUB = 90;      // wide role, but a sub-portal account

const USERS = {
  [WIDE]: { role: 'st_wide', org: 1 },
  [CREW]: { role: 'st_crew', org: 1 },
  [LEADER]: { role: 'st_leads', org: 1 },
  [NOBODY]: { role: 'st_none', org: 1 },
  [RIVAL]: { role: 'st_wide', org: 2 },
  [OTHER]: { role: 'st_crew', org: 1 },
};

const CANT_OPEN_JOB = "That person can't open this job, so they can't be assigned. Give them access to the job first, or pick someone else.";
const CANT_OPEN_LEAD = "That person can't open this lead, so they can't be assigned. Give them access to leads first, or pick someone else.";
const SWITCHED_OFF = "That person's account is switched off. Pick someone else.";

let eng;
let auth;
let db;
let ticketRouter;
let notices;
let realAssigned;
let assignedCalls;
const made = [];

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM tasks; DELETE FROM attachments;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_participants;
    DELETE FROM service_ticket_flags;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('st_wide',  ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('st_crew',  ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])}),
      ('st_leads', ${caps(['LEADS_VIEW', 'LEADS_EDIT'])}),
      ('st_none',  ${caps(['ESTIMATES_VIEW'])});
    INSERT INTO users (id, name, email, role, organization_id, active, sub_id) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'st_wide', 1, 1, NULL),
      (20, 'Carl Crew', 'c@agx.test', 'st_crew', 1, 1, NULL),
      (30, 'Lena Leads', 'l@agx.test', 'st_leads', 1, 1, NULL),
      (40, 'Nora None', 'n@agx.test', 'st_none', 1, 1, NULL),
      (60, 'Otto Other', 'o@agx.test', 'st_crew', 1, 1, NULL),
      (80, 'Olive Off', 'off@agx.test', 'st_wide', 1, 0, NULL),
      (90, 'Sam Sub', 'sub@agx.test', 'st_wide', 1, 1, 'sub_1'),
      (50, 'Rival Ray', 'r@rival.test', 'st_wide', 2, 1, NULL);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES
      ('j1', 10, '{}', 1), ('j2', 10, '{}', 1), ('j3', 20, '{}', 1),
      ('j4', 10, '{}', 1), ('j9', 50, '{}', 2);
    INSERT INTO job_access (job_id, user_id, access_level) VALUES
      ('j1', 20, 'view'), ('j2', 20, 'edit'), ('j4', 60, 'edit');
    INSERT INTO leads (id, title, organization_id) VALUES ('l1', 'Maple St reroof', 1), ('l9', 'Rival lead', 2);

    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, priority, checklist,
        scope_proposed, internal_notes, street_address, city, state, zip, lat, lng, due_date,
        assignee_user_id, approval_notice_attempts, created_at, updated_at) VALUES
      ('st_j2', 1, 'Gate on j2', 'j2', NULL, 'open', 'normal', '[]', 'Old scope', 'office only text',
        '12 Oak St', 'Orlando', 'FL', '32801', 28.5, -81.3, NULL, NULL, 0,
        '2026-09-01 10:00:01', '2026-09-01 10:00:01'),
      ('st_l1', 1, 'Lead gate', NULL, 'l1', 'open', 'normal', '[]', NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
        '2026-09-01 10:00:02', '2026-09-01 10:00:02'),
      ('st_cl', 1, 'Closed gate', 'j2', NULL, 'closed', 'normal', '[]', NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
        '2026-09-01 10:00:03', '2026-09-01 10:00:03'),
      ('st_b', 2, 'RIVAL gate', 'j9', NULL, 'open', 'normal', '[]', NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
        '2026-09-01 10:00:04', '2026-09-01 10:00:04');
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
  notices = require('../server/services/work-order-notices');
});

const flush = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => {
  seed();
  assignedCalls = [];
  realAssigned = notices.notifyAssigned;
  notices.notifyAssigned = async (pool, opts) => { assignedCalls.push(opts); return { sent: 1 }; };
});

afterEach(async () => {
  await flush();
  notices.notifyAssigned = realAssigned;
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
  return auth.signToken({ id: uid, email: uid + '@t.test', name: 'U' + uid, role: u.role, organization_id: u.org });
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

const patch = (router, id, body, as) => drive(router, 'patch', '/:id', { as: as || WIDE, params: { id }, body });
const create = (router, body, as) => drive(router, 'post', '/', { as: as || WIDE, body });
const pickList = (router, kind, parentId, as) => drive(router, 'get', '/assignees/:kind/:parentId', { as: as || WIDE, params: { kind, parentId } });
const move = (router, id, body, as) => drive(router, 'post', '/:id/status', { as: as || WIDE, params: { id }, body });
const row = (id) => eng.all('SELECT * FROM service_tickets WHERE id = ? AND organization_id = 1', id)[0];
const fieldEvents = (id) => eng.all("SELECT detail FROM service_ticket_events WHERE ticket_id = ? AND kind = 'field_changed' ORDER BY rowid", id).map((e) => e.detail);
const answer = (r) => [r.statusCode, r.body];

// ── mutants ───────────────────────────────────────────────────────────────
function absolutize(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function writeCopy(file, edits, redirects) {
  let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of edits) {
    if (src.split(find).length !== 2) throw new Error('anchor not found');
    src = src.split(find).join(replace);
  }
  src = absolutize(src, path.dirname(file));
  for (const [from, to] of Object.entries(redirects || {})) {
    const ref = 'require(' + JSON.stringify(from.split(path.sep).join('/')) + ')';
    if (src.split(ref).length < 2) throw new Error('anchor not found');
    src = src.split(ref).join('require(' + JSON.stringify(to.split(path.sep).join('/')) + ')');
  }
  const p = path.join(os.tmpdir(), '_p86_stof_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, src, 'utf8');
  made.push(p);
  return p;
}

const routesMutant = (edits, redirects) => require(writeCopy(TICKET_ROUTES, edits, redirects));

/* ═══════════════════════════════════════════════════════════════════════════
 * PATCH
 * ══════════════════════════════════════════════════════════════════════════*/
describe('PATCH saves only what changed', () => {
  test('a due-date-only body writes that column and logs only it', async () => {
    const before = row('st_j2');
    const r = await patch(ticketRouter, 'st_j2', { due_date: '2026-10-01' });
    expect(r.statusCode).toBe(200);
    expect(r.body.changed).toEqual(['due_date']);
    const after = row('st_j2');
    expect(after.due_date).toBe('2026-10-01');
    for (const k of ['title', 'scope_proposed', 'internal_notes', 'street_address', 'lat', 'lng', 'priority']) {
      expect({ k, v: after[k] }).toEqual({ k, v: before[k] });
    }
    expect(fieldEvents('st_j2')).toEqual([{ fields: ['due_date'] }]);
  });

  test('the same values again change nothing: changed [], no event, no updated_at bump', async () => {
    const r = await patch(ticketRouter, 'st_j2', {
      title: ' Gate on j2 ', scope_proposed: 'Old scope\r\n', priority: 'NORMAL', lat: '28.5', due_date: null,
    });
    expect([r.statusCode, r.body.changed]).toEqual([200, []]);
    expect(fieldEvents('st_j2')).toEqual([]);
    expect(row('st_j2').updated_at).toBe('2026-09-01 10:00:01');
  });

  test('a stale expected value is 409 edit_conflict naming the fields; nothing is saved', async () => {
    const r = await patch(ticketRouter, 'st_j2', {
      scope_proposed: 'My scope', due_date: '2026-10-02', title: 'Also mine',
      expected: { scope_proposed: 'What I loaded', due_date: '2026-09-30', title: 'Gate on j2' },
    });
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatchObject({
      error: 'Someone else changed Scope and Due date while you were editing. Nothing was saved.',
      code: 'edit_conflict',
      fields: ['scope_proposed', 'due_date'],
    });
    expect(r.body.ticket).toMatchObject({ id: 'st_j2', scope_proposed: 'Old scope', title: 'Gate on j2' });
    expect([row('st_j2').scope_proposed, row('st_j2').title, row('st_j2').due_date]).toEqual(['Old scope', 'Gate on j2', null]);
    expect(fieldEvents('st_j2')).toEqual([]);
  });

  test('a matching expected value saves', async () => {
    const r = await patch(ticketRouter, 'st_j2', { scope_proposed: 'My scope', expected: { scope_proposed: 'Old scope\r\n' } });
    expect([r.statusCode, r.body.changed]).toEqual([200, ['scope_proposed']]);
    expect(row('st_j2').scope_proposed).toBe('My scope');
  });

  test('an impossible date is 400 naming the field, and nothing in the body is written', async () => {
    const r = await patch(ticketRouter, 'st_j2', { title: 'Renamed', due_date: '2026-02-30' });
    expect(answer(r)).toEqual([400, { error: 'Due date must be a real date (YYYY-MM-DD).', field: 'due_date' }]);
    expect([row('st_j2').title, row('st_j2').due_date]).toEqual(['Gate on j2', null]);
  });

  test('a blank priority is refused on an edit', async () => {
    const r = await patch(ticketRouter, 'st_j2', { priority: null });
    expect(answer(r)).toEqual([400, { error: 'Priority must be Low, Normal, High or Urgent.', field: 'priority' }]);
    expect(row('st_j2').priority).toBe('normal');
  });

  test('a street change with no coordinates clears the old pin; coordinates sent with it are kept', async () => {
    expect((await patch(ticketRouter, 'st_j2', { street_address: '99 Pine Ave' })).statusCode).toBe(200);
    expect([row('st_j2').street_address, row('st_j2').lat, row('st_j2').lng]).toEqual(['99 Pine Ave', null, null]);
    expect((await patch(ticketRouter, 'st_j2', { street_address: '1 Elm', lat: 28.6, lng: -81.4 })).statusCode).toBe(200);
    expect([row('st_j2').lat, row('st_j2').lng]).toEqual([28.6, -81.4]);
  });

  test('a city with no street is 400 on street_address', async () => {
    const r = await patch(ticketRouter, 'st_j2', { street_address: '' });
    expect(answer(r)).toEqual([400, { error: 'Add a street address, or clear City, State and ZIP.', field: 'street_address' }]);
    expect(row('st_j2').street_address).toBe('12 Oak St');
  });

  test('an unchanged assignee who lost access to the job does not block a title save', async () => {
    eng.db.exec("UPDATE service_tickets SET assignee_user_id = 60 WHERE id = 'st_j2'");
    const r = await patch(ticketRouter, 'st_j2', { title: 'Renamed', assignee_user_id: String(OTHER) });
    expect([r.statusCode, r.body.changed]).toEqual([200, ['title']]);
    expect(assignedCalls).toHaveLength(0);
  });

  test('a changed assignee who cannot open the job is refused, and a switched-off one gets its own sentence', async () => {
    expect(answer(await patch(ticketRouter, 'st_j2', { assignee_user_id: OTHER }))).toEqual([400, { error: CANT_OPEN_JOB, field: 'assignee_user_id' }]);
    expect(answer(await patch(ticketRouter, 'st_j2', { assignee_user_id: OFF }))).toEqual([400, { error: SWITCHED_OFF, field: 'assignee_user_id' }]);
    expect(answer(await patch(ticketRouter, 'st_j2', { assignee_user_id: SUB }))).toEqual([400, { error: CANT_OPEN_JOB, field: 'assignee_user_id' }]);
    expect(row('st_j2').assignee_user_id).toBeNull();
  });

  test('assigning someone else tells them once; assigning yourself tells nobody', async () => {
    expect((await patch(ticketRouter, 'st_j2', { assignee_user_id: CREW })).statusCode).toBe(200);
    expect(assignedCalls).toHaveLength(1);
    expect([assignedCalls[0].ticket.id, assignedCalls[0].assigneeUserId, assignedCalls[0].previousAssigneeUserId, assignedCalls[0].actor.userId])
      .toEqual(['st_j2', CREW, null, WIDE]);
    expect((await patch(ticketRouter, 'st_j2', { assignee_user_id: WIDE })).statusCode).toBe(200);
    expect(assignedCalls).toHaveLength(1);
  });

  test('a terminal ticket still refuses an edit', async () => {
    expect(answer(await patch(ticketRouter, 'st_cl', { title: 'x' }))).toEqual([409, { error: 'This ticket is closed. Reopen it before editing.' }]);
  });

  test('the saved row, projected for a crew link, carries no internal notes and no assignee', async () => {
    const r = await patch(ticketRouter, 'st_j2', { internal_notes: 'still office only', assignee_user_id: CREW });
    expect(r.statusCode).toBe(200);
    const svc = require('../server/services/service-tickets');
    const pub = svc.publicTicket(r.body.ticket, { hide_financials: true });
    expect(pub).not.toHaveProperty('internal_notes');
    expect(pub).not.toHaveProperty('assignee_user_id');
    expect(pub).not.toHaveProperty('approved_by');
    expect(JSON.stringify(pub)).not.toContain('still office only');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CREATE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('POST / create', () => {
  test('stores a due date and an assignee who can open the job, and tells the assignee', async () => {
    const r = await create(ticketRouter, { title: '  New gate  ', job_id: 'j2', due_date: '2026-10-05', assignee_user_id: String(CREW), priority: ' HIGH ' });
    expect(r.statusCode).toBe(200);
    const stored = row(r.body.ticket.id);
    expect([stored.title, stored.due_date, stored.assignee_user_id, stored.priority]).toEqual(['New gate', '2026-10-05', CREW, 'high']);
    expect(assignedCalls.map((c) => [c.ticket.id, c.assigneeUserId, c.actor.userId])).toEqual([[r.body.ticket.id, CREW, WIDE]]);
  });

  test('the field check runs first: a blank title, a bad priority', async () => {
    expect(answer(await create(ticketRouter, { title: '   ', job_id: 'j2' }))).toEqual([400, { error: 'Give the ticket a title.', field: 'title' }]);
    expect(answer(await create(ticketRouter, { job_id: 'j2' }))).toEqual([400, { error: 'Give the ticket a title.', field: 'title' }]);
    expect(answer(await create(ticketRouter, { title: 'x', job_id: 'j2', priority: 'ASAP' })))
      .toEqual([400, { error: 'Priority must be Low, Normal, High or Urgent.', field: 'priority' }]);
    // Before the parent: even on a job that does not exist, the answer is the field.
    expect(answer(await create(ticketRouter, { title: 'x', job_id: 'j_nope', due_date: 'next tuesday' })))
      .toEqual([400, { error: 'Due date must be a real date (YYYY-MM-DD).', field: 'due_date' }]);
    expect(eng.count("SELECT 1 FROM service_tickets WHERE title = 'x'")).toBe(0);
  });

  test('an assignee who cannot open the job, or is switched off, is refused and nothing is inserted', async () => {
    expect(answer(await create(ticketRouter, { title: 'x', job_id: 'j2', assignee_user_id: OTHER })))
      .toEqual([400, { error: CANT_OPEN_JOB, field: 'assignee_user_id' }]);
    expect(answer(await create(ticketRouter, { title: 'x', job_id: 'j2', assignee_user_id: OFF })))
      .toEqual([400, { error: SWITCHED_OFF, field: 'assignee_user_id' }]);
    expect(eng.count("SELECT 1 FROM service_tickets WHERE title = 'x'")).toBe(0);
    expect(assignedCalls).toHaveLength(0);
  });

  test('on a lead: LEADER is accepted, CREW is refused with the lead sentence', async () => {
    const ok = await create(ticketRouter, { title: 'lead one', lead_id: 'l1', assignee_user_id: LEADER });
    expect(ok.statusCode).toBe(200);
    expect(row(ok.body.ticket.id).assignee_user_id).toBe(LEADER);
    expect(answer(await create(ticketRouter, { title: 'lead two', lead_id: 'l1', assignee_user_id: CREW })))
      .toEqual([400, { error: CANT_OPEN_LEAD, field: 'assignee_user_id' }]);
    expect(answer(await patch(ticketRouter, 'st_l1', { assignee_user_id: CREW })))
      .toEqual([400, { error: CANT_OPEN_LEAD, field: 'assignee_user_id' }]);
  });

  test('assigning it to yourself on create tells nobody', async () => {
    expect((await create(ticketRouter, { title: 'mine', job_id: 'j2', assignee_user_id: WIDE })).statusCode).toBe(200);
    expect(assignedCalls).toHaveLength(0);
  });

  test('a city without a street is refused on create too', async () => {
    expect(answer(await create(ticketRouter, { title: 'x', job_id: 'j2', city: 'Orlando' })))
      .toEqual([400, { error: 'Add a street address, or clear City, State and ZIP.', field: 'street_address' }]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * GET /assignees/:kind/:parentId
 * ══════════════════════════════════════════════════════════════════════════*/
describe('GET /assignees/:kind/:parentId', () => {
  test('for j2: people who can open it, id and name only, never another org, a switched-off or a sub account', async () => {
    const r = await pickList(ticketRouter, 'job', 'j2');
    expect(r.statusCode).toBe(200);
    expect(r.body.users).toEqual([{ id: CREW, name: 'Carl Crew' }, { id: WIDE, name: 'Wendy Wide' }]);
    for (const u of r.body.users) expect(Object.keys(u).sort()).toEqual(['id', 'name']);
  });

  test('for a lead: the lead capability decides', async () => {
    const r = await pickList(ticketRouter, 'lead', 'l1');
    expect(r.body.users.map((u) => u.id)).toEqual([LEADER, WIDE]);
  });

  test('a narrow-tier caller not on the job gets exactly the absent job\'s 404; a foreign job and a bad kind 404 too', async () => {
    const notOn = await pickList(ticketRouter, 'job', 'j4', CREW);
    const absent = await pickList(ticketRouter, 'job', 'j_nope', CREW);
    expect(answer(absent)).toEqual([404, { error: 'Job not found' }]);
    expect(answer(notOn)).toEqual(answer(absent));
    expect(answer(await pickList(ticketRouter, 'job', 'j9'))).toEqual([404, { error: 'Job not found' }]);
    expect(answer(await pickList(ticketRouter, 'lead', 'l9'))).toEqual([404, { error: 'Lead not found' }]);
    expect(answer(await pickList(ticketRouter, 'estimate', 'j2'))).toEqual([404, { error: 'Not found' }]);
    // A view grant can open the job but not raise tickets on it.
    expect(answer(await pickList(ticketRouter, 'job', 'j1', CREW))).toEqual([404, { error: 'Job not found' }]);
    expect((await pickList(ticketRouter, 'job', 'j2', CREW)).statusCode).toBe(200);
  });

  test('no capability is 403 naming the capabilities', async () => {
    expect(answer(await pickList(ticketRouter, 'job', 'j2', NOBODY))).toEqual([403, { error: 'Missing capability: JOBS_EDIT_ANY JOBS_EDIT_OWN' }]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * STATUS REASON
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a typed status reason is detail.note, never detail.reason', () => {
  const statusDetails = (id) => eng.all("SELECT detail FROM service_ticket_events WHERE ticket_id = ? AND kind = 'status_changed' ORDER BY rowid", id).map((e) => e.detail);

  test('cancel with a padded reason stores the trimmed note', async () => {
    expect((await move(ticketRouter, 'st_j2', { status: 'cancelled', reason: '  pulled  ' })).statusCode).toBe(200);
    const d = statusDetails('st_j2');
    expect(d).toEqual([{ from: 'open', to: 'cancelled', action: 'cancel', note: 'pulled' }]);
    expect(d[0]).not.toHaveProperty('reason');
  });

  test('a move with no reason has no note key; an optional reason is still kept', async () => {
    expect((await move(ticketRouter, 'st_j2', { status: 'scheduled' })).statusCode).toBe(200);
    expect(statusDetails('st_j2')).toEqual([{ from: 'open', to: 'scheduled' }]);
    expect((await move(ticketRouter, 'st_j2', { status: 'open', reason: 'Date slipped' })).statusCode).toBe(200);
    expect(statusDetails('st_j2')[1]).toEqual({ from: 'scheduled', to: 'open', note: 'Date slipped' });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * EVERY GUARD, REMOVED
 * ══════════════════════════════════════════════════════════════════════════*/
describe('mutants', () => {
  test('the harness throws on an anchor that is not there', () => {
    expect(() => routesMutant([['nowhere in the routes at all', 'x']])).toThrow('anchor not found');
  });

  test('(1) drop the field check from PATCH and "2026-02-30" is written', async () => {
    const mut = routesMutant([[
      "    const checked = fields.validateTicketFields(body, { mode: 'update' });\n"
        + '    if (!checked.ok) return res.status(400).json({ error: checked.error, field: checked.field });\n',
      '    const checked = { ok: true, values: Object.assign({}, body) };\n']]);
    const r = await patch(mut, 'st_j2', { due_date: '2026-02-30' });
    expect(r.statusCode).toBe(200);
    expect(row('st_j2').due_date).toBe('2026-02-30');
  });

  test('(2) drop the conflict check and the stale write lands over someone else\'s change', async () => {
    const mut = routesMutant([['      if (conflicts.length) {', '      if (false) {']]);
    const r = await patch(mut, 'st_j2', { scope_proposed: 'My scope', expected: { scope_proposed: 'What I loaded' } });
    expect(r.statusCode).toBe(200);
    expect(row('st_j2').scope_proposed).toBe('My scope');
  });

  test('(3) prove the assignee in-org only and OTHER, who cannot open j2, is assigned to its ticket', async () => {
    const mut = routesMutant([[
      '      const verdict = await assignees.proveAssigneeForParent(pool, { raw, orgId, parent: ticket });',
      "      const verdict = (await pool.query('SELECT id FROM users WHERE id = $1 AND organization_id = $2', [raw, orgId])).rows.length\n"
        + "        ? { ok: true, value: raw } : { ok: false, error: 'not in org' };"]]);
    const r = await patch(mut, 'st_j2', { assignee_user_id: OTHER });
    expect(r.statusCode).toBe(200);
    expect(row('st_j2').assignee_user_id).toBe(OTHER);
  });

  test('(4) skip the can-open filter in the picker and OTHER is offered for j2', async () => {
    const shipped = require(ASSIGNEES);
    expect((await shipped.eligibleAssignees(eng.pool, { orgId: 1, parent: { job_id: 'j2' } })).map((u) => u.id)).not.toContain(OTHER);
    const copy = writeCopy(ASSIGNEES, [['    if (!(await canOpen(db, row, o.parent, orgId))) continue;\n', '']]);
    const direct = require(copy);
    expect((await direct.eligibleAssignees(eng.pool, { orgId: 1, parent: { job_id: 'j2' } })).map((u) => u.id)).toContain(OTHER);
    const mut = routesMutant([], { [require.resolve(ASSIGNEES)]: copy });
    expect((await pickList(mut, 'job', 'j2')).body.users.map((u) => u.id)).toContain(OTHER);
  });

  test('(5) SET every checked key instead of the changed ones and the event names fields that did not change', async () => {
    const mut = routesMutant([['        if (fields.sameTicketFieldValue(k, locked[k], values[k])) continue;\n', '']]);
    const r = await patch(mut, 'st_j2', { title: 'Gate on j2', due_date: '2026-10-01' });
    expect(r.statusCode).toBe(200);
    expect(fieldEvents('st_j2')).toEqual([{ fields: ['title', 'due_date'] }]);
  });

  test('(6) store the typed reason as detail.reason and the note is gone', async () => {
    const review = writeCopy(REVIEW, [['    if (note) detail.note = note;', '    if (note) detail.reason = note;']]);
    const mut = routesMutant([], { [require.resolve(REVIEW)]: review });
    expect((await move(mut, 'st_j2', { status: 'cancelled', reason: 'pulled' })).statusCode).toBe(200);
    const d = eng.all("SELECT detail FROM service_ticket_events WHERE ticket_id = 'st_j2' AND kind = 'status_changed'")[0].detail;
    expect(d.note).toBeUndefined();
    expect(d.reason).toBe('pulled');
  });
});
