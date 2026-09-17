// THE OFFICE TICKET DOORS, WIRED TO WAVE 2 (1.29, integration step I2-A).
//
// Three pieces of plumbing in server/routes/service-ticket-routes.js that the
// wave-2 services need from the office doors, each driven and then removed from
// a temp copy of the routes to watch the drive go red:
//
//   1. THE NOTICE BOOKKEEPING REACHES THE OFFICE. Every ticket the office detail
//      reads (GET /:id, the list, the PATCH and status answers) carries
//      approval_notified_at, approval_notice_attempts and
//      approval_notice_gave_up_at, so the banner can say "retrying" or "nobody
//      has been told" (services/service-ticket-notify.js keeps them).
//   2. THE APPROVAL NOTICE SURVIVES A DEPLOY. Every notifyAwaitingApproval the
//      office doors start goes through services/inflight.js track(promise,
//      'ticket_approval'), so the shutdown drain waits for it. The answer does
//      not wait for it.
//   3. THE BUILDING DONE DOOR DECIDES ON THE LOCKED ROW. POST
//      /:id/subtasks/:taskId/done hands setSubtaskDone the office gate, answers
//      a refusal as { error, code }, and tells the approvers about the ticket as
//      it was under the lock (result.ticket), not the copy it loaded first.
//   4. ONE COPY OF THE ASSIGNEE REFUSAL, in services/service-ticket-fields.js.
//
// The REAL router runs over node:sqlite through the pg shim with a signed JWT,
// the same drive as test/service-ticket-route-access.test.js.
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
const FIELDS = path.join(SERVER_DIR, 'services', 'service-ticket-fields.js');
const ASSIGNEES = path.join(SERVER_DIR, 'services', 'service-ticket-assignees.js');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks', 'attachments',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares',
  'service_ticket_revisions', 'service_ticket_participants',
  // 1.29: the list's attention columns and the detail's flags / change orders.
  'service_ticket_flags', 'job_change_orders',
];

const WIDE = 10;
const CREW = 20;
const VIEWER = 30;
const RIVAL = 50;

const USERS = {
  [WIDE]: { role: 'st_wide', org: 1, name: 'Paula PM' },
  [CREW]: { role: 'st_crew', org: 1, name: 'Carl Crew' },
  [VIEWER]: { role: 'st_crew', org: 1, name: 'Vera Viewer' },
  [RIVAL]: { role: 'st_wide', org: 2, name: 'Rival Ray' },
};

const BOOKKEEPING = ['approval_notified_at', 'approval_notice_attempts', 'approval_notice_gave_up_at'];

let eng;
let auth;
let db;
let inflight;
let notify;
let ticketRouter;
let approvalCalls;
let realApproval;
const made = [];

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM tasks; DELETE FROM attachments;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_participants;

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
      ('j1', 10, '{}', 1), ('j9', 50, '{}', 2);
    INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j1', 20, 'edit'), ('j1', 30, 'view');

    INSERT INTO service_tickets (id, organization_id, title, job_id, status, priority, checklist,
        approval_notified_at, approval_notice_attempts, approval_notice_last_try_at, approval_notice_gave_up_at,
        created_at) VALUES
      ('st_open', 1, 'Open one',        'j1', 'open',          'normal', '[]', NULL, 0, NULL, NULL, '2026-09-01 10:00:01'),
      ('st_ip',   1, 'Two buildings',   'j1', 'in_progress',   'normal', '[]', NULL, 0, NULL, NULL, '2026-09-01 10:00:02'),
      ('st_np',   1, 'No photo',        'j1', 'in_progress',   'normal', '[]', NULL, 0, NULL, NULL, '2026-09-01 10:00:03'),
      ('st_cl',   1, 'Closed one',      'j1', 'closed',        'normal', '[]', NULL, 0, NULL, NULL, '2026-09-01 10:00:04'),
      ('st_ca',   1, 'Cancelled one',   'j1', 'cancelled',     'normal', '[]', NULL, 0, NULL, NULL, '2026-09-01 10:00:05'),
      ('st_ap',   1, 'Approved one',    'j1', 'approved',      'normal', '[]', NULL, 0, NULL, NULL, '2026-09-01 10:00:06'),
      ('st_wc',   1, 'Nobody was told', 'j1', 'work_complete', 'normal', '[]',
         '2026-09-10 09:00:00', 4, '2026-09-10 13:00:00', '2026-09-10 13:00:00', '2026-09-01 10:00:07'),
      ('st_par',  1, 'Parity',          'j1', 'open',          'normal', '[]', NULL, 0, NULL, NULL, '2026-09-01 10:00:08'),
      ('st_b',    2, 'RIVAL ticket',    'j9', 'in_progress',   'normal', '[]', NULL, 0, NULL, NULL, '2026-09-01 10:00:09');

    INSERT INTO tasks (id, organization_id, title, status, scope, owner_user_id, service_ticket_id, entity_type, entity_id, created_at) VALUES
      ('k1',    1, 'Bldg 1',   'done', 'org', NULL, 'st_ip',  'job', 'j1', '2026-09-02 08:00:01'),
      ('k2',    1, 'Bldg 2',   'open', 'org', NULL, 'st_ip',  'job', 'j1', '2026-09-02 08:00:02'),
      ('k_np',  1, 'Bldg 3',   'open', 'org', NULL, 'st_np',  'job', 'j1', '2026-09-02 08:00:03'),
      ('k_cl',  1, 'Bldg 4',   'open', 'org', NULL, 'st_cl',  'job', 'j1', '2026-09-02 08:00:04'),
      ('k_ca',  1, 'Bldg 5',   'open', 'org', NULL, 'st_ca',  'job', 'j1', '2026-09-02 08:00:05'),
      ('k_ap',  1, 'Bldg 6',   'done', 'org', NULL, 'st_ap',  'job', 'j1', '2026-09-02 08:00:06'),
      ('k_par', 1, 'Bldg 7',   'done', 'org', NULL, 'st_par', 'job', 'j1', '2026-09-02 08:00:07'),
      ('k_par2',1, 'Bldg 8',   'open', 'org', NULL, 'st_par', 'job', 'j1', '2026-09-02 08:00:08'),
      ('k_rv',  2, 'Rival 1',  'open', 'org', NULL, 'st_b',   'job', 'j9', '2026-09-02 08:00:09');

    INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, tags, organization_id, position) VALUES
      ('ph1',  'task', 'k1',     'a.jpg', 'image/jpeg', '["completion"]', 1, 0),
      ('ph2',  'task', 'k2',     'b.jpg', 'image/jpeg', '["completion"]', 1, 0),
      ('ph3',  'task', 'k_cl',   'c.jpg', 'image/jpeg', '["completion"]', 1, 0),
      ('ph4',  'task', 'k_ca',   'd.jpg', 'image/jpeg', '["completion"]', 1, 0),
      ('ph5',  'task', 'k_ap',   'e.jpg', 'image/jpeg', '["completion"]', 1, 0),
      ('ph6',  'task', 'k_par',  'f.jpg', 'image/jpeg', '["completion"]', 1, 0),
      ('ph7',  'task', 'k_par2', 'g.jpg', 'image/jpeg', '["completion"]', 1, 0),
      ('ph8',  'task', 'k_rv',   'h.jpg', 'image/jpeg', '["completion"]', 2, 0),
      ('ph9',  'task', 'k_np',   'i.jpg', 'image/jpeg', '["before"]',     1, 0);
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
  inflight = require('../server/services/inflight');
  notify = require('../server/services/service-ticket-notify');
  ticketRouter = require('../server/routes/service-ticket-routes');
});

const flush = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => {
  seed();
  inflight._reset();
  approvalCalls = [];
  realApproval = notify.notifyAwaitingApproval;
  notify.notifyAwaitingApproval = async (pool, opts) => { approvalCalls.push(opts); return { sent: 0 }; };
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
});

afterEach(async () => {
  await flush();
  jest.restoreAllMocks();
  notify.notifyAwaitingApproval = realApproval;
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  inflight._reset();
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
const patchTicket = (router, id, body) => drive(router, 'patch', '/:id', { as: WIDE, params: { id }, body });
const move = (router, id, body) => drive(router, 'post', '/:id/status', { as: WIDE, params: { id }, body });
const done = (router, id, taskId, isDone, as) => drive(router, 'post', '/:id/subtasks/:taskId/done',
  { as: as || WIDE, params: { id, taskId }, body: { done: isDone !== false } });

const row = (id) => eng.all('SELECT * FROM service_tickets WHERE id = ?', id)[0];
const task = (id) => eng.all('SELECT * FROM tasks WHERE id = ?', id)[0];
const eventKinds = (ticketId) => eng.all('SELECT kind FROM service_ticket_events WHERE ticket_id = ? ORDER BY rowid', ticketId)
  .map((e) => e.kind);

// Interleave: run `sql` on the engine right before the first statement matching
// `re` that a transaction client runs — here, the ticket lock inside
// setSubtaskDone, so the row under the lock differs from the one the route
// loaded.
const LOCK_READ = /FROM service_tickets WHERE id = \$1 AND organization_id = \$2 FOR UPDATE/;
function beforeLock(sql) {
  let fired = false;
  db.pool.connect = async () => {
    const c = await eng.pool.connect();
    return {
      query: async (text, params) => {
        if (!fired && LOCK_READ.test(String(text))) { fired = true; eng.db.exec(sql); }
        return c.query(text, params);
      },
      release: () => c.release(),
    };
  };
  return () => fired;
}

// ── mutants: temp copies, CRLF-normalised, every anchor exactly once ────────
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
  const p = path.join(os.tmpdir(), '_p86_i2a_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, src, 'utf8');
  made.push(p);
  return p;
}

const routesMutant = (edits, redirects) => require(writeCopy(TICKET_ROUTES, edits, redirects));

/* ═══════════════════════════════════════════════════════════════════════════
 * THE MUTATION HARNESS, FIRST
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the mutation harness', () => {
  test('an anchor that is not in the file throws', () => {
    expect(() => routesMutant([['this text is nowhere in the routes', 'x']])).toThrow('anchor not found');
  });

  test('an anchor that matches twice throws', () => {
    expect(() => routesMutant([["trackNotice('ticket_approval', () => ticketNotify.notifyAwaitingApproval(pool, {", 'x']]))
      .toThrow('anchor not found');
  });

  test('the routes file is CRLF on disk, so the anchors are normalised', () => {
    expect(fs.readFileSync(TICKET_ROUTES, 'utf8').indexOf('\r\n')).toBeGreaterThan(-1);
  });

  test('a loaded mutant is a different router over the same database', async () => {
    const mut = routesMutant([["const TICKET_NOT_FOUND = 'Service ticket not found';", "const TICKET_NOT_FOUND = 'MUTANT';"]]);
    expect(mut).not.toBe(ticketRouter);
    expect((await readTicket(mut, 'st_nope')).body).toEqual({ error: 'MUTANT' });
    expect((await readTicket(mut, 'st_ip')).statusCode).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. THE NOTICE BOOKKEEPING ON EVERY OFFICE TICKET READ
 * ══════════════════════════════════════════════════════════════════════════*/
const TICKET_COLS_LINE = "  'approval_notified_at', 'approval_notice_attempts', 'approval_notice_gave_up_at',\n";

function bookkeepingOf(ticket) {
  const out = {};
  for (const k of BOOKKEEPING) out[k] = Object.prototype.hasOwnProperty.call(ticket || {}, k) ? ticket[k] : 'ABSENT';
  return out;
}

describe('1. the approval notice bookkeeping reaches the office', () => {
  test('GET /:id: a ticket that gave up says so — attempts, the last claim and the give-up', async () => {
    const r = await readTicket(ticketRouter, 'st_wc');
    expect(r.statusCode).toBe(200);
    const b = bookkeepingOf(r.body.ticket);
    expect(b.approval_notice_attempts).toBe(4);
    expect(b.approval_notified_at).toBeTruthy();
    expect(b.approval_notice_gave_up_at).toBeTruthy();
    // A ticket never announced carries the keys too, empty — so the banner can
    // tell "nothing to say" from "the server did not say".
    expect(bookkeepingOf((await readTicket(ticketRouter, 'st_ip')).body.ticket))
      .toEqual({ approval_notified_at: null, approval_notice_attempts: 0, approval_notice_gave_up_at: null });
  });

  test('the list, the PATCH answer and the status answer carry the same three', async () => {
    const listed = (await listTickets(ticketRouter)).body.tickets.find((t) => t.id === 'st_wc');
    expect(bookkeepingOf(listed).approval_notice_attempts).toBe(4);
    expect(bookkeepingOf(listed).approval_notice_gave_up_at).toBeTruthy();

    const patched = await patchTicket(ticketRouter, 'st_wc', { title: 'Renamed' });
    expect(patched.statusCode).toBe(200);
    expect(bookkeepingOf(patched.body.ticket).approval_notice_attempts).toBe(4);

    const moved = await move(ticketRouter, 'st_open', { status: 'scheduled' });
    expect(moved.statusCode).toBe(200);
    expect(Object.values(bookkeepingOf(moved.body.ticket))).not.toContain('ABSENT');
  });

  test('none of the three is on the crew link\'s ticket', () => {
    const svc = require('../server/services/service-tickets');
    const pub = svc.publicTicket(row('st_wc'), {});
    for (const k of BOOKKEEPING) expect(Object.prototype.hasOwnProperty.call(pub, k)).toBe(false);
  });

  test('MUTANT: drop them from TICKET_COLS and the detail, the list and the answers lose them', async () => {
    const mut = routesMutant([[TICKET_COLS_LINE, '']]);
    const gone = { approval_notified_at: 'ABSENT', approval_notice_attempts: 'ABSENT', approval_notice_gave_up_at: 'ABSENT' };
    expect(bookkeepingOf((await readTicket(mut, 'st_wc')).body.ticket)).toEqual(gone);
    expect(bookkeepingOf((await listTickets(mut)).body.tickets.find((t) => t.id === 'st_wc'))).toEqual(gone);
    expect(bookkeepingOf((await patchTicket(mut, 'st_wc', { title: 'Renamed' })).body.ticket)).toEqual(gone);
    expect(bookkeepingOf((await move(mut, 'st_open', { status: 'scheduled' })).body.ticket)).toEqual(gone);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. EVERY APPROVAL NOTICE IS TRACKED FOR THE SHUTDOWN DRAIN
 * ══════════════════════════════════════════════════════════════════════════*/
// A notice that holds until released, so the test can look while it is still
// running — the moment a SIGTERM would arrive.
function holdNotices() {
  const held = { promises: [], release: null };
  let releaseAll;
  const gate = new Promise((r) => { releaseAll = r; });
  held.release = () => releaseAll({ sent: 1, recipients: 1 });
  notify.notifyAwaitingApproval = (pool, opts) => {
    approvalCalls.push(opts);
    const p = gate.then((v) => v);
    held.promises.push(p);
    return p;
  };
  return held;
}

const approvalTracks = (spy) => spy.mock.calls.filter((c) => c[1] === 'ticket_approval');

const STATUS_NOTICE = "trackNotice('ticket_approval', () => ticketNotify.notifyAwaitingApproval(pool, {\n"
  + '        ticket: result.ticket,\n        actor,\n';
const DONE_NOTICE = "trackNotice('ticket_approval', () => ticketNotify.notifyAwaitingApproval(pool, {\n"
  + '        ticket: result.ticket,\n        actor: finisher,\n';
const untracked = (anchor) => anchor.replace("trackNotice('ticket_approval', ", "void ((label, start) => start())('ticket_approval', ");

describe('2. the approval notice is tracked, and the answer does not wait for it', () => {
  const doors = [
    {
      name: 'POST /:id/status to Work complete',
      anchor: STATUS_NOTICE,
      go: (router) => move(router, 'st_ip', { status: 'work_complete', override: true }),
      reason: 'office_moved',
      ticketId: 'st_ip',
    },
    {
      name: 'POST /:id/subtasks/:taskId/done on the last building',
      anchor: DONE_NOTICE,
      go: (router) => done(router, 'st_ip', 'k2'),
      reason: 'all_subtasks_done',
      ticketId: 'st_ip',
    },
  ];

  for (const door of doors) {
    test(door.name + ': answers 200 while the notice is still running, and drain() waits for it', async () => {
      const held = holdNotices();
      const track = jest.spyOn(inflight, 'track');
      const r = await door.go(ticketRouter);
      expect(r.statusCode).toBe(200);
      expect(approvalCalls.map((c) => [c.ticket.id, c.reason])).toEqual([[door.ticketId, door.reason]]);

      // Tracked under its label, and it is THE promise the notice returned.
      const tracked = approvalTracks(track);
      expect(tracked).toHaveLength(1);
      expect(tracked[0][0]).toBe(held.promises[0]);
      expect(inflight.size()).toBe(1);

      const drained = inflight.drain(2000);
      let settled = false;
      drained.then(() => { settled = true; });
      await flush();
      expect(settled).toBe(false);
      held.release();
      expect(await drained).toBe(0);
    });

    test('MUTANT: ' + door.name + ' sends without track() and a deploy cuts it off', async () => {
      const mut = routesMutant([[door.anchor, untracked(door.anchor)]]);
      const held = holdNotices();
      const track = jest.spyOn(inflight, 'track');
      const r = await door.go(mut);
      expect(r.statusCode).toBe(200);
      expect(approvalCalls).toHaveLength(1);
      expect(approvalTracks(track)).toHaveLength(0);
      expect(inflight.size()).toBe(0);
      // The drain has nothing to wait for while the notice is still mid-send.
      expect(await inflight.drain(2000)).toBe(0);
      held.release();
    });

    test('MUTANT: ' + door.name + ' tracked under another label is not the ticket_approval the drain log names', async () => {
      const mut = routesMutant([[door.anchor, door.anchor.replace("'ticket_approval'", "'ticket_notice'")]]);
      holdNotices().release();
      const track = jest.spyOn(inflight, 'track');
      expect((await door.go(mut)).statusCode).toBe(200);
      expect(approvalTracks(track)).toHaveLength(0);
    });
  }

  // Every call site, not only the two driven above: a third door added later
  // without trackNotice fails here.
  function untrackedNotices(src) {
    const text = src.replace(/\r\n/g, '\n');
    const problems = [];
    const TRACK = "trackNotice('ticket_approval', () => ticketNotify.";
    let at = text.indexOf('notifyAwaitingApproval(');
    let count = 0;
    while (at >= 0) {
      count++;
      const lineStart = text.lastIndexOf('\n', at) + 1;
      const before = text.slice(lineStart, at).trim();
      if (before !== TRACK) problems.push('untracked: ' + text.slice(lineStart, text.indexOf('\n', at)).trim());
      at = text.indexOf('notifyAwaitingApproval(', at + 1);
    }
    const helper = text.indexOf('function trackNotice(label, start) {');
    if (helper < 0 || text.indexOf('return inflight.track(start(), label);', helper) < 0) {
      problems.push('trackNotice no longer hands the notice to inflight.track');
    }
    return { count, problems };
  }

  test('census: every notifyAwaitingApproval in the office routes goes through trackNotice(\'ticket_approval\')', () => {
    const r = untrackedNotices(fs.readFileSync(TICKET_ROUTES, 'utf8'));
    expect(r.count).toBeGreaterThanOrEqual(2);
    expect(r.problems).toEqual([]);
  });

  test('MUTANT: the census catches a direct call and a trackNotice that stopped tracking', () => {
    const src = fs.readFileSync(TICKET_ROUTES, 'utf8');
    const direct = mutateText(src, [[DONE_NOTICE, DONE_NOTICE.replace("trackNotice('ticket_approval', () => ticketNotify.", 'ticketNotify.')]]);
    expect(untrackedNotices(direct).problems).toHaveLength(1);
    const hollow = mutateText(src, [['    return inflight.track(start(), label);\n', '    return start();\n']]);
    expect(untrackedNotices(hollow).problems).toEqual(['trackNotice no longer hands the notice to inflight.track']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. THE BUILDING DONE DOOR
 * ══════════════════════════════════════════════════════════════════════════*/
const GATE_LINE = '      gate: officeSubtaskGate,\n';
const CODE_LINE = '      if (result.code) refusal.code = result.code;\n';

describe('3. the office building door decides on the locked row', () => {
  test('a closed or cancelled work order: 409 { error, code: work_order_locked }, nothing written', async () => {
    const closed = await done(ticketRouter, 'st_cl', 'k_cl');
    expect([closed.statusCode, closed.body]).toEqual([409, {
      error: 'This work order is closed. Reopen it before changing its punch list.',
      code: 'work_order_locked',
    }]);
    const cancelled = await done(ticketRouter, 'st_ca', 'k_ca');
    expect([cancelled.statusCode, cancelled.body]).toEqual([409, {
      error: 'This work order is cancelled. Reopen it before changing its punch list.',
      code: 'work_order_locked',
    }]);
    expect([task('k_cl').status, task('k_ca').status]).toEqual(['open', 'open']);
    expect([eventKinds('st_cl'), eventKinds('st_ca')]).toEqual([[], []]);
    expect(approvalCalls).toHaveLength(0);
  });

  test('closed between the load and the lock: refused on the locked row, the building stays open, nobody is told', async () => {
    const fired = beforeLock("UPDATE service_tickets SET status = 'closed' WHERE id = 'st_ip'");
    const r = await done(ticketRouter, 'st_ip', 'k2');
    expect(fired()).toBe(true);
    expect([r.statusCode, r.body.code]).toEqual([409, 'work_order_locked']);
    expect(r.body.error).toBe('This work order is closed. Reopen it before changing its punch list.');
    // (The fixture has one connection, so the interleaved close rides inside
    // the refused transaction and its ROLLBACK; Postgres would keep it. What
    // is asserted is what the refusal wrote: nothing.)
    expect(task('k2').status).toBe('open');
    expect(eventKinds('st_ip')).toEqual([]);
    expect(approvalCalls).toHaveLength(0);
  });

  test('no completion photo: 409 { error, code: completion_photo_required }', async () => {
    const r = await done(ticketRouter, 'st_np', 'k_np');
    expect([r.statusCode, r.body]).toEqual([409, {
      error: 'Add a completion photo before marking this complete.',
      code: 'completion_photo_required',
    }]);
    expect(task('k_np').status).toBe('open');
  });

  test('a building that is not on this work order is a plain 404 with no code', async () => {
    const r = await done(ticketRouter, 'st_ip', 'k_cl');
    expect([r.statusCode, r.body]).toEqual([404, { error: 'That subtask is not on this work order.' }]);
  });

  test('access is still asked first: a view grant and another tenant get the ticket 404, nothing written', async () => {
    const viewer = await done(ticketRouter, 'st_ip', 'k2', true, VIEWER);
    const rival = await done(ticketRouter, 'st_ip', 'k2', true, RIVAL);
    for (const r of [viewer, rival]) expect([r.statusCode, r.body]).toEqual([404, { error: 'Service ticket not found' }]);
    expect(task('k2').status).toBe('open');
    expect((await done(ticketRouter, 'st_ip', 'k2', true, CREW)).statusCode).toBe(200);
  });

  test('the last building tells the approvers about the LOCKED row, with its new status', async () => {
    const fired = beforeLock("UPDATE service_tickets SET title = 'Renamed under the lock', assignee_user_id = 20 WHERE id = 'st_ip'");
    const r = await done(ticketRouter, 'st_ip', 'k2');
    expect(fired()).toBe(true);
    expect([r.statusCode, r.body.ok, r.body.ticket_status, r.body.task.status]).toEqual([200, true, 'work_complete', 'done']);
    expect(Object.keys(r.body).sort()).toEqual(['ok', 'task', 'ticket_status']);
    expect(approvalCalls).toHaveLength(1);
    const told = approvalCalls[0];
    expect([told.ticket.id, told.ticket.status, told.ticket.title, told.ticket.assignee_user_id, told.reason])
      .toEqual(['st_ip', 'work_complete', 'Renamed under the lock', 20, 'all_subtasks_done']);
    expect([told.actor.kind, told.actor.userId, told.actor.label]).toEqual(['user', WIDE, 'Paula PM']);
  });

  test('a building that leaves work outstanding tells nobody; reopening on Approved matches the writer rule (no move, no notice)', async () => {
    eng.db.exec("UPDATE tasks SET status = 'open' WHERE id = 'k1'");
    expect((await done(ticketRouter, 'st_ip', 'k2')).body.ticket_status).toBe('in_progress');
    const reopened = await done(ticketRouter, 'st_ap', 'k_ap', false);
    expect([reopened.statusCode, reopened.body.ticket_status, task('k_ap').status]).toEqual([200, 'approved', 'open']);
    expect(approvalCalls).toHaveLength(0);
  });

  test('the office gate agrees with the subtask door\'s ticket-writer rule on every status', async () => {
    const svc = require('../server/services/service-tickets');
    const door = require('../server/services/service-ticket-subtask-door');
    const writer = { id: WIDE, role: 'st_wide', organization_id: 1, name: 'Paula PM' };
    for (const status of svc.TICKET_STATUSES) {
      seed();
      eng.db.exec("UPDATE service_tickets SET status = '" + status + "' WHERE id = 'st_par'");
      const verdict = await door.doneVerdict(eng.pool, { user: writer, orgId: 1, ticket: row('st_par'), task: task('k_par') });
      const r = await done(ticketRouter, 'st_par', 'k_par', false);
      const office = r.statusCode === 200 ? { ok: true } : { ok: false, status: r.statusCode, code: r.body.code };
      const rule = verdict.ok ? { ok: true } : { ok: false, status: verdict.status, code: verdict.code };
      expect({ status, office }).toEqual({ status, office: rule });
    }
  });

  test('MUTANT: pass no gate and a closed work order has its building finished', async () => {
    const mut = routesMutant([[GATE_LINE, '']]);
    const r = await done(mut, 'st_cl', 'k_cl');
    expect(r.statusCode).toBe(200);
    expect(task('k_cl').status).toBe('done');
    expect(eventKinds('st_cl')).toContain('subtask_completed');
  });

  test('MUTANT: gate on the LOADED copy and a close that landed before the lock is written over', async () => {
    const mut = routesMutant([[GATE_LINE, '      gate: () => officeSubtaskGate(ticket),\n']]);
    // The plain closed ticket is still refused — the copy says closed too...
    expect((await done(mut, 'st_cl', 'k_cl')).body.code).toBe('work_order_locked');
    // ...but the race is not.
    beforeLock("UPDATE service_tickets SET status = 'closed' WHERE id = 'st_ip'");
    const r = await done(mut, 'st_ip', 'k2');
    expect(r.statusCode).toBe(200);
    expect(task('k2').status).toBe('done');
  });

  test('MUTANT: answer refusals without their code and the office cannot tell locked from "add a photo"', async () => {
    const mut = routesMutant([[CODE_LINE, '']]);
    expect((await done(mut, 'st_cl', 'k_cl')).body).toEqual({
      error: 'This work order is closed. Reopen it before changing its punch list.',
    });
    expect((await done(mut, 'st_np', 'k_np')).body).toEqual({
      error: 'Add a completion photo before marking this complete.',
    });
  });

  test('MUTANT: notify with the pre-lock copy and the approvers hear about a ticket still "in progress" under its old name', async () => {
    const mut = routesMutant([[DONE_NOTICE, DONE_NOTICE.replace('        ticket: result.ticket,\n', '        ticket,\n')]]);
    beforeLock("UPDATE service_tickets SET title = 'Renamed under the lock', assignee_user_id = 20 WHERE id = 'st_ip'");
    expect((await done(mut, 'st_ip', 'k2')).statusCode).toBe(200);
    expect(approvalCalls).toHaveLength(1);
    expect([approvalCalls[0].ticket.status, approvalCalls[0].ticket.title, approvalCalls[0].ticket.assignee_user_id])
      .toEqual(['in_progress', 'Two buildings', null]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. ONE COPY OF THE ASSIGNEE REFUSAL
 * ══════════════════════════════════════════════════════════════════════════*/
describe('4. the assignee refusal has one copy, in service-ticket-fields.js', () => {
  const SENTENCE = 'Assignee is not a user in this organization';

  function serverFiles(dir) {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) out.push(...serverFiles(p));
      else if (ent.name.endsWith('.js')) out.push(p);
    }
    return out;
  }

  function copiesIn(files) {
    return files
      .filter((f) => f.text.indexOf(SENTENCE) >= 0 || /\bconst\s+ASSIGNEE_REFUSAL\s*=/.test(f.text))
      .map((f) => f.name);
  }

  test('census: only service-ticket-fields.js spells the sentence or declares ASSIGNEE_REFUSAL', () => {
    const files = serverFiles(SERVER_DIR).map((p) => ({ name: path.relative(SERVER_DIR, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') }));
    expect(copiesIn(files)).toEqual(['services/service-ticket-fields.js']);
    expect(require(FIELDS).ASSIGNEE_REFUSAL).toBe(SENTENCE);
  });

  test('MUTANT: a second declaration in the routes is caught by the census', () => {
    const text = mutateText(fs.readFileSync(TICKET_ROUTES, 'utf8'), [[
      "const ASSIGNEE_FIELD = 'assignee_user_id';\n",
      "const ASSIGNEE_FIELD = 'assignee_user_id';\nconst ASSIGNEE_REFUSAL = 'Assignee is not a user in this organization';\n"]]);
    expect(copiesIn([{ name: 'routes/service-ticket-routes.js', text }])).toEqual(['routes/service-ticket-routes.js']);
  });

  test('the office create answers with the shared sentence — change it in fields.js and the route follows', async () => {
    const r = await drive(ticketRouter, 'post', '/', { as: WIDE, body: { title: 'assigned', job_id: 'j1', assignee_user_id: RIVAL } });
    expect([r.statusCode, r.body]).toEqual([400, { error: SENTENCE, field: 'assignee_user_id' }]);

    const fieldsCopy = writeCopy(FIELDS, [[
      "const ASSIGNEE_REFUSAL = 'Assignee is not a user in this organization';",
      "const ASSIGNEE_REFUSAL = 'MUTANT refusal';"]]);
    const assigneesCopy = writeCopy(ASSIGNEES, [], { [require.resolve(FIELDS)]: fieldsCopy });
    const mut = routesMutant([], { [require.resolve(FIELDS)]: fieldsCopy, [require.resolve(ASSIGNEES)]: assigneesCopy });
    const m = await drive(mut, 'post', '/', { as: WIDE, body: { title: 'assigned', job_id: 'j1', assignee_user_id: RIVAL } });
    expect([m.statusCode, m.body]).toEqual([400, { error: 'MUTANT refusal', field: 'assignee_user_id' }]);
    expect(eng.count("SELECT 1 FROM service_tickets WHERE title = 'assigned'")).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. THE BUILDING NOTE DOOR CARRIES THE RETRY KEY (1.30)
 *
 * services/service-ticket-workorder.js addSubtaskNote is the one place that
 * decides what a retry key may look like and whether a note has already been
 * written under it. The door's whole job is to hand the caller's `client_ref`
 * over unread — if it drops it on the floor, a save that landed and lost its
 * answer appends the same sentence to the building twice.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('5. a building note is written once, however often it is sent', () => {
  const REF = 'note_ab12cd34';
  const TEXT = 'Rail post is split at the base';
  const note = (router, body, as) => drive(router, 'post', '/:id/subtasks/:taskId/note',
    { as: as || WIDE, params: { id: 'st_ip', taskId: 'k2' }, body });
  const notes = () => eng.all(
    `SELECT share_id, actor_user_id, detail FROM service_ticket_events
      WHERE ticket_id = 'st_ip' AND organization_id = 1 AND kind = 'subtask_note' ORDER BY rowid`);

  test('the retry that repeats the key answers ok and leaves one line in the field log', async () => {
    expect((await note(ticketRouter, { note: TEXT, client_ref: REF })).body).toEqual({ ok: true });
    expect((await note(ticketRouter, { note: TEXT, client_ref: REF })).body).toEqual({ ok: true });
    const rows = notes();
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toEqual({ task_id: 'k2', note: TEXT, client_ref: REF });
    // The office writes as a person, not through a link.
    expect([rows[0].actor_user_id, rows[0].share_id]).toEqual([WIDE, null]);
  });

  test('a genuinely second note still lands, keyed or not', async () => {
    await note(ticketRouter, { note: TEXT, client_ref: REF });
    await note(ticketRouter, { note: 'And the top rail is loose', client_ref: 'note_zz998877' });
    await note(ticketRouter, { note: 'Third, from an old page with no key' });
    expect(notes().map((e) => e.detail.note)).toEqual([TEXT, 'And the top rail is loose', 'Third, from an old page with no key']);
  });

  test('a caller who may not write this ticket is refused and stores no key', async () => {
    const r = await note(ticketRouter, { note: TEXT, client_ref: REF }, RIVAL);
    expect(r.statusCode).toBe(404);
    expect(notes()).toEqual([]);
  });

  test('MUTANT: drop the key on the way through and the retry is two lines nobody can delete', async () => {
    const mut = routesMutant([['      clientRef: req.body && req.body.client_ref,\n', '']]);
    await note(mut, { note: TEXT, client_ref: REF });
    await note(mut, { note: TEXT, client_ref: REF });
    const rows = notes();
    expect(rows).toHaveLength(2);
    expect(rows[0].detail).toEqual({ task_id: 'k2', note: TEXT });
  });
});
